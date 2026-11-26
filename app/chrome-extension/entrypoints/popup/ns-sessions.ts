/**
 * NetSuite session store message contract and formatting helpers for the popup.
 *
 * Author: Roman Chikalenko
 * Version: 1.0.0
 */

export const NETSUITE_MODULE_ID = 'netsuite';

export const NS_SESSION_MESSAGES = {
  LIST: 'ns_sessions_list',
  OPEN: 'ns_session_open',
} as const;

export type NsSessionMessageType = (typeof NS_SESSION_MESSAGES)[keyof typeof NS_SESSION_MESSAGES];

export const NS_SESSIONS_TIMEOUT_MS = 3000;
export const NS_SESSIONS_REFRESH_MS = 30_000;
export const NS_SESSION_OPEN_TIMEOUT_MS = 15_000;

export type NsSessionState = 'live' | 'dying';

export interface NsSessionWhere {
  machine: string;
  profile: string;
}

export interface NsSessionEntry {
  account: string;
  user: string;
  role: string;
  state: NsSessionState;
  abs_expiry: number | null;
  idle_expiry: number | null;
  last_activity: number | null;
  last_where: NsSessionWhere | null;
}

export interface NsSessionsListRequest {
  type: typeof NS_SESSION_MESSAGES.LIST;
}

export type NsSessionsListResponse =
  | { ok: true; entries: NsSessionEntry[] }
  | { ok: false; error: string };

export interface NsSessionOpenRequest {
  type: typeof NS_SESSION_MESSAGES.OPEN;
  account: string;
}

export type NsSessionOpenResponse = { ok: true; tabId: number } | { ok: false; error: string };

export type NsSessionsFetchResult =
  | { status: 'ready'; entries: NsSessionEntry[] }
  | { status: 'unreachable'; entries: [] };

export type NsSessionOpenResult = { ok: true; tabId: number } | { ok: false; error: string };

export type RuntimeSender = (message: unknown) => Promise<unknown>;

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Minimum of absolute and idle expiry timestamps (epoch ms), or null if neither is set. */
export function effectiveExpiry(
  entry: Pick<NsSessionEntry, 'abs_expiry' | 'idle_expiry'>,
): number | null {
  const abs = finiteOrNull(entry.abs_expiry);
  const idle = finiteOrNull(entry.idle_expiry);
  if (abs !== null && idle !== null) return Math.min(abs, idle);
  return abs ?? idle;
}

/** Whether the session has already reached its effective expiry timestamp. */
export function isSessionExpired(
  entry: Pick<NsSessionEntry, 'abs_expiry' | 'idle_expiry'>,
  nowMs = Date.now(),
): boolean {
  const expiry = effectiveExpiry(entry);
  return expiry !== null && expiry <= nowMs;
}

/** Split an account ID like "1234567_SB2" into base ID and sandbox suffix. */
export function splitAccountId(account: string): { base: string; suffix: string | null } {
  const idx = account.indexOf('_');
  if (idx <= 0 || idx === account.length - 1) {
    return { base: account, suffix: null };
  }
  return {
    base: account.slice(0, idx),
    suffix: account.slice(idx + 1),
  };
}

/** Format remaining time until effective expiry, e.g. "2 h 10 min". */
export function formatTimeLeft(
  entry: Pick<NsSessionEntry, 'abs_expiry' | 'idle_expiry'>,
  nowMs = Date.now(),
): string {
  const expiry = effectiveExpiry(entry);
  if (expiry === null) return '';
  const diffMs = expiry - nowMs;
  if (diffMs <= 0) return '< 1 min';
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 1) return '< 1 min';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours} h ${minutes} min`;
  if (hours > 0) return `${hours} h`;
  return `${minutes} min`;
}

function formatRelativeAge(timestampMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - timestampMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

/** Format last activity time and location, e.g. "5 min ago, server-2/bb". */
export function formatLastActivity(
  entry: Pick<NsSessionEntry, 'last_activity' | 'last_where'>,
  nowMs = Date.now(),
): string {
  const parts: string[] = [];
  const lastActivity = finiteOrNull(entry.last_activity);
  if (lastActivity !== null) {
    parts.push(formatRelativeAge(lastActivity, nowMs));
  }
  if (entry.last_where) {
    const whereParts = [entry.last_where.machine, entry.last_where.profile]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean);
    if (whereParts.length > 0) {
      parts.push(whereParts.join('/'));
    }
  }
  return parts.join(', ');
}

/** Extract only the allowed session fields so unexpected payload keys are dropped. */
export function sanitizeEntry(raw: unknown): NsSessionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.account !== 'string' || !item.account.trim()) return null;
  const state: NsSessionState = item.state === 'dying' ? 'dying' : 'live';
  let lastWhere: NsSessionWhere | null = null;
  if (item.last_where && typeof item.last_where === 'object') {
    const where = item.last_where as Record<string, unknown>;
    const machine = typeof where.machine === 'string' ? where.machine : '';
    const profile = typeof where.profile === 'string' ? where.profile : '';
    if (machine || profile) {
      lastWhere = { machine, profile };
    }
  }
  return {
    account: item.account,
    user: typeof item.user === 'string' ? item.user : '',
    role: typeof item.role === 'string' ? item.role : '',
    state,
    abs_expiry: finiteOrNull(item.abs_expiry),
    idle_expiry: finiteOrNull(item.idle_expiry),
    last_activity: finiteOrNull(item.last_activity),
    last_where: lastWhere,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Query the background for live NetSuite sessions with a strict timeout. */
export async function fetchNsSessions(
  sendMessage: RuntimeSender,
  timeoutMs = NS_SESSIONS_TIMEOUT_MS,
  nowMs = Date.now(),
): Promise<NsSessionsFetchResult> {
  try {
    const raw = await withTimeout(
      Promise.resolve(sendMessage({ type: NS_SESSION_MESSAGES.LIST })),
      timeoutMs,
    );
    if (!raw || typeof raw !== 'object') {
      return { status: 'unreachable', entries: [] };
    }
    const response = raw as Partial<NsSessionsListResponse>;
    if (response.ok !== true || !Array.isArray(response.entries)) {
      return { status: 'unreachable', entries: [] };
    }
    const entries = response.entries
      .map(sanitizeEntry)
      .filter(
        (entry): entry is NsSessionEntry => entry !== null && !isSessionExpired(entry, nowMs),
      );
    return { status: 'ready', entries };
  } catch {
    return { status: 'unreachable', entries: [] };
  }
}

/** Ask the background to open an already logged-in tab for a NetSuite account. */
export async function openNsSession(
  account: string,
  sendMessage: RuntimeSender,
  timeoutMs = NS_SESSION_OPEN_TIMEOUT_MS,
): Promise<NsSessionOpenResult> {
  try {
    const raw = await withTimeout(
      Promise.resolve(sendMessage({ type: NS_SESSION_MESSAGES.OPEN, account })),
      timeoutMs,
    );
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: '' };
    }
    const response = raw as Partial<NsSessionOpenResponse>;
    if (response.ok === true && typeof response.tabId === 'number') {
      return { ok: true, tabId: response.tabId };
    }
    return {
      ok: false,
      error:
        typeof (response as { error?: unknown }).error === 'string'
          ? (response as { error: string }).error
          : '',
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.message !== 'timeout' ? error.message : '',
    };
  }
}
