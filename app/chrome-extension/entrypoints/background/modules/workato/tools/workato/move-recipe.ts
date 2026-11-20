import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { assertExpectedContext, type ExpectedTabContext } from './session-context';

/**
 * workato_move_recipe — move a recipe into another folder.
 *
 * PUT /recipes/<id>/update_folder.json {folder_id} → { result: true }
 * (captured 2026-07-15; folder ids come from workato_list_folders).
 */

interface MoveRecipeInPageResult {
  ok: boolean;
  failure?: {
    stage: 'csrf' | 'write' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

interface RecipeFolderInPageResult {
  ok: boolean;
  folder_id?: number;
  failure?: { stage: 'fetch' | 'shape'; status?: number; message: string };
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based
 * (see pull-recipe.ts for why async/await is forbidden here).
 */
function moveRecipeInPage(recipeId: number, folderId: number): Promise<MoveRecipeInPageResult> {
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
  return fetch(`/recipes/${recipeId}/update_folder.json`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({ folder_id: folderId }),
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'write' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `PUT /recipes/${recipeId}/update_folder.json returned HTTP ${r.status}`,
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
            message: 'Unexpected response shape — expected {result:true}.',
          },
        };
      }
      return { ok: true };
    }),
  );
}

/** Cheap read of the recipe's current folder_id, used for post-timeout verification. */
function fetchRecipeFolderInPage(recipeId: number): Promise<RecipeFolderInPageResult> {
  return fetch(`/recipes/${recipeId}.json`, {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'fetch' as const,
            status: r.status,
            message: `GET /recipes/${recipeId}.json returned HTTP ${r.status}`,
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
            message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }
      const folderId = (json as any)?.result?.recipe_data?.flow?.folder_id;
      if (typeof folderId !== 'number') {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            message: 'Unexpected response shape — missing flow.folder_id.',
          },
        };
      }
      return { ok: true, folder_id: folderId };
    }),
  );
}

class WorkatoMoveRecipeTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.MOVE_RECIPE;

  async execute(args: {
    recipe_id: number;
    folder_id: number;
    tabId?: number;
    expected_context?: ExpectedTabContext;
  }): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }
      if (typeof args.folder_id !== 'number' || !Number.isFinite(args.folder_id)) {
        return createErrorResponse(
          'Param [folder_id] must be a finite number (a folder id from workato_list_folders)',
        );
      }
      const tab = await findWorkatoTab(args.tabId);
      await assertExpectedContext(args, tab.tabId);

      let result: MoveRecipeInPageResult;
      let succeededAfterTimeout = false;
      try {
        result = await runInWorkatoTab(
          tab.tabId,
          moveRecipeInPage,
          [args.recipe_id, args.folder_id],
          { retryOnTimeout: false },
        );
      } catch (err) {
        const isTimeout =
          err instanceof WorkatoDispatchError &&
          err.code === 'ScriptExecutionFailed' &&
          /timed out/i.test(err.message);
        if (!isTimeout) throw err;
        // Write timed out — verify whether the move actually landed.
        let landed = false;
        try {
          const check = await runInWorkatoTab(
            tab.tabId,
            fetchRecipeFolderInPage,
            [args.recipe_id],
            { timeoutMs: 15_000 },
          );
          landed = check.ok && check.folder_id === args.folder_id;
        } catch {
          /* verification failed — fall through to original error */
        }
        if (!landed) throw err;
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

      const payload: Record<string, unknown> = {
        recipe_id: args.recipe_id,
        folder_id: args.folder_id,
        moved: true,
      };
      if (succeededAfterTimeout) payload.succeeded_after_timeout = true;
      return {
        content: [
          {
            type: 'text',
            text: `moved recipe ${args.recipe_id} to folder ${args.folder_id}\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_move_recipe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoMoveRecipeTool = new WorkatoMoveRecipeTool();
