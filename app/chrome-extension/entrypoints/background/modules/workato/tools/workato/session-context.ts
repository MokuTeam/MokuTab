/**
 * Session context for a Workato tab: which host, workspace and environment the
 * tab's own session resolves to.
 *
 * Workato takes the workspace and environment from the tab's cookies, so the
 * same recipe id means different things in two tabs. Every write therefore
 * needs a cheap way to answer "is this still the workspace the caller pinned?"
 * without paying for workato_whoami (a full auth_user payload behind a CDP
 * debugger attach).
 *
 * This module provides:
 *   - fetchSessionContextInPage: the in-page GET of /web_api/auth_user.json,
 *     slimmed to the five fields routing cares about.
 *   - getTabContext: a per-tab cache (default 60s) over that read, invalidated
 *     when the tab navigates, when it closes, and on any read error.
 *   - assertTabContext / assertExpectedContext: the guard write tools call.
 *   - workato_session_context: the tool form, for agents and for the bridge.
 */

import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';

/** Default lifetime of a cached tab context. */
export const SESSION_CONTEXT_TTL_MS = 60_000;

const SESSION_CONTEXT_TIMEOUT_MS = 15_000;

export interface SessionContextInPageSuccess {
  ok: true;
  host: string;
  workspace_id: number | null;
  workspace_name: string | null;
  environment: string | null;
  user_id: number | null;
}

export interface SessionContextInPageFailure {
  ok: false;
  failure: {
    stage: 'http' | 'auth' | 'shape' | 'exception';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

export type SessionContextInPageResult = SessionContextInPageSuccess | SessionContextInPageFailure;

/**
 * Runs in the Workato tab's MAIN world. Keep this function self-contained and
 * Promise-chain based so it can be passed through chrome.scripting.executeScript.
 */
export function fetchSessionContextInPage(): Promise<SessionContextInPageResult> {
  function asNumber(value: unknown): number | null {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  function asText(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /**
   * Workato has returned current_environment as a bare id, as a name, and as an
   * object; normalize all three to one string so it can be compared.
   */
  function asEnvironment(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.length > 0 ? value : null;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const picked = obj.name !== undefined && obj.name !== null ? obj.name : obj.id;
      const fallback = picked !== undefined && picked !== null ? picked : obj.type;
      if (typeof fallback === 'string') return fallback.length > 0 ? fallback : null;
      if (typeof fallback === 'number') return String(fallback);
    }
    return null;
  }

  return fetch('/web_api/auth_user.json', {
    method: 'GET',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
    },
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false as const,
          failure: {
            stage: 'http' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 512),
            message: `GET /web_api/auth_user.json returned HTTP ${r.status}`,
          },
        };
      }

      let json: unknown = null;
      try {
        json = JSON.parse(bodyText);
      } catch (e) {
        return {
          ok: false as const,
          failure: {
            stage: 'shape' as const,
            body_excerpt: bodyText.slice(0, 512),
            message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }

      const result = (json as { result?: Record<string, unknown> } | null)?.result;
      if (!result || result.authenticated === false) {
        return {
          ok: false as const,
          failure: {
            stage: 'auth' as const,
            message: 'not authenticated to Workato in this tab',
          },
        };
      }

      const team = (result.current_team ?? null) as Record<string, unknown> | null;
      return {
        ok: true as const,
        host: location.host,
        workspace_id: team ? asNumber(team.id) : null,
        workspace_name: team ? asText(team.name) : null,
        environment: asEnvironment(result.current_environment),
        user_id: asNumber(result.logged_user_id),
      };
    }),
  );
}

/** The session context of one Chrome tab, as cached by the service worker. */
export interface WorkatoSessionContext {
  tab_id: number;
  host: string;
  workspace_id: number | null;
  workspace_name: string | null;
  environment: string | null;
  user_id: number | null;
  /** Epoch ms of the auth_user read this context came from. */
  fetched_at: number;
}

/** What a caller expects the target tab to be. Only present fields are checked. */
export interface ExpectedTabContext {
  host?: string;
  workspace_id?: number;
  environment?: string;
}

export interface GetTabContextOptions {
  /** Reuse a cached context younger than this. Default SESSION_CONTEXT_TTL_MS. */
  maxAgeMs?: number;
  /** Ignore the cache and read the tab again. */
  force?: boolean;
}

const contextCache = new Map<number, WorkatoSessionContext>();

/** Drop one tab's cached context, or the whole cache when no tab is given. */
export function invalidateTabContext(tabId?: number): void {
  if (typeof tabId === 'number') contextCache.delete(tabId);
  else contextCache.clear();
}

/** Cached context without touching the tab. Undefined when nothing is cached. */
export function peekTabContext(tabId: number): WorkatoSessionContext | undefined {
  return contextCache.get(tabId);
}

let invalidationInstalled = false;

/**
 * A navigation can move a tab to another workspace, which is exactly the drift
 * the cache must not hide, so any URL change drops that tab's entry.
 * Idempotent, and installed lazily so the module can be imported in a worker
 * (or a test) that has no chrome.tabs yet.
 */
export function installSessionContextInvalidation(): void {
  if (invalidationInstalled) return;
  const tabs = (globalThis as { chrome?: typeof chrome }).chrome?.tabs as
    | typeof chrome.tabs
    | undefined;
  if (!tabs?.onUpdated?.addListener) return;
  tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo && typeof changeInfo.url === 'string') invalidateTabContext(tabId);
  });
  tabs.onRemoved?.addListener?.((tabId) => invalidateTabContext(tabId));
  invalidationInstalled = true;
}

/** Test seam: forget that the chrome.tabs listeners were installed. */
export function resetSessionContextInvalidationForTests(): void {
  invalidationInstalled = false;
}

/**
 * The tab's session context, from cache when it is younger than maxAgeMs and
 * from the tab otherwise. Throws WorkatoDispatchError when the tab cannot be
 * read; the cached entry is dropped on every failure so a broken tab is never
 * remembered as good.
 */
export async function getTabContext(
  tabId: number,
  options: GetTabContextOptions = {},
): Promise<WorkatoSessionContext> {
  installSessionContextInvalidation();
  const maxAgeMs = typeof options.maxAgeMs === 'number' ? options.maxAgeMs : SESSION_CONTEXT_TTL_MS;
  const cached = contextCache.get(tabId);
  if (!options.force && cached && Date.now() - cached.fetched_at <= maxAgeMs) {
    return cached;
  }

  let result: SessionContextInPageResult;
  try {
    result = await runInWorkatoTab(tabId, fetchSessionContextInPage, [], {
      timeoutMs: SESSION_CONTEXT_TIMEOUT_MS,
    });
  } catch (err) {
    invalidateTabContext(tabId);
    throw err;
  }

  if (!result.ok) {
    invalidateTabContext(tabId);
    throw new WorkatoDispatchError(
      'UnexpectedShape',
      `Could not read the Workato session context of tab ${tabId} (${result.failure.stage}): ` +
        result.failure.message,
      { tabId, failure: result.failure },
    );
  }

  const context: WorkatoSessionContext = {
    tab_id: tabId,
    host: result.host,
    workspace_id: result.workspace_id,
    workspace_name: result.workspace_name,
    environment: result.environment,
    user_id: result.user_id,
    fetched_at: Date.now(),
  };
  contextCache.set(tabId, context);
  return context;
}

function describeExpected(expected: ExpectedTabContext): string {
  const parts: string[] = [];
  if (expected.host) parts.push(`host=${expected.host}`);
  if (expected.workspace_id !== undefined && expected.workspace_id !== null) {
    parts.push(`workspace_id=${expected.workspace_id}`);
  }
  if (expected.environment !== undefined && expected.environment !== null) {
    parts.push(`environment=${expected.environment}`);
  }
  return parts.length > 0 ? parts.join(', ') : '(nothing)';
}

/**
 * Refuse to act on a tab that is not the context the caller expects. Only the
 * fields present in `expected` are compared, and the error names both sides so
 * the caller can see which one to fix.
 */
export async function assertTabContext(
  tabId: number,
  expected: ExpectedTabContext,
  options: GetTabContextOptions = {},
): Promise<WorkatoSessionContext> {
  const actual = await getTabContext(tabId, options);
  const diffs: string[] = [];
  if (expected.host && expected.host !== actual.host) {
    diffs.push(`host expected ${expected.host}, actual ${actual.host}`);
  }
  if (
    expected.workspace_id !== undefined &&
    expected.workspace_id !== null &&
    Number(expected.workspace_id) !== Number(actual.workspace_id)
  ) {
    diffs.push(
      `workspace_id expected ${expected.workspace_id}, actual ${actual.workspace_id ?? 'unknown'}` +
        (actual.workspace_name ? ` ("${actual.workspace_name}")` : ''),
    );
  }
  if (
    expected.environment !== undefined &&
    expected.environment !== null &&
    String(expected.environment) !== String(actual.environment)
  ) {
    diffs.push(
      `environment expected ${expected.environment}, actual ${actual.environment ?? 'unknown'}`,
    );
  }
  if (diffs.length > 0) {
    throw new WorkatoDispatchError(
      'ContextMismatch',
      `Tab ${tabId} is not the Workato context this call expects (${describeExpected(expected)}): ` +
        `${diffs.join('; ')}. Nothing was changed. Pin the right tab with ` +
        'chrome_switch_profile(profile, tabId), or pass allow_context_mismatch:true if the ' +
        'other workspace really is the target.',
      { tabId, expected, actual },
    );
  }
  return actual;
}

/**
 * One-line guard for write handlers: validate args.expected_context when the
 * caller (normally the bridge, from the pinned session or a recipe file's
 * origin) supplied one, and do nothing otherwise.
 */
export async function assertExpectedContext(
  args: { expected_context?: ExpectedTabContext } | undefined,
  tabId: number,
): Promise<void> {
  const expected = args?.expected_context;
  if (!expected || typeof expected !== 'object') return;
  const hasField =
    (typeof expected.host === 'string' && expected.host.length > 0) ||
    (expected.workspace_id !== undefined && expected.workspace_id !== null) ||
    (expected.environment !== undefined && expected.environment !== null);
  if (!hasField) return;
  await assertTabContext(tabId, expected);
}

// ---------------------------------------------------------------------------
// Context block appended to Workato tool responses
// ---------------------------------------------------------------------------

/** Byte ceiling for the extra context block, before the bridge adds profile. */
const CONTEXT_BLOCK_MAX_BYTES = 200;

/** workato_* tools whose result is the context already. */
const CONTEXT_BLOCK_EXCLUDED_TOOLS = new Set<string>([TOOL_NAMES.WORKATO_SESSION.SESSION_CONTEXT]);

function byteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  return text.length;
}

/**
 * `{"context":{...}}`: one compact line naming the tab the call actually ran
 * in. Trimmed field by field until it fits the byte ceiling, so a long
 * workspace name can never turn a response into a payload.
 */
export function buildContextBlockText(context: WorkatoSessionContext): string {
  const full: Record<string, unknown> = {
    tab_id: context.tab_id,
    host: context.host,
    workspace_id: context.workspace_id,
    workspace_name: context.workspace_name,
    environment: context.environment,
  };
  let text = JSON.stringify({ context: full });
  if (byteLength(text) <= CONTEXT_BLOCK_MAX_BYTES) return text;
  delete full.workspace_name;
  text = JSON.stringify({ context: full });
  if (byteLength(text) <= CONTEXT_BLOCK_MAX_BYTES) return text;
  delete full.environment;
  return JSON.stringify({ context: full });
}

/**
 * Append the actual-context block to a successful workato_* result.
 *
 * Never fails a call: any problem resolving the tab or its context returns the
 * result untouched. Skipped when the call targeted a windowId, because the tab
 * it resolved to inside the tool is not knowable from here.
 */
export async function maybeAppendContextBlock(
  name: string,
  args: { tabId?: number; windowId?: number } | undefined,
  result: ToolResult,
): Promise<ToolResult> {
  try {
    if (!name.startsWith('workato_')) return result;
    if (CONTEXT_BLOCK_EXCLUDED_TOOLS.has(name)) return result;
    if (!result || result.isError || !Array.isArray(result.content)) return result;

    let tabId: number;
    if (typeof args?.tabId === 'number') {
      tabId = args.tabId;
    } else if (typeof args?.windowId === 'number') {
      return result;
    } else {
      tabId = (await findWorkatoTab()).tabId;
    }

    const context = await getTabContext(tabId);
    return {
      ...result,
      content: [...result.content, { type: 'text', text: buildContextBlockText(context) }],
    };
  } catch {
    return result;
  }
}

// ---------------------------------------------------------------------------
// workato_session_context
// ---------------------------------------------------------------------------

interface SessionContextArgs {
  tabId?: number;
  windowId?: number;
  max_age_ms?: number;
  refresh?: boolean;
}

class WorkatoSessionContextTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO_SESSION.SESSION_CONTEXT;

  async execute(args: SessionContextArgs): Promise<ToolResult> {
    try {
      const tab = await findWorkatoTab(args?.tabId);
      const maxAgeMs = Math.min(Math.max(args?.max_age_ms ?? SESSION_CONTEXT_TTL_MS, 0), 600_000);
      const cachedBefore = peekTabContext(tab.tabId);
      const context = await getTabContext(tab.tabId, {
        maxAgeMs,
        force: args?.refresh === true,
      });
      const payload = {
        tab_id: context.tab_id,
        host: context.host,
        workspace_id: context.workspace_id,
        workspace_name: context.workspace_name,
        environment: context.environment,
        user_id: context.user_id,
        age_ms: Math.max(0, Date.now() - context.fetched_at),
        from_cache: cachedBefore === context,
      };
      return {
        content: [
          {
            type: 'text',
            text:
              `tab ${context.tab_id} (${context.host}) is in workspace ` +
              `${context.workspace_id ?? '?'} "${context.workspace_name ?? '?'}"` +
              (context.environment ? `, environment ${context.environment}` : '') +
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
        `workato_session_context failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoSessionContextTool = new WorkatoSessionContextTool();
