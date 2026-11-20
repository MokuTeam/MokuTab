/**
 * workato_api_request — the unsupported escape hatch.
 *
 * Every dedicated Workato tool here wraps one endpoint and adds guards worth
 * having. This one wraps none of them: it issues an arbitrary request against
 * the Workato app host under the user's own session, so an endpoint nobody has
 * written a tool for yet is still reachable. Dirty, but it beats being blocked
 * until the tool exists.
 *
 * The safety that remains:
 *   - same-origin only (a path, never a URL to another host);
 *   - anything other than GET/HEAD needs allow_writes:true;
 *   - the CSRF token is read from the cookie in-page and never echoed back.
 */

import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { assertExpectedContext, type ExpectedTabContext } from './session-context';

interface ApiRequestArgs {
  method?: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  allow_writes?: boolean;
  max_bytes?: number;
  timeout_ms?: number;
  tabId?: number;
  /** Workspace/environment the caller expects this tab to be in (bridge-injected). */
  expected_context?: ExpectedTabContext;
  /**
   * Internal, set by the native-server when out_file is used, and absent from
   * the public inputSchema. Disables the response cap: the body is going to a
   * file, so capping it would silently write a truncated document under a name
   * that reads as complete.
   */
  __uncapped?: boolean;
}

interface InPageResponse {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body_text?: string;
  total_bytes?: number;
  truncated?: boolean;
  failure?: { stage: 'csrf' | 'fetch'; message: string };
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);
const SUPPORTED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_MAX_BYTES = 20_000;

/** Headers worth reporting back; the rest is noise or secret. */
const REPORTED_HEADERS = ['content-type', 'content-length', 'x-request-id'];

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise chains only —
 * no async/await (the bundler rewrites it into a form that does not survive
 * Function.prototype.toString).
 */
function apiRequestInPage(
  method: string,
  url: string,
  headersJson: string,
  bodyText: string | null,
  maxBytes: number,
  needsCsrf: boolean,
  reportedHeaders: string[],
): Promise<InPageResponse> {
  const headers: Record<string, string> = JSON.parse(headersJson);
  if (needsCsrf) {
    const cookie = document.cookie.match(/XSRF-TOKEN-V2=([^;]+)/);
    const token = cookie ? decodeURIComponent(cookie[1]) : '';
    if (!token) {
      return Promise.resolve({
        ok: false,
        failure: {
          stage: 'csrf' as const,
          message:
            'No XSRF-TOKEN-V2 cookie on this tab, so a mutating request would be rejected. ' +
            'There is no csrf meta tag on app.workato.com. Is this tab logged in?',
        },
      });
    }
    headers['x-csrf-token'] = token;
  }
  const init: RequestInit = { method, credentials: 'include', headers };
  if (bodyText !== null) init.body = bodyText;

  return fetch(url, init).then((r) =>
    r.text().then((text) => {
      const picked: Record<string, string> = {};
      for (const name of reportedHeaders) {
        const value = r.headers.get(name);
        if (value !== null) picked[name] = value;
      }
      // maxBytes 0 means no cap: the body is going to a file, not into context.
      const truncated = maxBytes > 0 && text.length > maxBytes;
      return {
        ok: true,
        status: r.status,
        headers: picked,
        body_text: truncated ? text.slice(0, maxBytes) : text,
        total_bytes: text.length,
        truncated,
      };
    }),
  );
}

/**
 * Validate the caller's `path` and turn it into a same-origin URL.
 *
 * Exported for tests: this is the only thing standing between the escape hatch
 * and "send the user's Workato session cookie to an arbitrary host".
 */
export function resolveWorkatoPath(
  path: unknown,
  origin: string,
): { url: string } | { error: string } {
  if (typeof path !== 'string' || path.length === 0) {
    return { error: 'Param [path] must be a non-empty path such as "/web_api/lcap/apps.json"' };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return {
      error:
        `Param [path] must be a path on the Workato host, not a URL (${path.slice(0, 60)}). ` +
        "This tool deliberately cannot reach another host: it runs under the user's Workato " +
        'session cookie.',
    };
  }
  if (path.startsWith('//')) {
    return {
      error:
        'Param [path] starting with "//" is a protocol-relative URL to another host, which this ' +
        'tool refuses. Use a path like "/web_api/...".',
    };
  }
  if (!path.startsWith('/')) {
    return { error: 'Param [path] must start with "/" (e.g. "/web_api/lcap/apps.json")' };
  }
  let resolved: URL;
  try {
    resolved = new URL(path, origin);
  } catch (e) {
    return { error: `Param [path] is not a usable path: ${e instanceof Error ? e.message : e}` };
  }
  if (resolved.origin !== origin) {
    return {
      error: `Param [path] resolves to ${resolved.origin}, which is not this tab's origin ${origin}.`,
    };
  }
  return { url: resolved.toString() };
}

class WorkatoApiRequestTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.API_REQUEST;

  async execute(args: ApiRequestArgs): Promise<ToolResult> {
    try {
      const method = String(args?.method ?? 'GET').toUpperCase();
      if (!SUPPORTED_METHODS.has(method)) {
        return createErrorResponse(
          `Param [method] must be one of ${[...SUPPORTED_METHODS].join(', ')}, got ${method}`,
        );
      }
      if (!READ_ONLY_METHODS.has(method) && args?.allow_writes !== true) {
        return createErrorResponse(
          `${method} is a write. Pass allow_writes:true to confirm — this tool has no ` +
            'endpoint-specific guards, so a bad body here can damage recipes, pages or tables ' +
            'with nothing to catch it.',
        );
      }

      const tab = await findWorkatoTab(args.tabId);
      // Reads are harmless in the wrong workspace (Workato answers 404); a
      // write is not, so only non-GET calls pay for the context check.
      if (!READ_ONLY_METHODS.has(method)) {
        await assertExpectedContext(args, tab.tabId);
      }
      const resolved = resolveWorkatoPath(args?.path, tab.origin);
      if ('error' in resolved) return createErrorResponse(resolved.error);

      let url = resolved.url;
      if (args.query && typeof args.query === 'object') {
        const parsed = new URL(url);
        for (const [key, value] of Object.entries(args.query)) {
          if (value === undefined || value === null) continue;
          parsed.searchParams.set(key, String(value));
        }
        url = parsed.toString();
      }

      // Required headers first, caller's on top — but the caller can never
      // strip x-requested-with, which Workato's /web_api routes demand.
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(args.headers ?? {}),
        'x-requested-with': 'XMLHttpRequest',
      };
      let bodyText: string | null = null;
      if (args.body !== undefined && args.body !== null && method !== 'GET' && method !== 'HEAD') {
        if (typeof args.body === 'string') {
          bodyText = args.body;
        } else {
          bodyText = JSON.stringify(args.body);
          headers['content-type'] = 'application/json';
        }
      }

      // 0 = no cap, and only the out_file path asks for it.
      const maxBytes =
        args.__uncapped === true
          ? 0
          : Math.min(Math.max(args.max_bytes ?? DEFAULT_MAX_BYTES, 512), 200_000);
      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 30_000, 10_000), 110_000);

      const result = await runInWorkatoTab(
        tab.tabId,
        apiRequestInPage,
        [
          method,
          url,
          JSON.stringify(headers),
          bodyText,
          maxBytes,
          !READ_ONLY_METHODS.has(method),
          REPORTED_HEADERS,
        ],
        { timeoutMs, retryOnTimeout: READ_ONLY_METHODS.has(method) },
      );

      if (!result.ok) {
        return createErrorResponse(
          `workato_api_request (${result.failure?.stage}): ${result.failure?.message}`,
        );
      }

      let body: unknown = result.body_text;
      if (!result.truncated && typeof result.body_text === 'string') {
        try {
          body = JSON.parse(result.body_text);
        } catch {
          /* not JSON: hand back the text */
        }
      }

      const payload: Record<string, unknown> = {
        request: { method, path: new URL(url).pathname + new URL(url).search },
        status: result.status,
        headers: result.headers,
        total_bytes: result.total_bytes,
        body,
      };
      if (result.truncated) {
        payload.truncated = true;
        payload.note =
          `Body is ${result.total_bytes} bytes, truncated to ${maxBytes} and left unparsed. ` +
          'Pass out_file:"<path>" to write the whole response to disk, or raise max_bytes.';
      }
      if (result.status === 404 && url.includes('/web_api/')) {
        payload.hint =
          'A 404 on a /web_api/ path usually means this tab is in the wrong workspace or ' +
          'environment, not that the object is missing: Workato resolves both from the tab ' +
          'session. Check with workato_whoami.';
      }
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(
          `${err.message}` +
            (err.code === 'TabNotFound'
              ? ' Note: an omitted `profile` resolves against the default Chrome profile and ' +
                'reports TabNotFound for a tab that exists under another profile. Pass tabId ' +
                'AND profile together.'
              : ''),
        );
      }
      return createErrorResponse(
        `workato_api_request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoApiRequestTool = new WorkatoApiRequestTool();
