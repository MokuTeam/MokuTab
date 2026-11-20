import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';

interface RepeatJobArgs {
  recipe_id: number;
  /** Master job ids, e.g. ['j-Aaxc9bm4-egoMDh-CD']. */
  job_ids: string[];
  tabId?: number;
}

interface RepeatJobSuccess {
  ok: true;
  /** Per-job repeat outcome as reported by Workato. */
  results: Record<string, boolean>;
}

interface RepeatJobFailure {
  ok: false;
  failure: {
    stage: 'csrf' | 'repeat' | 'shape' | 'workato';
    status?: number;
    body_excerpt?: string;
    message: string;
    details?: unknown;
  };
}

type RepeatJobResult = RepeatJobSuccess | RepeatJobFailure;

/**
 * Runs in the Workato tab's MAIN world. Keep this function self-contained and
 * Promise-chain based so it can be passed through chrome.scripting.executeScript.
 */
export function repeatJobsInPage(recipeId: number, jobIds: string[]): Promise<RepeatJobResult> {
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

  return fetch(`/web_api/recipes/${recipeId}/repeat_jobs.json`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({ id: recipeId, master_job_ids: jobIds, error_format: 'json' }),
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
            message: `Workato returned an error while trying to repeat jobs on recipe ${recipeId}`,
            details: workatoError.details ?? workatoError,
          },
        };
      }

      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'repeat' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `POST /web_api/recipes/${recipeId}/repeat_jobs.json returned HTTP ${r.status}`,
          },
        };
      }

      // Expected shape: { result: { "<job_id>": { result: true } } }
      const perJob = (json as any)?.result;
      if (perJob === null || typeof perJob !== 'object') {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: JSON.stringify(json).slice(0, 1024),
            message: 'Unexpected response shape - missing result object.',
          },
        };
      }

      const results: Record<string, boolean> = {};
      for (const jobId of jobIds) {
        results[jobId] = (perJob as any)[jobId]?.result === true;
      }
      return { ok: true, results };
    }),
  );
}

class WorkatoRepeatJobTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.REPEAT_JOB;

  async execute(args: RepeatJobArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }
      if (
        !Array.isArray(args?.job_ids) ||
        args.job_ids.length === 0 ||
        args.job_ids.some((id) => typeof id !== 'string' || id.trim() === '')
      ) {
        return createErrorResponse('Param [job_ids] must be a non-empty array of job id strings');
      }
      if (args.job_ids.length > 50) {
        return createErrorResponse(
          `Param [job_ids] has ${args.job_ids.length} entries — max 50 per call`,
        );
      }
      const jobIds = args.job_ids.map((id) => id.trim());

      const tab = await findWorkatoTab(args.tabId);

      // Write: must not auto-retry — a blind retry could double-run jobs.
      const result = await runInWorkatoTab(tab.tabId, repeatJobsInPage, [args.recipe_id, jobIds], {
        retryOnTimeout: false,
      });

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
            '\n(retriable: false — check job state with workato_list_jobs before retrying)',
        );
      }

      const repeated = jobIds.filter((id) => result.results[id]);
      const rejected = jobIds.filter((id) => !result.results[id]);
      const payload = {
        recipe_id: args.recipe_id,
        repeated,
        rejected,
        all_ok: rejected.length === 0,
      };
      return {
        content: [
          {
            type: 'text',
            text:
              `repeat jobs on recipe ${args.recipe_id}: ${repeated.length}/${jobIds.length} accepted` +
              (rejected.length > 0 ? ` (rejected: ${rejected.join(', ')})` : '') +
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
        `workato_repeat_job failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoRepeatJobTool = new WorkatoRepeatJobTool();
