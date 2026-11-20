import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { assertExpectedContext, type ExpectedTabContext } from './session-context';
import { invalidateRecipeSnapshot } from './recipe-snapshot';
import { fetchRecipeStatusInPage } from './recipe-status';

/**
 * workato_delete_recipe: permanently delete a recipe.
 *
 * DELETE /recipes/<id>.json -> { result: true }
 * (captured 2026-08-18). There is no undo, so the tool pre-reads the recipe:
 * a missing recipe fails fast with RecipeNotFound, and a running one is
 * refused until it is stopped (workato_stop_recipe).
 */

interface DeleteRecipeInPageResult {
  ok: boolean;
  failure?: {
    stage: 'csrf' | 'write' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based
 * (see pull-recipe.ts for why async/await is forbidden here).
 */
function deleteRecipeInPage(recipeId: number): Promise<DeleteRecipeInPageResult> {
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
  return fetch(`/recipes/${recipeId}.json`, {
    method: 'DELETE',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'write' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `DELETE /recipes/${recipeId}.json returned HTTP ${r.status}`,
          },
        };
      }
      let json: unknown = null;
      try {
        json = JSON.parse(bodyText);
      } catch (e) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: bodyText.slice(0, 1024),
            message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }
      if ((json as any)?.result !== true) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: JSON.stringify(json).slice(0, 1024),
            message: 'Unexpected response shape: expected {result:true}.',
          },
        };
      }
      return { ok: true };
    }),
  );
}

class WorkatoDeleteRecipeTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.DELETE_RECIPE;

  async execute(args: {
    recipe_id: number;
    tabId?: number;
    expected_context?: ExpectedTabContext;
  }): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }
      const tab = await findWorkatoTab(args.tabId);
      await assertExpectedContext(args, tab.tabId);

      // Safety pre-check: fail fast on a missing recipe, refuse a running one.
      const pre = await runInWorkatoTab(tab.tabId, fetchRecipeStatusInPage, [args.recipe_id], {
        timeoutMs: 15_000,
      });
      if (!pre.ok) {
        if (pre.failure?.stage === 'fetch' && pre.failure.status === 404) {
          return createErrorResponse(
            `RecipeNotFound: no recipe with id ${args.recipe_id} (already deleted?). ` +
              'Use workato_search_recipes to find the right id.',
          );
        }
        return createErrorResponse(
          `WorkatoApiError (${pre.failure?.stage}): pre-delete read failed: ${pre.failure?.message}`,
        );
      }
      const recipeName = pre.status?.name ?? '';
      if (pre.status?.running === true) {
        return createErrorResponse(
          `RefusedRunning: recipe ${args.recipe_id} ("${recipeName}") is running. ` +
            'Stop it first with workato_stop_recipe, then delete.',
        );
      }

      let result: DeleteRecipeInPageResult;
      let succeededAfterTimeout = false;
      try {
        result = await runInWorkatoTab(tab.tabId, deleteRecipeInPage, [args.recipe_id], {
          retryOnTimeout: false,
        });
      } catch (err) {
        const isTimeout =
          err instanceof WorkatoDispatchError &&
          err.code === 'ScriptExecutionFailed' &&
          /timed out/i.test(err.message);
        if (!isTimeout) throw err;
        // Write timed out: the recipe now 404ing means the delete landed.
        let gone = false;
        try {
          const check = await runInWorkatoTab(
            tab.tabId,
            fetchRecipeStatusInPage,
            [args.recipe_id],
            {
              timeoutMs: 15_000,
            },
          );
          gone = !check.ok && check.failure?.stage === 'fetch' && check.failure.status === 404;
        } catch {
          /* verification failed: fall through to original error */
        }
        if (!gone) throw err;
        result = { ok: true };
        succeededAfterTimeout = true;
      }

      if (!result.ok) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
            (result.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      // The recipe is gone: nothing cached about it can ever be served again.
      invalidateRecipeSnapshot(args.recipe_id);

      const payload: Record<string, unknown> = {
        recipe_id: args.recipe_id,
        name: recipeName,
        deleted: true,
      };
      if (succeededAfterTimeout) payload.succeeded_after_timeout = true;
      return {
        content: [
          {
            type: 'text',
            text: `deleted recipe ${args.recipe_id} ("${recipeName}")\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_delete_recipe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoDeleteRecipeTool = new WorkatoDeleteRecipeTool();
