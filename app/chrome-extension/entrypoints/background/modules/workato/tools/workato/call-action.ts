import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';

interface CallActionArgs {
  connection_id: number;
  action_name: string;
  input: Record<string, unknown>;
  allow_writes?: boolean;
  full?: boolean;
  tabId?: number;
}

interface RawActionResponse {
  result?: unknown;
  error?: string;
  [k: string]: unknown;
}

interface InPageResult {
  ok: boolean;
  raw?: RawActionResponse;
  failure?: {
    stage: 'http' | 'connector' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

const READ_PREFIXES = [
  'search_',
  'get_',
  'list_',
  'query_',
  'find_',
  'describe_',
  'read_',
  'fetch_',
];
const READ_ONLY_HTTP_VERBS = new Set(['get', 'head', 'options']);

/**
 * Read actions whose name does not start with a read prefix.
 *
 * `run_suiteql` is the one that bites: it is a SELECT-only query action on the
 * NetSuite connectors, but "run_" reads as a write, so every schema probe had
 * to pass allow_writes:true — which trains the reflex of setting that flag on
 * calls nobody has checked.
 */
const READ_ONLY_EXACT_NAMES = new Set(['execute_suiteql', 'run_suiteql', 'run_query']);

/**
 * Safety gate. Runs in the background, NOT in-page, so module-scope constants
 * are fine here. Returns true when the action looks read-only and is allowed
 * by default; false when it looks like a write and needs allow_writes=true.
 */
export function isReadAction(actionName: string, input: Record<string, unknown>): boolean {
  const lower = actionName.toLowerCase();
  if (READ_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (READ_ONLY_EXACT_NAMES.has(lower)) return true;
  if (lower === '__adhoc_http_action') {
    const verb = String(input?.verb ?? input?.method ?? '').toLowerCase();
    return READ_ONLY_HTTP_VERBS.has(verb);
  }
  return false;
}

/**
 * Runs in the Workato tab's MAIN world. Plain function, .then() chains only,
 * all constants inline. CSRF read from document.cookie inside the function.
 */
function callActionInPage(
  connectionId: number,
  actionName: string,
  input: Record<string, unknown>,
): Promise<InPageResult> {
  const rawCookie =
    document.cookie
      .split('; ')
      .find((c) => c.startsWith('XSRF-TOKEN-V2='))
      ?.split('=')
      .slice(1)
      .join('=') ?? '';
  const csrf = decodeURIComponent(rawCookie);

  const url = `/connections/${connectionId}/test_action.json`;
  const fetchOpts: RequestInit = {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
    },
    body: JSON.stringify({ name: actionName, input }),
  };

  return fetch(url, fetchOpts).then((r) =>
    r.text().then((bodyText) => {
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
      let json: RawActionResponse = {};
      try {
        json = JSON.parse(bodyText) as RawActionResponse;
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
      return { ok: true, raw: json };
    }),
  );
}

class WorkatoCallActionTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.CALL_ACTION;

  async execute(args: CallActionArgs): Promise<ToolResult> {
    try {
      if (typeof args?.connection_id !== 'number' || !Number.isFinite(args.connection_id)) {
        return createErrorResponse('Param [connection_id] must be a finite number');
      }
      if (typeof args?.action_name !== 'string' || args.action_name.trim() === '') {
        return createErrorResponse('Param [action_name] must be a non-empty string');
      }
      if (args?.input === null || typeof args?.input !== 'object' || Array.isArray(args.input)) {
        return createErrorResponse('Param [input] must be a non-null object');
      }
      const allowWrites = args?.allow_writes === true;
      const full = args?.full === true;

      // Safety gate — runs BEFORE any HTTP traffic so we never accidentally
      // invoke a write action that the caller didn't explicitly opt into.
      const readOnly = isReadAction(args.action_name, args.input);
      if (!readOnly && !allowWrites) {
        return createErrorResponse(
          `WorkatoUnsafeAction: action_name='${args.action_name}' looks like a write ` +
            '(not in the read-only allowlist: search_*, get_*, list_*, query_*, find_*, ' +
            'describe_*, read_*, fetch_*, execute_suiteql, run_suiteql, run_query, or ' +
            '__adhoc_http_action with verb in {get,head,options}). Pass allow_writes:true ' +
            'to proceed.',
        );
      }

      const tab = await findWorkatoTab(args.tabId);
      // An action that is not classified read-only can have side effects in the
      // target system, so a timed-out dispatch must NOT be retried: the first
      // attempt may well have landed, and a blind retry double-applies it.
      const result = await runInWorkatoTab(
        tab.tabId,
        callActionInPage,
        [args.connection_id, args.action_name, args.input],
        { retryOnTimeout: readOnly },
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

      const raw = result.raw!;
      const payload = full ? raw : { action_name: args.action_name, result: raw.result };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_call_action failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoCallActionTool = new WorkatoCallActionTool();
