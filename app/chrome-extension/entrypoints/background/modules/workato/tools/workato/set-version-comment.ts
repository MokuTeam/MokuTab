import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { fetchRecipeVersionsInPage } from './recipe-versions';

interface SetVersionCommentArgs {
  recipe_id: number;
  version: number;
  comment: string;
  tabId?: number;
}

interface SetVersionCommentSuccess {
  ok: true;
  recipe_id: number;
  version: number;
  comment: string;
}

interface SetVersionCommentFailure {
  ok: false;
  failure: {
    stage: 'csrf' | 'comment' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

type SetVersionCommentResult = SetVersionCommentSuccess | SetVersionCommentFailure;

/**
 * Runs in the Workato tab's MAIN world. Keep this function self-contained and
 * Promise-chain based so it can be passed through chrome.scripting.executeScript.
 */
export function setVersionCommentInPage(
  recipeId: number,
  version: number,
  comment: string,
): Promise<SetVersionCommentResult> {
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

  return fetch(`/recipes/${recipeId}/versions/${version}.json`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({ comment }),
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'comment' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `PUT /recipes/${recipeId}/versions/${version}.json returned HTTP ${r.status}`,
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

      const result = (json as any)?.result;
      if (typeof result !== 'number' || !Number.isFinite(result)) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: JSON.stringify(json).slice(0, 1024),
            message: 'Unexpected response shape — missing numeric result.',
          },
        };
      }

      return {
        ok: true,
        recipe_id: recipeId,
        version: result,
        comment,
      };
    }),
  );
}

class WorkatoSetVersionCommentTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.SET_VERSION_COMMENT;

  async execute(args: SetVersionCommentArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }
      if (typeof args.version !== 'number' || !Number.isFinite(args.version)) {
        return createErrorResponse('Param [version] must be a finite number');
      }
      if (typeof args.comment !== 'string') {
        return createErrorResponse('Param [comment] must be a string (empty string clears it)');
      }

      const tab = await findWorkatoTab(args.tabId);

      // Write: no blind auto-retry. On timeout, verify whether the comment
      // actually landed before reporting failure.
      let result: SetVersionCommentResult;
      let succeededAfterTimeout = false;
      try {
        result = await runInWorkatoTab(
          tab.tabId,
          setVersionCommentInPage,
          [args.recipe_id, args.version, args.comment],
          { retryOnTimeout: false },
        );
      } catch (err) {
        const isTimeout =
          err instanceof WorkatoDispatchError &&
          err.code === 'ScriptExecutionFailed' &&
          /timed out/i.test(err.message);
        if (!isTimeout) throw err;
        let verifiedComment: string | null | undefined;
        try {
          const versions = await runInWorkatoTab(
            tab.tabId,
            fetchRecipeVersionsInPage,
            [args.recipe_id, 1],
            { timeoutMs: 15_000 },
          );
          verifiedComment = versions.versions?.find((v) => v.version_no === args.version)?.comment;
        } catch {
          /* verification failed — fall through to original error */
        }
        if (verifiedComment !== undefined && (verifiedComment ?? '') === args.comment) {
          result = {
            ok: true,
            recipe_id: args.recipe_id,
            version: args.version,
            comment: args.comment,
          };
          succeededAfterTimeout = true;
        } else {
          throw err;
        }
      }

      if (!result.ok) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure.stage}): ${result.failure.message}` +
            (result.failure.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      const payload: Record<string, unknown> = {
        recipe_id: result.recipe_id,
        version: result.version,
        comment: result.comment,
      };
      if (succeededAfterTimeout) payload.succeeded_after_timeout = true;
      return {
        content: [
          {
            type: 'text',
            text:
              (result.comment.length > 0
                ? `set comment on recipe ${result.recipe_id} version ${result.version}`
                : `cleared comment on recipe ${result.recipe_id} version ${result.version}`) +
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
        `workato_set_version_comment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoSetVersionCommentTool = new WorkatoSetVersionCommentTool();
