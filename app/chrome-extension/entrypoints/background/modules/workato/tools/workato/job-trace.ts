import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import {
  applyTraceProjection,
  buildErasedTrace,
  buildSlimTrace,
  isErasedJob,
  pickStepFields,
  stripSchemaNoise,
  STEP_FIELDS,
  type RawMetaResponse,
  type RawLineDetailsResponse,
  type TraceProjectionOptions,
} from './slim-trace';

interface JobTraceArgs {
  recipe_id: number;
  job_id: string | number;
  full?: boolean;
  /** Only return steps whose recipe_line_number is in this exact set. */
  lines?: number[];
  /** Only return steps whose recipe_line_number falls in [from, to] inclusive. */
  line_range?: [number, number];
  /**
   * 'summary' (default): truncated input/output summaries.
   * 'full': exact, untruncated (schema-stripped) input/output — requires
   * [lines] or [line_range] selecting at most 20 steps.
   */
  detail?: 'summary' | 'full';
  /** Nested paths to keep inside each step's input/output, e.g. ['body.items[].id']. */
  paths?: string[];
  /** 'keep' (default) or 'drop'. Drop removes undefined/null/''/{}/[] only. */
  empty?: 'keep' | 'drop';
  /** Arrays longer than this are previewed with their total. Default 20, 0 disables. */
  max_items?: number;
  /** Keys to keep on each returned step, e.g. ['adapter_name','output']. */
  fields?: string[];
  /** In-page script timeout. Default 30000, clamped 10000–110000. Raise for huge traces. */
  timeout_ms?: number;
  tabId?: number;
}

interface InPageResult {
  ok: boolean;
  meta?: RawMetaResponse;
  lineDetails?: RawLineDetailsResponse;
  failure?: {
    stage: 'meta' | 'line_details';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * In-page function. See pull-recipe.ts for why this MUST NOT use async/await.
 */
function tracePageFn(recipeId: number, jobId: string | number): Promise<InPageResult> {
  const fetchOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };
  const fetchAndParse = (
    url: string,
  ): Promise<{ status: number; bodyText: string; json: unknown }> =>
    fetch(url, fetchOpts).then((r) =>
      r.text().then((bodyText) => {
        let json: unknown = null;
        try {
          json = JSON.parse(bodyText);
        } catch {
          /* swallow */
        }
        return { status: r.status, bodyText, json };
      }),
    );

  return fetchAndParse(`/web_api/recipes/${recipeId}/jobs/${jobId}`).then((meta) => {
    if (meta.status < 200 || meta.status >= 300) {
      return {
        ok: false,
        failure: {
          stage: 'meta' as const,
          status: meta.status,
          body_excerpt: meta.bodyText.slice(0, 1024),
          message: `GET /web_api/recipes/${recipeId}/jobs/${jobId} returned HTTP ${meta.status}`,
        },
      };
    }

    return fetchAndParse(
      `/web_api/recipes/${recipeId}/jobs/${jobId}/line_details?stringify_big_numbers=true`,
    ).then((trace) => {
      if (trace.status < 200 || trace.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'line_details' as const,
            status: trace.status,
            body_excerpt: trace.bodyText.slice(0, 1024),
            message: `GET /web_api/recipes/${recipeId}/jobs/${jobId}/line_details returned HTTP ${trace.status}`,
          },
        };
      }

      return {
        ok: true,
        meta: meta.json as RawMetaResponse,
        lineDetails: trace.json as RawLineDetailsResponse,
      };
    });
  });
}

class WorkatoJobTraceTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.JOB_TRACE;

  async execute(args: JobTraceArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }
      const jobId = args?.job_id;
      if (
        jobId === undefined ||
        jobId === null ||
        (typeof jobId === 'string' && jobId.trim() === '') ||
        (typeof jobId === 'number' && !Number.isFinite(jobId))
      ) {
        return createErrorResponse('Param [job_id] must be a non-empty string or finite number');
      }
      const full = args.full === true;

      // Line selection: exact set and/or inclusive range.
      const lineSet =
        Array.isArray(args.lines) && args.lines.length > 0
          ? new Set(args.lines.filter((n) => typeof n === 'number' && Number.isFinite(n)))
          : null;
      const range =
        Array.isArray(args.line_range) &&
        args.line_range.length === 2 &&
        typeof args.line_range[0] === 'number' &&
        typeof args.line_range[1] === 'number'
          ? ([args.line_range[0], args.line_range[1]] as [number, number])
          : null;
      const hasSelection = lineSet !== null || range !== null;
      const lineSelected = (n: number): boolean => {
        if (!hasSelection) return true;
        if (lineSet?.has(n)) return true;
        if (range && n >= range[0] && n <= range[1]) return true;
        return false;
      };
      const detail = args.detail === 'full' ? 'full' : 'summary';
      if (detail === 'full' && !hasSelection) {
        return createErrorResponse(
          "detail:'full' requires [lines] or [line_range] — select the specific step(s) you need " +
            '(max 20) to avoid flooding the response with a whole trace of untruncated payloads.',
        );
      }

      // Projection: paths -> empty policy -> array previews. Applied to each
      // step's input/output, never to the raw full:true responses.
      let paths: string[] | null = null;
      if (args.paths !== undefined) {
        if (
          !Array.isArray(args.paths) ||
          args.paths.length === 0 ||
          args.paths.some((p) => typeof p !== 'string' || p.trim() === '')
        ) {
          return createErrorResponse(
            'Param [paths] must be a non-empty array of path strings, e.g. ' +
              "['body.items[].id', 'headers.status'].",
          );
        }
        paths = args.paths.map((p) => p.trim());
      }
      if (args.empty !== undefined && args.empty !== 'keep' && args.empty !== 'drop') {
        return createErrorResponse("Param [empty] must be 'keep' or 'drop'.");
      }
      const maxItems =
        typeof args.max_items === 'number' && Number.isFinite(args.max_items) && args.max_items >= 0
          ? Math.floor(args.max_items)
          : 20;
      let stepFields: string[] | null = null;
      if (args.fields !== undefined) {
        if (!Array.isArray(args.fields) || args.fields.length === 0) {
          return createErrorResponse('Param [fields] must be a non-empty array of step keys.');
        }
        for (const field of args.fields) {
          if (typeof field !== 'string' || !STEP_FIELDS.includes(field)) {
            return createErrorResponse(
              `Unknown step field ${JSON.stringify(field)}. Allowed: ${STEP_FIELDS.join(', ')}.`,
            );
          }
        }
        stepFields = args.fields;
      }
      const projection: TraceProjectionOptions = {
        paths,
        empty: args.empty === 'drop' ? 'drop' : 'keep',
        maxItems,
      };

      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 30_000, 10_000), 110_000);
      const tab = await findWorkatoTab(args.tabId);
      const result = await runInWorkatoTab(tab.tabId, tracePageFn, [args.recipe_id, jobId], {
        timeoutMs,
      });

      if (!result.ok) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
            (result.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      const projectionApplied = {
        ...(paths ? { paths } : {}),
        empty: projection.empty,
        max_items: maxItems,
        ...(stepFields ? { fields: stepFields } : {}),
      };

      // An erased job answers `line_details: []`. Projecting that produces a
      // trace with zero steps, which reads as "the job ran nothing". Say the
      // data is gone instead, and say why. `full:true` stays a raw passthrough
      // (the caller asked for the untouched documents, and `erased` is on the
      // job header there already).
      if (!full && isErasedJob(result.meta ?? {})) {
        const erased = buildErasedTrace(jobId, result.meta ?? {});
        return {
          content: [{ type: 'text', text: JSON.stringify(erased) }],
          isError: false,
        };
      }

      let payload: unknown;
      if (full) {
        payload = { job_id: jobId, meta: result.meta, line_details: result.lineDetails };
      } else if (detail === 'full') {
        const selected = (result.lineDetails?.line_details ?? []).filter((l) =>
          lineSelected(Number(l.recipe_line_number ?? -1)),
        );
        if (selected.length > 20) {
          return createErrorResponse(
            `detail:'full' selection matched ${selected.length} steps — narrow [lines]/[line_range] to at most 20.`,
          );
        }
        const slim = buildSlimTrace(jobId, result.meta!, result.lineDetails!, projection);
        const steps = selected.map((l) => {
          const step: Record<string, unknown> = {
            recipe_line_number: Number(l.recipe_line_number ?? -1),
            adapter_name: String(l.adapter_name ?? ''),
            adapter_operation: String(l.adapter_operation ?? ''),
            input: applyTraceProjection(stripSchemaNoise(l.input), projection),
            output: applyTraceProjection(stripSchemaNoise(l.output), projection),
          };
          return stepFields ? pickStepFields(step, stepFields) : step;
        });
        payload = { ...slim, projection: projectionApplied, steps };
      } else {
        const slim = buildSlimTrace(jobId, result.meta!, result.lineDetails!, projection);
        const steps = (
          hasSelection ? slim.steps.filter((s) => lineSelected(s.recipe_line_number)) : slim.steps
        ).map((step) =>
          stepFields
            ? pickStepFields(step as unknown as Record<string, unknown>, stepFields)
            : step,
        );
        payload = { ...slim, projection: projectionApplied, steps };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_job_trace failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoJobTraceTool = new WorkatoJobTraceTool();
