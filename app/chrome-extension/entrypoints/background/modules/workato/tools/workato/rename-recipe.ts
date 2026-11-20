import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { assertExpectedContext, type ExpectedTabContext } from './session-context';
import { invalidateRecipeSnapshot } from './recipe-snapshot';

interface RenameRecipeArgs {
  recipe_id: number;
  name: string;
  tabId?: number;
  /** Workspace/environment the caller expects this tab to be in (bridge-injected). */
  expected_context?: ExpectedTabContext;
}

interface RenameRecipeSuccess {
  ok: true;
  recipe_id: number;
  name: string;
  version_no?: number;
  updated_at?: string;
  code_errors: unknown[];
  job_report_config_errors: unknown[];
  requirements_errors: unknown[];
  folders: unknown[];
}

interface RenameRecipeFailure {
  ok: false;
  failure: {
    stage: 'csrf' | 'rename' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

type RenameRecipeResult = RenameRecipeSuccess | RenameRecipeFailure;

function createClientUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Runs in the Workato tab's MAIN world. Keep this function self-contained and
 * Promise-chain based so it can be passed through chrome.scripting.executeScript.
 */
export function renameRecipeInPage(
  recipeId: number,
  name: string,
  clientUuid: string,
): Promise<RenameRecipeResult> {
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

  const body = {
    flow: { name },
    client_uuid: clientUuid,
    error_format: 'json',
  };

  return fetch(`/recipes/${recipeId}.json`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify(body),
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'rename' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `PUT /recipes/${recipeId}.json returned HTTP ${r.status}`,
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
      const flow = result?.flow;
      if (!flow || typeof flow.name !== 'string') {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: JSON.stringify(json).slice(0, 1024),
            message: 'Unexpected response shape — missing result.flow.name.',
          },
        };
      }

      return {
        ok: true,
        recipe_id: recipeId,
        name: flow.name,
        version_no:
          typeof flow.version_no === 'number' && Number.isFinite(flow.version_no)
            ? flow.version_no
            : undefined,
        updated_at: typeof flow.updated_at === 'string' ? flow.updated_at : undefined,
        code_errors: Array.isArray(flow.code_errors) ? flow.code_errors : [],
        job_report_config_errors: Array.isArray(flow.job_report_config_errors)
          ? flow.job_report_config_errors
          : [],
        requirements_errors: Array.isArray(flow.requirements_errors)
          ? flow.requirements_errors
          : [],
        folders: Array.isArray(result?.folders) ? result.folders : [],
      };
    }),
  );
}

class WorkatoRenameRecipeTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.RENAME_RECIPE;

  async execute(args: RenameRecipeArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }
      if (typeof args.name !== 'string' || args.name.trim().length === 0) {
        return createErrorResponse('Param [name] must be a non-empty string');
      }

      const tab = await findWorkatoTab(args.tabId);
      await assertExpectedContext(args, tab.tabId);
      const result = await runInWorkatoTab(tab.tabId, renameRecipeInPage, [
        args.recipe_id,
        args.name,
        createClientUuid(),
      ]);

      if (!result.ok) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure.stage}): ${result.failure.message}` +
            (result.failure.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      // A rename writes a new recipe version, so the cached code is stale.
      invalidateRecipeSnapshot(result.recipe_id);

      const errCount =
        result.code_errors.length +
        result.job_report_config_errors.length +
        result.requirements_errors.length;
      const payload = {
        recipe_id: result.recipe_id,
        name: result.name,
        version_no: result.version_no,
        updated_at: result.updated_at,
        folders: result.folders,
        code_errors: result.code_errors,
        job_report_config_errors: result.job_report_config_errors,
        requirements_errors: result.requirements_errors,
      };
      return {
        content: [
          {
            type: 'text',
            text:
              `renamed recipe ${result.recipe_id} to "${result.name}"` +
              (result.version_no ? ` (version ${result.version_no}` : '') +
              (result.version_no && errCount > 0
                ? `, ${errCount} validation error${errCount === 1 ? '' : 's'}`
                : '') +
              (result.version_no ? ')' : '') +
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
        `workato_rename_recipe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoRenameRecipeTool = new WorkatoRenameRecipeTool();
