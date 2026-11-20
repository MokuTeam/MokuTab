import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';

type QueryType = 'soql' | 'suiteql' | 'sql';

interface RunQueryArgs {
  connection_id: number;
  query: string;
  type: QueryType;
  schema_only?: boolean;
  full?: boolean;
  timeout_ms?: number;
  tabId?: number;
}

// How long to wait for Workato's synchronous schema endpoint before aborting.
// Default 90s comfortably covers slow connectors (NetSuite SuiteQL, big scans);
// the max keeps margin below the ~120s bridge/stdio ceilings so the in-page
// abort and dispatch backstop both fire before any outer layer does.
const DEFAULT_QUERY_TIMEOUT_MS = 90_000;
const MIN_QUERY_TIMEOUT_MS = 5_000;
const MAX_QUERY_TIMEOUT_MS = 110_000;
// Gap between the in-page abort deadline and the dispatch-layer race, so the
// in-page abort wins and returns a clean, query-specific timeout message.
const DISPATCH_BUFFER_MS = 5_000;

interface SchemaField {
  name?: string;
  label?: string;
  type?: string;
  control_type?: string;
  [k: string]: unknown;
}

interface RawSchemaResponse {
  result?: {
    schema?: SchemaField[];
    sample?: Array<Record<string, unknown>>;
  };
  error?: string;
}

interface InPageResult {
  ok: boolean;
  raw?: RawSchemaResponse;
  failure?: {
    stage: 'http' | 'connector' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * Runs in the Workato tab's MAIN world. Plain function returning a Promise
 * chain — DO NOT add async/await (see v1 pitfalls reference). All constants
 * the function references must be inside its body to survive Function.prototype
 * .toString() serialisation.
 *
 * `fetchTimeoutMs` arms an AbortController so a slow connector can't leave the
 * request running orphaned in the page: when it fires the fetch is aborted and
 * we resolve with a clean timeout failure. The dispatch-layer race
 * (runInWorkatoTab) is set a few seconds longer and acts only as a backstop.
 */
function runQueryInPage(
  query: string,
  type: string,
  connectionId: number,
  fetchTimeoutMs: number,
): Promise<InPageResult> {
  // Strip trailing LIMIT clause from SOQL only. Workato auto-appends LIMIT 100;
  // a user-supplied LIMIT would collide → "LIMIT N LIMIT 100" → Salesforce 422.
  let finalQuery = query;
  if (type === 'soql') {
    finalQuery = query.replace(/\s+LIMIT\s+\d+\s*$/i, '');
  }

  // CSRF: decode XSRF-TOKEN-V2 cookie value into the x-csrf-token header value.
  const rawCookie =
    document.cookie
      .split('; ')
      .find((c) => c.startsWith('XSRF-TOKEN-V2='))
      ?.split('=')
      .slice(1)
      .join('=') ?? '';
  const csrf = decodeURIComponent(rawCookie);

  const url = '/utils/sample_to_schema.json';
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  const fetchOpts: RequestInit = {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sample: finalQuery,
      type,
      shared_account_id: connectionId,
    }),
    signal: controller.signal,
  };

  return fetch(url, fetchOpts)
    .then((r) =>
      r.text().then((bodyText): InPageResult => {
        if (r.status < 200 || r.status >= 300) {
          return {
            ok: false,
            failure: {
              stage: 'http' as const,
              status: r.status,
              body_excerpt: bodyText.slice(0, 1024),
              message: `POST ${url} returned HTTP ${r.status}`,
            },
          };
        }
        let json: RawSchemaResponse = {};
        try {
          json = JSON.parse(bodyText) as RawSchemaResponse;
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
        if (json.error) {
          return {
            ok: false,
            failure: {
              stage: 'connector' as const,
              body_excerpt: bodyText.slice(0, 1024),
              message: String(json.error),
            },
          };
        }
        if (
          !json.result ||
          !Array.isArray(json.result.schema) ||
          !Array.isArray(json.result.sample)
        ) {
          return {
            ok: false,
            failure: {
              stage: 'shape' as const,
              body_excerpt: bodyText.slice(0, 1024),
              message: 'Unexpected response shape — missing result.schema or result.sample.',
            },
          };
        }
        return { ok: true, raw: json };
      }),
    )
    .catch((err): InPageResult => {
      const aborted =
        controller.signal.aborted || (err && (err as { name?: string }).name === 'AbortError');
      return {
        ok: false,
        failure: {
          stage: 'http' as const,
          message: aborted
            ? `Query timed out after ${Math.round(fetchTimeoutMs / 1000)}s and was aborted. ` +
              'The connector or query is slow — narrow the query (tighter WHERE / fewer columns) ' +
              'or raise timeout_ms.'
            : `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    })
    .then((result): InPageResult => {
      clearTimeout(abortTimer);
      return result;
    });
}

class WorkatoRunQueryTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.RUN_QUERY;

  async execute(args: RunQueryArgs): Promise<ToolResult> {
    try {
      if (typeof args?.connection_id !== 'number' || !Number.isFinite(args.connection_id)) {
        return createErrorResponse('Param [connection_id] must be a finite number');
      }
      if (typeof args?.query !== 'string' || args.query.trim() === '') {
        return createErrorResponse('Param [query] must be a non-empty string');
      }
      if (args?.type !== 'soql' && args?.type !== 'suiteql' && args?.type !== 'sql') {
        return createErrorResponse("Param [type] must be one of 'soql', 'suiteql', 'sql'");
      }
      const schemaOnly = args?.schema_only === true;
      const full = args?.full === true;

      let timeoutMs = DEFAULT_QUERY_TIMEOUT_MS;
      if (args?.timeout_ms !== undefined) {
        if (typeof args.timeout_ms !== 'number' || !Number.isFinite(args.timeout_ms)) {
          return createErrorResponse('Param [timeout_ms] must be a finite number of milliseconds');
        }
        timeoutMs = Math.min(Math.max(args.timeout_ms, MIN_QUERY_TIMEOUT_MS), MAX_QUERY_TIMEOUT_MS);
      }

      const tab = await findWorkatoTab(args.tabId);
      const result = await runInWorkatoTab(
        tab.tabId,
        runQueryInPage,
        [args.query, args.type, args.connection_id, timeoutMs],
        timeoutMs + DISPATCH_BUFFER_MS,
      );

      if (!result.ok) {
        const f = result.failure!;
        let prefix: string;
        if (f.stage === 'http') prefix = 'WorkatoApiError (http)';
        else if (f.stage === 'connector') prefix = 'WorkatoConnectorError';
        else prefix = 'WorkatoApiError (shape)';
        return createErrorResponse(
          `${prefix}: ${f.message}` +
            (f.body_excerpt && f.stage !== 'connector'
              ? `\n--- body excerpt ---\n${f.body_excerpt}`
              : ''),
        );
      }

      const raw = result.raw!.result!;
      const schema = (raw.schema ?? []).map((f) => ({
        name: String(f.name ?? ''),
        label: String(f.label ?? ''),
        type: String(f.type ?? ''),
        control_type: String(f.control_type ?? ''),
      }));
      const rows = raw.sample ?? [];

      const payload = full
        ? raw
        : {
            type: args.type,
            count: rows.length,
            truncated_to_100: rows.length >= 100,
            schema,
            ...(schemaOnly ? {} : { rows }),
          };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_run_query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoRunQueryTool = new WorkatoRunQueryTool();
