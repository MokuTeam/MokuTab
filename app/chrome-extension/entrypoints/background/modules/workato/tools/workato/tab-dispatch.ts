/**
 * Find a Workato tab and dispatch a self-contained function in its MAIN-world
 * context so the page's session cookies travel with any fetch the function
 * makes.
 *
 * Selection algorithm (from spec §6):
 *   1. Query tabs matching *.workato.com or *.workato.is.
 *   2. Keep only session-bearing hosts (first label must be `app`); this
 *      excludes docs.workato.com, www.workato.com, support.workato.com, etc.
 *   3. If zero matches  -> TabNotFound.
 *   4. If matches span >1 distinct host -> MultipleWorkatoHosts.
 *   5. Otherwise pick tabs[0].
 *
 * A call that names no tab never picks a tab an agent leased (leased-tabs.ts):
 * those are left out before steps 3 to 5, and when nothing else is open the
 * answer is TabLeased, not somebody's tab.
 */

import { isLeasedTab } from '../../../../leased-tabs';

export const WORKATO_URL_PATTERNS = ['*://*.workato.com/*', '*://*.workato.is/*'];

/**
 * True for hosts that serve the logged-in Workato app (recipe editor / API).
 * Allows app.workato.com, app.workato.is, and regional variants like
 * app.eu.workato.com / app.jp.workato.com. Excludes docs / www / support /
 * community / status / careers subdomains, none of which carry the session
 * cookie and which would otherwise trip the MultipleWorkatoHosts guard.
 */
export function isWorkatoAppHost(host: string): boolean {
  if (!host.startsWith('app.')) return false;
  return host.endsWith('.workato.com') || host.endsWith('.workato.is');
}

const EXECUTE_SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Error thrown by tab-dispatch operations.
 *
 * Codes thrown by this module:
 *   - 'TabNotFound' — no Workato tab open, or no scriptable tab matched.
 *   - 'MultipleWorkatoHosts' — tabs span >1 distinct Workato host.
 *   - 'ScriptExecutionFailed' — chrome.scripting.executeScript rejected, timed
 *     out, returned no frames, or returned a null/undefined result.
 *
 * Codes reserved for callers (Tasks 6/7, e.g. pull-recipe.ts, job-trace.ts):
 *   - 'UnexpectedShape' — in-page script returned a value whose JSON shape
 *     does not match what the tool expected. Throw from the tool layer after
 *     inspecting the in-page result. Not thrown by this module.
 *   - 'ContextMismatch': the tab is a valid Workato app tab, but its session
 *     resolves to a different workspace/environment than the call expects.
 *     Thrown by assertTabContext (session-context.ts). Not thrown here.
 */
export class WorkatoDispatchError extends Error {
  constructor(
    public code:
      | 'TabNotFound'
      | 'TabLeased'
      | 'ProjectNotFound'
      | 'MultipleWorkatoHosts'
      | 'ScriptExecutionFailed'
      | 'UnexpectedShape'
      | 'ContextMismatch',
    message: string,
    public details?: Record<string, unknown>,
  ) {
    // The code leads the message, so it survives every `X failed: ${err.message}`
    // on the way out and reaches the caller as error.code.
    super(`${code}: ${message}`);
    this.name = 'WorkatoDispatchError';
  }
}

/**
 * Extra text for a Workato 404.
 *
 * Workato resolves the active workspace and environment from the tab's own
 * session, so a perfectly real recipe or page returns 404 when the request is
 * issued from a tab pointed at a different workspace — the same response a
 * deleted object gives. Reading that as "it does not exist" sends the caller
 * hunting for a missing object instead of switching tabs.
 */
export function workatoNotFoundHint(status: number | undefined): string {
  if (status !== 404) return '';
  return (
    ' A 404 from Workato does NOT prove the object is gone: the workspace and environment ' +
    "come from this tab's session, so an id belonging to another workspace/environment is " +
    'simply invisible here. Confirm with workato_whoami, and pin the call to a tab in the ' +
    'right workspace (tabId + profile) before concluding it was deleted.'
  );
}

export interface WorkatoTabInfo {
  tabId: number;
  host: string;
  origin: string;
}

type ScriptableTab = chrome.tabs.Tab & { id: number; url: string };

function isScriptableTab(tab: chrome.tabs.Tab): tab is ScriptableTab {
  return typeof tab.id === 'number' && typeof tab.url === 'string';
}

function toWorkatoTabInfo(tab: ScriptableTab): WorkatoTabInfo {
  const url = new URL(tab.url);
  return { tabId: tab.id, host: url.host, origin: url.origin };
}

/** Extra ways of narrowing the search when no explicit `tabId` is given. */
export interface FindWorkatoTabOptions {
  /**
   * Restrict discovery to one Chrome window. Used by callers that were handed
   * a windowId instead of a tabId: without it a two-window session picks the
   * first Workato tab Chrome reports, which may be the wrong workspace.
   *
   * An explicit `tabId` always wins. When a windowId is given and that window
   * holds no logged-in Workato app tab, this THROWS rather than falling back
   * to another window: silently retargeting is the drift this whole guard
   * exists to prevent.
   */
  windowId?: number;
}

export async function findWorkatoTab(
  tabId?: number,
  options: FindWorkatoTabOptions = {},
): Promise<WorkatoTabInfo> {
  if (typeof tabId === 'number') {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (err) {
      throw new WorkatoDispatchError(
        'TabNotFound',
        `Workato tab ${tabId} was not found or is no longer accessible: ${
          err instanceof Error ? err.message : String(err)
        }. Tab ids are per Chrome PROFILE: a tab that exists in another profile ` +
          `reports exactly this. If the tab is open in front of you, pass the profile it ` +
          `belongs to (profile:"<name>"); chrome_list_profiles shows what is connected.`,
        { tabId },
      );
    }

    if (!isScriptableTab(tab)) {
      throw new WorkatoDispatchError(
        'TabNotFound',
        `Tab ${tabId} does not have an id and url Chrome will let us script into.`,
        { tabId },
      );
    }

    const url = new URL(tab.url);
    if (!isWorkatoAppHost(url.host)) {
      throw new WorkatoDispatchError(
        'TabNotFound',
        `Tab ${tabId} is not a logged-in Workato app tab (host=${url.host}).`,
        { tabId, host: url.host },
      );
    }

    return toWorkatoTabInfo(tab);
  }

  if (typeof options.windowId === 'number') {
    const windowTabs = await chrome.tabs.query({
      windowId: options.windowId,
      url: WORKATO_URL_PATTERNS,
    });
    const match = windowTabs
      .filter(isScriptableTab)
      .find((t) => isWorkatoAppHost(new URL(t.url).host) && !isLeasedTab(t.id));
    if (!match) {
      throw new WorkatoDispatchError(
        'TabNotFound',
        `No logged-in Workato app tab in window ${options.windowId}. Open https://app.workato.com there, ` +
          'or pass tabId.',
        { windowId: options.windowId },
      );
    }
    // Re-resolve through the tabId branch so the same validation runs.
    return findWorkatoTab(match.id);
  }

  const tabs = await chrome.tabs.query({ url: WORKATO_URL_PATTERNS });

  if (tabs.length === 0) {
    throw new WorkatoDispatchError(
      'TabNotFound',
      'No Workato tab open in this Chrome profile. Open https://app.workato.com (or your ' +
        'region) and sign in before calling this tool. If Workato IS open, it is probably ' +
        'in a different profile than the one this call routed to — check ' +
        'chrome_list_profiles and pass profile:"<name>".',
    );
  }

  const usable = tabs.filter(isScriptableTab);

  if (usable.length === 0) {
    throw new WorkatoDispatchError(
      'TabNotFound',
      'Found Workato tabs but none have an id and url Chrome will let us script into.',
    );
  }

  const allAppTabs = usable.filter((t) => isWorkatoAppHost(new URL(t.url).host));
  const appTabs = allAppTabs.filter((t) => !isLeasedTab(t.id));

  if (allAppTabs.length > 0 && appTabs.length === 0) {
    throw new WorkatoDispatchError(
      'TabLeased',
      'Every Workato tab in this Chrome profile is leased by an agent, and this call names no ' +
        'tab. Take a tab of your own with chrome_lease_tab (url: the Workato app), or open ' +
        'Workato in another tab.',
    );
  }

  if (appTabs.length === 0) {
    const seenHosts = [...new Set(usable.map((t) => new URL(t.url).host))];
    throw new WorkatoDispatchError(
      'TabNotFound',
      `Found Workato tabs (${seenHosts.join(', ')}) but none on the logged-in app ` +
        '(app.workato.com or regional equivalent). Sign in at https://app.workato.com ' +
        'in this browser before calling this tool.',
      { seenHosts },
    );
  }

  const distinctHosts = new Set(appTabs.map((t) => new URL(t.url).host));
  if (distinctHosts.size > 1) {
    throw new WorkatoDispatchError(
      'MultipleWorkatoHosts',
      `Multiple Workato hosts open at once (${[...distinctHosts].join(', ')}). ` +
        'Close all but one before calling this tool.',
      { hosts: [...distinctHosts] },
    );
  }

  const tab = appTabs[0];
  return toWorkatoTabInfo(tab);
}

/** Options for runInWorkatoTab / runInWorkatoTabDetailed. */
export interface RunInTabOptions {
  /** In-page script timeout. Default EXECUTE_SCRIPT_TIMEOUT_MS (30s). */
  timeoutMs?: number;
  /**
   * Retry the script ONCE when the first attempt times out. Default true —
   * safe for read-only page functions (the observed failure mode is the 30s
   * window expiring while the underlying fetch still succeeds, so a retry
   * with identical args returns normally). Writes MUST pass false and do
   * their own post-timeout state verification instead, otherwise a retry can
   * double-apply (e.g. bump a recipe version twice).
   */
  retryOnTimeout?: boolean;
}

export interface DetailedRunResult<TResult> {
  value: TResult;
  /** True when the first attempt timed out and the automatic retry succeeded. */
  retried: boolean;
}

function isDispatchTimeout(err: unknown): boolean {
  return (
    err instanceof WorkatoDispatchError &&
    err.code === 'ScriptExecutionFailed' &&
    /timed out/i.test(err.message)
  );
}

/**
 * Run `func(...args)` in the MAIN world of the given tab and return its result.
 * `func` must be self-contained (no captured closures) because Chrome serializes
 * it to a string before executing.
 *
 * The 4th param accepts either a number (timeoutMs, legacy signature) or a
 * RunInTabOptions object. `timeoutMs` bounds how long we wait for the in-page
 * script. It defaults to EXECUTE_SCRIPT_TIMEOUT_MS (30s), which suits the fast
 * tools. Slow callers (e.g. run-query against a sluggish connector) may pass a
 * larger value, but MUST stay below the bridge/stdio ceilings (~120s) so this
 * inner timeout still fires first and returns a clean error instead of an
 * opaque outer one.
 *
 * On timeout the call is retried once automatically (unless
 * retryOnTimeout:false). Use runInWorkatoTabDetailed when the caller wants to
 * surface `retried: true` in its response payload.
 */
export async function runInWorkatoTab<TArgs extends unknown[], TResult>(
  tabId: number,
  func: (...args: TArgs) => Promise<TResult> | TResult,
  args: TArgs,
  options: number | RunInTabOptions = {},
): Promise<TResult> {
  const detailed = await runInWorkatoTabDetailed(tabId, func, args, options);
  return detailed.value;
}

export async function runInWorkatoTabDetailed<TArgs extends unknown[], TResult>(
  tabId: number,
  func: (...args: TArgs) => Promise<TResult> | TResult,
  args: TArgs,
  options: number | RunInTabOptions = {},
): Promise<DetailedRunResult<TResult>> {
  const opts: RunInTabOptions = typeof options === 'number' ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? EXECUTE_SCRIPT_TIMEOUT_MS;
  // Long-timeout callers (run-query at up to ~110s) must not auto-retry: a
  // second attempt would blow through the ~120s bridge ceiling and surface an
  // opaque outer timeout instead of this module's clean error.
  const retryOnTimeout = opts.retryOnTimeout ?? timeoutMs <= 45_000;

  try {
    const value = await runInWorkatoTabOnce(tabId, func, args, timeoutMs);
    return { value, retried: false };
  } catch (err) {
    if (!retryOnTimeout || !isDispatchTimeout(err)) {
      if (isDispatchTimeout(err) && err instanceof WorkatoDispatchError) {
        err.message += ' (retriable: verify state before retrying — this call may have writes)';
      }
      throw err;
    }
    try {
      const value = await runInWorkatoTabOnce(tabId, func, args, timeoutMs);
      return { value, retried: true };
    } catch (retryErr) {
      if (isDispatchTimeout(retryErr) && retryErr instanceof WorkatoDispatchError) {
        retryErr.message +=
          ' (auto-retried once, timed out both times; retriable: true — the page may be slow or ' +
          'the Workato API degraded. If this tool accepts timeout_ms, retry with a larger value, ' +
          'up to 110000)';
      }
      throw retryErr;
    }
  }
}

async function runInWorkatoTabOnce<TArgs extends unknown[], TResult>(
  tabId: number,
  func: (...args: TArgs) => Promise<TResult> | TResult,
  args: TArgs,
  timeoutMs: number,
): Promise<TResult> {
  const execPromise = chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: func as (...a: unknown[]) => unknown,
    args: args as unknown[],
  });

  // Track the timer so it can be cleared once the race settles. Without this a
  // long timeout (run-query uses up to ~115s) would keep the MV3 service worker
  // awake for the full duration even after the script returned successfully.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new WorkatoDispatchError(
            'ScriptExecutionFailed',
            `In-page script timed out after ${Math.round(timeoutMs / 1000)}s.`,
          ),
        ),
      timeoutMs,
    );
  });

  let results;
  try {
    results = await Promise.race([execPromise, timeoutPromise]);
  } catch (err) {
    if (err instanceof WorkatoDispatchError) throw err;
    throw new WorkatoDispatchError(
      'ScriptExecutionFailed',
      `chrome.scripting.executeScript failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  if (!results || results.length === 0) {
    throw new WorkatoDispatchError(
      'ScriptExecutionFailed',
      'chrome.scripting.executeScript returned no result frames.',
    );
  }

  const first = results[0];
  if (first.result == null) {
    throw new WorkatoDispatchError(
      'ScriptExecutionFailed',
      'In-page script returned no value (null/undefined). The function likely threw before returning.',
    );
  }

  return first.result as TResult;
}
