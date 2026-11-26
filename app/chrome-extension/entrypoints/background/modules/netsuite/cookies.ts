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

const ACCOUNT_HOST = /^[0-9a-z]+(?:-[0-9a-z]+)?\.app\.netsuite\.com$/;

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

/**
 * Whether this profile's session for the host is logged in: card.nl, with the
 * profile's cookies, ends on a page of the same host that is not a login page.
 * Redirects are followed: a role's home page may be another page (mainsetup.nl).
 */
export async function probeNsSession(payload: any): Promise<{ alive: boolean }> {
  const host = accountHost(payload);
  try {
    const response = await fetch(`https://${host}/app/center/card.nl`, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
    });
    let final: URL;
    try {
      final = new URL(response.url);
    } catch {
      return { alive: false };
    }
    return {
      alive: response.ok && final.hostname === host && !LOGIN_PATH.test(final.pathname),
    };
  } catch {
    return { alive: false };
  }
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
