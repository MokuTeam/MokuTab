import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { assertExpectedContext, type ExpectedTabContext } from './session-context';
import { invalidateRecipeSnapshot } from './recipe-snapshot';

/**
 * workato_copy_recipe: clone a recipe into a folder.
 *
 * POST /recipes/<id>/copy.json {folder_id} -> { result: <new recipe id> }
 * (captured 2026-08-18; folder ids come from workato_list_folders).
 *
 * A copy is a create, so a timed-out request is never blind-retried. Instead
 * the tool snapshots the destination folder's recipe ids before the write and,
 * on timeout, re-reads them: exactly one new id means the copy landed and that
 * id is the new recipe.
 */

interface CopyRecipeInPageResult {
  ok: boolean;
  new_recipe_id?: number;
  failure?: {
    stage: 'csrf' | 'write' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

interface FolderRecipeIdsInPageResult {
  ok: boolean;
  ids?: number[];
  failure?: { stage: 'fetch' | 'shape'; status?: number; message: string };
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based
 * (see pull-recipe.ts for why async/await is forbidden here).
 */
function copyRecipeInPage(recipeId: number, folderId: number): Promise<CopyRecipeInPageResult> {
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
  return fetch(`/recipes/${recipeId}/copy.json`, {
    method: 'POST',
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
            message: `POST /recipes/${recipeId}/copy.json returned HTTP ${r.status}`,
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
      const newId = (json as any)?.result;
      if (typeof newId !== 'number' || !isFinite(newId)) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: JSON.stringify(json).slice(0, 1024),
            message: 'Unexpected response shape: expected {result:<new recipe id>}.',
          },
        };
      }
      return { ok: true, new_recipe_id: newId };
    }),
  );
}

/**
 * Cheap read of the recipe ids currently listed in a folder (page 1, newest
 * first), used as the before/after snapshot for post-timeout verification.
 */
function listFolderRecipeIdsInPage(folderId: number): Promise<FolderRecipeIdsInPageResult> {
  const url = `/web_api/mixed_assets.json?asset_type=recipe&sort_term=created_at&page=1&folder_id=${folderId}`;
  return fetch(url, {
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
            message: `GET ${url} returned HTTP ${r.status}`,
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
      const items = (json as any)?.result?.items;
      if (!Array.isArray(items)) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            message: 'Unexpected response shape: missing result.items array.',
          },
        };
      }
      const ids: number[] = [];
      for (const item of items) {
        const id = (item as any)?.id;
        if (typeof id === 'number' && isFinite(id)) ids.push(id);
      }
      return { ok: true, ids };
    }),
  );
}

class WorkatoCopyRecipeTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.COPY_RECIPE;

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

      // Snapshot the destination folder's recipe ids so a timed-out copy can
      // be verified instead of blind-retried (a retry would clone twice).
      let baselineIds: Set<number> | null = null;
      try {
        const before = await runInWorkatoTab(
          tab.tabId,
          listFolderRecipeIdsInPage,
          [args.folder_id],
          {
            timeoutMs: 15_000,
          },
        );
        if (before.ok && before.ids) baselineIds = new Set(before.ids);
      } catch {
        /* snapshot is best-effort; without it a timeout stays a timeout */
      }

      let result: CopyRecipeInPageResult;
      let succeededAfterTimeout = false;
      try {
        result = await runInWorkatoTab(
          tab.tabId,
          copyRecipeInPage,
          [args.recipe_id, args.folder_id],
          {
            retryOnTimeout: false,
          },
        );
      } catch (err) {
        const isTimeout =
          err instanceof WorkatoDispatchError &&
          err.code === 'ScriptExecutionFailed' &&
          /timed out/i.test(err.message);
        if (!isTimeout || baselineIds === null) throw err;
        // Write timed out: check whether exactly one new recipe appeared in
        // the destination folder. Anything else is ambiguous, so re-throw.
        let newIds: number[] = [];
        try {
          const after = await runInWorkatoTab(
            tab.tabId,
            listFolderRecipeIdsInPage,
            [args.folder_id],
            {
              timeoutMs: 15_000,
            },
          );
          if (after.ok && after.ids) {
            newIds = after.ids.filter((id) => !baselineIds!.has(id) && id !== args.recipe_id);
          }
        } catch {
          /* verification failed: fall through to original error */
        }
        if (newIds.length !== 1) throw err;
        result = { ok: true, new_recipe_id: newIds[0] };
        succeededAfterTimeout = true;
      }

      if (!result.ok || typeof result.new_recipe_id !== 'number') {
        return createErrorResponse(
          `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
            (result.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      // Harmless today (a brand new id cannot be cached), but a recycled id
      // from a previous session would otherwise serve another recipe's code.
      invalidateRecipeSnapshot(result.new_recipe_id);

      const payload: Record<string, unknown> = {
        recipe_id: args.recipe_id,
        new_recipe_id: result.new_recipe_id,
        folder_id: args.folder_id,
        copied: true,
      };
      if (succeededAfterTimeout) payload.succeeded_after_timeout = true;
      return {
        content: [
          {
            type: 'text',
            text: `copied recipe ${args.recipe_id} -> new recipe ${result.new_recipe_id} in folder ${args.folder_id}\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_copy_recipe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoCopyRecipeTool = new WorkatoCopyRecipeTool();
