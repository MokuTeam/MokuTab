/**
 * NetSuite session cookies of one account host, for the bridge's session
 * store. Called only through typed bridge messages (ns_cookies_read,
 * ns_cookies_write, ns_tab_identity), never as a tool: a cookie value must not
 * be reachable through a tool call an agent could make.
 *
 * Only cookies of the account host itself (host-only, or its dot-domain) are
 * read or written; cookies of .netsuite.com and of other accounts are left
 * alone.
 */

export const ACCOUNT_HOST = /^[0-9a-z]+(?:-[0-9a-z]+)?\.app\.netsuite\.com$/;

/** Per host: until when cookie changes are this extension's own doing (an import, a probe). */
const quietUntil = new Map<string, number>();
/** Session probes in flight per host: their own cookie changes are quiet too. */
const probing = new Map<string, number>();
/** How long the cookie changes of an import are not taken for a new session. */
export const OWN_WRITE_QUIET_MS = 10_000;
/** After a probe settles, its late cookie changes are quiet this long (no longer: a hand login may follow). */
export const PROBE_QUIET_AFTER_MS = 1_000;

/** Test seam: forget every quiet window. */
export function forgetOwnCookieActivity(): void {
  quietUntil.clear();
  probing.clear();
}

function quietFor(host: string, ms: number, now: number = Date.now()): void {
  quietUntil.set(host, Math.max(quietUntil.get(host) ?? 0, now + ms));
}

/** An import wrote the host's cookies: its cookie changes are quiet for OWN_WRITE_QUIET_MS. */
export function markOwnCookieActivity(host: string, now: number = Date.now()): void {
  quietFor(host, OWN_WRITE_QUIET_MS, now);
}

/** Whether a cookie change of the host now is this extension's own doing. */
export function ownWriteRecent(host: string, now: number = Date.now()): boolean {
  return (probing.get(host) ?? 0) > 0 || now < (quietUntil.get(host) ?? 0);
}

export interface NsCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expirationDate?: number;
  hostOnly?: boolean;
}

function accountHost(payload: any): string {
  const host = String(payload?.host ?? '').toLowerCase();
  if (!ACCOUNT_HOST.test(host)) throw new Error(`not a NetSuite account host: ${host}`);
  return host;
}

function ofHost(cookie: { domain: string }, host: string): boolean {
  return cookie.domain === host || cookie.domain === `.${host}`;
}

/** A cookie the store may hand back: of this host, plain strings, a path, no header injection. */
function validCookie(c: any, host: string): boolean {
  return (
    !!c &&
    typeof c.name === 'string' &&
    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(c.name) &&
    typeof c.value === 'string' &&
    !/[;\r\n]/.test(c.value) &&
    typeof c.domain === 'string' &&
    ofHost(c, host) &&
    (c.path === undefined || (typeof c.path === 'string' && c.path.startsWith('/')))
  );
}

export async function readNsCookies(payload: any): Promise<{ cookies: NsCookie[] }> {
  const host = accountHost(payload);
  const all = await chrome.cookies.getAll({ domain: host });
  const cookies = all
    .filter((c) => ofHost(c, host))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      hostOnly: c.hostOnly,
      ...(typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {}),
    }));
  return { cookies };
}

const SAME_SITE = new Set(['no_restriction', 'lax', 'strict', 'unspecified']);

export async function writeNsCookies(payload: any): Promise<{ written: number }> {
  const host = accountHost(payload);
  const cookies: NsCookie[] = Array.isArray(payload?.cookies) ? payload.cookies : [];
  for (const c of cookies) {
    if (!validCookie(c, host))
      throw new Error(`refused a cookie that is not a plain cookie of ${host}`);
  }
  markOwnCookieActivity(host);
  let written = 0;
  for (const c of cookies) {
    const path = typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/';
    const details: chrome.cookies.SetDetails = {
      url: `https://${host}${path}`,
      name: c.name,
      value: c.value,
      path,
      secure: c.secure !== false,
      httpOnly: !!c.httpOnly,
      // A host-only cookie is set without a domain; a domain cookie keeps its dot.
      ...(c.domain.startsWith('.') ? { domain: c.domain } : {}),
      ...(c.sameSite && SAME_SITE.has(c.sameSite)
        ? { sameSite: c.sameSite as chrome.cookies.SameSiteStatus }
        : {}),
      ...(typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {}),
    };
    const set = await chrome.cookies.set(details);
    if (set) written += 1;
  }
  return { written };
}

const LOGIN_PATH = /\/app\/login\/|\/pages\/customerlogin|loginchallenge|\/next\/app\/login\//i;

export type NsSessionState = 'alive' | 'dead' | 'unknown';

/**
 * Whether this profile's session for the host is logged in, by where card.nl
 * ends with the profile's cookies (redirects followed: a role's home page may
 * be another page, mainsetup.nl). Dead only on a login page of the account
 * host; the role chooser (chooserole.nl) is a live session waiting for a pick.
 * A network error, 429, 5xx, any other error status or another host is
 * unknown: never taken for dead.
 */
export async function probeNsSession(payload: any): Promise<{ state: NsSessionState }> {
  const host = accountHost(payload);
  let response: Response;
  // The probe's own request may make NetSuite set a cookie (a login page
  // issues a fresh JSESSIONID): that is not a new session to publish. Quiet
  // only while it runs and briefly after.
  probing.set(host, (probing.get(host) ?? 0) + 1);
  try {
    response = await fetch(`https://${host}/app/center/card.nl`, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
    });
  } catch {
    return { state: 'unknown' };
  } finally {
    probing.set(host, Math.max(0, (probing.get(host) ?? 1) - 1));
    quietFor(host, PROBE_QUIET_AFTER_MS);
  }
  // Only the URL matters: never read (or keep) the page.
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    /* no body */
  }
  let final: URL;
  try {
    final = new URL(response.url);
  } catch {
    return { state: 'unknown' };
  }
  if (final.hostname !== host) return { state: 'unknown' };
  if (/chooserole\.nl$/i.test(final.pathname)) return { state: 'alive' };
  if (LOGIN_PATH.test(final.pathname)) return { state: 'dead' };
  return { state: response.ok ? 'alive' : 'unknown' };
}

/** The user and role of an open, logged-in tab of the account (MAIN world nlapiGetContext). */
export async function nsTabIdentity(payload: any): Promise<{
  identity: { user: string | null; role: string | null; role_id: string | null } | null;
}> {
  const host = accountHost(payload);
  const tabs = await chrome.tabs.query({ url: `https://${host}/*` });
  const candidates = tabs.filter(
    (t) => typeof t.id === 'number' && t.status === 'complete' && !/\/login\//.test(t.url || ''),
  );
  for (const tab of candidates) {
    try {
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId: tab.id as number },
        world: 'MAIN',
        func: () => {
          try {
            const w = window as any;
            if (typeof w.nlapiGetContext !== 'function') return null;
            const c = w.nlapiGetContext();
            return {
              user: c.getEmail ? String(c.getEmail()) : null,
              role: c.getRole ? String(c.getRole()) : null,
              role_id: c.getRoleId ? String(c.getRoleId()) : null,
            };
          } catch {
            return null;
          }
        },
      });
      const identity = frame?.result as any;
      if (identity && identity.user) return { identity };
    } catch {
      // A tab that will not run the script: try the next one.
    }
  }
  return { identity: null };
}
