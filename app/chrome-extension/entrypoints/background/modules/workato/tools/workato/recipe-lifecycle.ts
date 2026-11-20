import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { assertExpectedContext, type ExpectedTabContext } from './session-context';
import { fetchRecipeStatus, type RecipeStatusSlim } from './recipe-status';
import {
  describeStartError,
  fetchRecipeActivationState,
  mentionsAccountId,
  normalizeStartError,
  type RecipeStartError,
} from './recipe-state';
import {
  fetchRecipeConnections,
  summarizeRecipeConnections,
  type RecipeConnectionsSummary,
} from './recipe-connections';

type RecipeLifecycleAction = 'start' | 'stop';

/**
 * How far the call actually got.
 *
 * - `state_reached`: the recipe reports the state that was asked for.
 * - `accepted`: Workato took the request (start/stop only ever enqueue) and the
 *   end state is NOT verified — either wait was not requested, or the wait
 *   window expired with no recorded activation error.
 * - `failed`: Workato refused to activate the recipe; `start_error` says why.
 *
 * An accepted request is not a restarted recipe. Callers that restore state
 * (workato_recipe_save_with_dependents) must read this field, not isError alone.
 */
export type RecipeLifecycleOutcome = 'state_reached' | 'accepted' | 'failed';

interface RecipeLifecycleArgs {
  recipe_id: number;
  force?: boolean;
  /** Poll recipe status until it actually flips (start→running / stop→not running). */
  wait?: boolean;
  /** Max time to poll when wait:true. Default 20000, clamped 1000–60000. */
  wait_timeout_ms?: number;
  tabId?: number;
  /** Workspace/environment the caller expects this tab to be in (bridge-injected). */
  expected_context?: ExpectedTabContext;
}

interface RecipeLifecycleSuccess {
  ok: true;
  recipe_id: number;
  action: RecipeLifecycleAction;
  status: string;
}

interface RecipeLifecycleFailure {
  ok: false;
  failure: {
    stage: 'csrf' | 'lifecycle' | 'shape' | 'workato';
    status?: number;
    body_excerpt?: string;
    message: string;
    details?: unknown;
  };
}

type RecipeLifecycleResult = RecipeLifecycleSuccess | RecipeLifecycleFailure;

/**
 * Runs in the Workato tab's MAIN world. Keep this function self-contained and
 * Promise-chain based so it can be passed through chrome.scripting.executeScript.
 */
export function changeRecipeLifecycleInPage(
  recipeId: number,
  action: RecipeLifecycleAction,
  force: boolean,
): Promise<RecipeLifecycleResult> {
  function readCookie(n: string): string | null {
    const escaped = n.replace(/[-.+*]/g, '\\$&');
    const m = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  let csrf = readCookie('XSRF-TOKEN-V2') || readCookie('XSRF-TOKEN') || readCookie('csrf-token');
  if (!csrf) {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    csrf = csrfMeta && csrfMeta.getAttribute('content');
  }
  if (!csrf) {
    return Promise.resolve({
      ok: false,
      failure: {
        stage: 'csrf',
        message:
          'could not find CSRF token in XSRF-TOKEN-V2 cookie or meta tag; ensure the active tab is a logged-in Workato page',
      },
    });
  }

  const body = action === 'stop' && force ? { force: true } : {};

  return fetch(`/web_api/recipes/${recipeId}/${action}.json`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify(body),
  }).then((r) =>
    r.text().then((bodyText) => {
      let json: unknown = null;
      try {
        json = bodyText.length > 0 ? JSON.parse(bodyText) : {};
      } catch (e) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }

      const workatoError = (json as any)?.error;
      if (workatoError) {
        return {
          ok: false,
          failure: {
            stage: 'workato' as const,
            message: `Workato returned an error while trying to ${action} recipe ${recipeId}`,
            details: workatoError.details ?? workatoError,
          },
        };
      }

      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'lifecycle' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `POST /web_api/recipes/${recipeId}/${action}.json returned HTTP ${r.status}`,
          },
        };
      }

      const status = (json as any)?.status;
      if (typeof status !== 'string') {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: JSON.stringify(json).slice(0, 1024),
            message: 'Unexpected response shape - missing status string.',
          },
        };
      }

      return {
        ok: true,
        recipe_id: recipeId,
        action,
        status,
      };
    }),
  );
}

/** Does the observed status satisfy the desired lifecycle end-state? */
function statusMatchesAction(status: RecipeStatusSlim, action: RecipeLifecycleAction): boolean {
  return action === 'start' ? status.running === true : status.running === false;
}

function isDispatchTimeout(err: unknown): err is WorkatoDispatchError {
  return (
    err instanceof WorkatoDispatchError &&
    err.code === 'ScriptExecutionFailed' &&
    /timed out/i.test(err.message)
  );
}

abstract class WorkatoRecipeLifecycleTool extends BaseBrowserToolExecutor {
  protected abstract readonly action: RecipeLifecycleAction;

  async execute(args: RecipeLifecycleArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }

      const force = this.action === 'stop' && args.force === true;
      const tab = await findWorkatoTab(args.tabId);
      // Starting or stopping the wrong workspace's recipe is a production
      // incident, so verify the tab's workspace before the POST.
      await assertExpectedContext(args, tab.tabId);

      // Writes must not auto-retry (a blind retry can double-apply); instead,
      // on timeout we verify the actual recipe state before reporting failure.
      let enqueueStatus: string;
      let succeededAfterTimeout = false;
      try {
        const result = await runInWorkatoTab(
          tab.tabId,
          changeRecipeLifecycleInPage,
          [args.recipe_id, this.action, force],
          { retryOnTimeout: false },
        );

        if (!result.ok) {
          const details =
            result.failure.details !== undefined
              ? `\n--- details ---\n${JSON.stringify(result.failure.details)}`
              : '';
          return createErrorResponse(
            `WorkatoApiError (${result.failure.stage}): ${result.failure.message}` +
              (result.failure.body_excerpt
                ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
                : '') +
              details +
              '\n(retriable: false — inspect the failure before retrying)',
          );
        }
        enqueueStatus = result.status;
      } catch (err) {
        if (!isDispatchTimeout(err)) throw err;
        // Timeout ≠ failure: the POST may have landed. Verify actual state.
        let verified: RecipeStatusSlim | null = null;
        try {
          verified = await fetchRecipeStatus(tab.tabId, args.recipe_id);
        } catch {
          /* verification itself failed — fall through to the original error */
        }
        if (verified && statusMatchesAction(verified, this.action)) {
          enqueueStatus = 'succeeded_after_timeout';
          succeededAfterTimeout = true;
        } else if (verified) {
          return createErrorResponse(
            `${this.name}: request timed out and verification shows the recipe is still ` +
              `${verified.running ? 'running' : 'not running'} (state=${verified.state}). ` +
              'The action may still be enqueued — re-check with workato_recipe_status before retrying. (retriable: true)',
          );
        } else {
          throw err;
        }
      }

      // wait:true — poll until the state actually flips (start/stop only enqueue).
      let finalState: RecipeStatusSlim | undefined;
      let waitedMs: number | undefined;
      if (args.wait === true) {
        const timeoutMs = Math.min(Math.max(args.wait_timeout_ms ?? 20_000, 1_000), 60_000);
        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs;
        for (;;) {
          try {
            finalState = await fetchRecipeStatus(tab.tabId, args.recipe_id);
            if (statusMatchesAction(finalState, this.action)) break;
          } catch {
            /* transient status fetch failure — keep polling */
          }
          if (Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        waitedMs = Date.now() - startedAt;
      }

      const flipped = finalState ? statusMatchesAction(finalState, this.action) : undefined;

      // A start that did not flip is where Workato hides the reason: the POST
      // answers 202 regardless, and /recipes/<id>.json records nothing. Only
      // /web_api/recipes/<id>/state.json carries the activation error.
      let outcome: RecipeLifecycleOutcome = flipped === true ? 'state_reached' : 'accepted';
      let startError: RecipeStartError | null = null;
      let diagnosisError: string | undefined;
      let connections: RecipeConnectionsSummary | undefined;

      if (flipped === false && this.action === 'start') {
        try {
          startError = normalizeStartError(
            await fetchRecipeActivationState(tab.tabId, args.recipe_id),
          );
        } catch (err) {
          diagnosisError = err instanceof Error ? err.message : String(err);
        }
        if (startError) {
          outcome = 'failed';
          if (mentionsAccountId(startError)) {
            try {
              connections = summarizeRecipeConnections(
                await fetchRecipeConnections(tab.tabId, args.recipe_id),
              );
            } catch (err) {
              diagnosisError = err instanceof Error ? err.message : String(err);
            }
          }
        }
      }

      const payload: Record<string, unknown> = {
        recipe_id: args.recipe_id,
        action: this.action,
        status: enqueueStatus,
        force,
        outcome,
      };
      if (succeededAfterTimeout) payload.succeeded_after_timeout = true;
      if (finalState) {
        payload.state = finalState.state;
        payload.running = finalState.running;
        payload.waited_ms = waitedMs;
        payload.state_flipped = flipped;
      }
      if (startError) payload.start_error = startError;
      if (connections) payload.connections = connections;
      if (diagnosisError !== undefined) payload.diagnosis_error = diagnosisError;

      if (outcome === 'failed' && startError) {
        return createErrorResponse(
          `${this.action} recipe ${args.recipe_id} FAILED: Workato refused to activate it ` +
            `(state=${startError.state}). ${describeStartError(startError)}` +
            (connections && connections.actions.length > 0
              ? `\n${connections.actions.join('\n')}`
              : '') +
            '\n(retriable: false, fix the reported error before starting again)' +
            `\n${JSON.stringify(payload)}`,
        );
      }

      const notVerified =
        flipped === false
          ? ', did NOT flip within wait window; outcome=accepted, the end state is NOT verified' +
            (diagnosisError !== undefined
              ? ` (the activation-state read failed: ${diagnosisError})`
              : this.action === 'start'
                ? ' (Workato recorded no activation error, so the start may still be in progress)'
                : '')
          : '';

      return {
        content: [
          {
            type: 'text',
            text:
              `${this.action} recipe ${args.recipe_id}: ${enqueueStatus}` +
              (finalState
                ? ` (state=${finalState.state}, running=${finalState.running}${notVerified})`
                : ' (outcome=accepted, state not verified: pass wait:true to poll)') +
              `\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `${this.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

class WorkatoStartRecipeTool extends WorkatoRecipeLifecycleTool {
  name = TOOL_NAMES.WORKATO.START_RECIPE;
  protected readonly action = 'start';
}

class WorkatoStopRecipeTool extends WorkatoRecipeLifecycleTool {
  name = TOOL_NAMES.WORKATO.STOP_RECIPE;
  protected readonly action = 'stop';
}

export const workatoStartRecipeTool = new WorkatoStartRecipeTool();
export const workatoStopRecipeTool = new WorkatoStopRecipeTool();
