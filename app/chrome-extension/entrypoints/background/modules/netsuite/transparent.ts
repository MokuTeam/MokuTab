/**
 * NetSuite session store, transparent mode, extension side: watch this
 * profile's NetSuite account hosts and tell the bridge what happened, by host
 * only. The bridge reads or writes the cookies through the typed requests in
 * cookies.ts; no cookie value is ever part of these reports.
 *
 * - a new JSESSIONID (not one this extension imported) -> ns_session_changed
 * - a tab or a background request landing on the account's login page ->
 *   ns_login_landing; a tab is then sent where it was going
 * - the account answering normally -> ns_activity (the bridge throttles)
 * - a role or account switch, or a logout, starting -> ns_session_ending
 */

import { NativeMessageType } from '@mokuhub/mokutab-shared';
import { STORAGE_KEYS } from '@/common/constants';
import { askBridge } from '../../bridge-channel';
import { moduleExplicitlyOn } from '../../extension-module';
import { ACCOUNT_HOST, ownWriteRecent } from './cookies';

export const CHANGE_DEBOUNCE_MS = 3_000;
/** A login step this recent makes a new session a fresh login (login_at). */
export const LOGIN_STEP_WINDOW_MS = 60_000;
/** A tab landing on the login page again this soon, after an answer of none, is not reported. */
export const LANDING_REPEAT_MS = 10_000;
/** Background requests: one landing report per host in this window. */
export const FETCH_LANDING_MS = 60_000;
/** Activity: at most one report per host in this window (the bridge throttles further). */
export const ACTIVITY_EVERY_MS = 30_000;
export const LANDING_TIMEOUT_MS = 30_000;

const LOGIN_PATH = /\/app\/login\/|\/pages\/customerlogin|loginchallenge|\/next\/app\/login\//i;
const LANDING_PATH =
  /^\/app\/login\/secure\/(loginrouter|enterpriselogin)\.nl$|^\/pages\/customerlogin/i;
const LOGIN_STEP_PATH = /authenticaterole\.nl$|loginchallenge/i;
const SWITCH_PATH = /(changeaccount|changerole|chooserole)\.nl$/i;
const LOGOUT_PATH = /nllogoutnoback\.jsp$|\/logout\.nl$|customerlogout/i;

export interface NsWatchEnv {
  /** The netsuite module is on (the bridge said so) and this profile did not switch it off. */
  enabled(): Promise<boolean>;
  ask(type: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  navigate(tabId: number, url: string): Promise<void>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** This extension's own origin: its own requests (the session probe) are not reports. */
  ownOrigin: string;
}

function parse(url: string | undefined): URL | null {
  try {
    return url ? new URL(url) : null;
  } catch {
    return null;
  }
}

function accountHostOf(url: URL | null): string | null {
  if (!url || url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  return ACCOUNT_HOST.test(host) ? host : null;
}

export class NsWatcher {
  private readonly pendingChange = new Map<string, unknown>();
  private readonly loginSteps = new Map<string, number>();
  /** Per host: when the last tab landing was answered with none, or is in flight. */
  private readonly landings = new Map<
    string,
    { at: number; inFlight: boolean; navigated: boolean }
  >();
  private readonly fetchLandings = new Map<string, number>();
  private readonly activity = new Map<string, number>();

  constructor(private readonly env: NsWatchEnv) {}

  private async send(type: string, payload: Record<string, unknown>, timeoutMs?: number) {
    if (!(await this.env.enabled())) return null;
    try {
      return await this.env.ask(type, payload, timeoutMs);
    } catch {
      // No bridge, an older bridge or the module off there: the page works as without the store.
      return null;
    }
  }

  onCookieChanged(info: {
    removed: boolean;
    cause: string;
    cookie: { name: string; domain: string };
  }) {
    if (info.removed || info.cause !== 'explicit' || info.cookie?.name !== 'JSESSIONID') return;
    const host = String(info.cookie.domain || '')
      .replace(/^\./, '')
      .toLowerCase();
    if (!ACCOUNT_HOST.test(host) || ownWriteRecent(host, this.env.now())) return;
    const previous = this.pendingChange.get(host);
    if (previous !== undefined) this.env.clearTimer(previous);
    this.pendingChange.set(
      host,
      this.env.setTimer(() => {
        this.pendingChange.delete(host);
        const step = this.loginSteps.get(host);
        const afterLogin = step !== undefined && this.env.now() - step < LOGIN_STEP_WINDOW_MS;
        void this.send(NativeMessageType.NS_SESSION_CHANGED, { host, after_login: afterLogin });
      }, CHANGE_DEBOUNCE_MS),
    );
  }

  async onCommitted(details: { url: string; frameId: number; tabId: number }) {
    if (details.frameId !== 0) return;
    const url = parse(details.url);
    const host = accountHostOf(url);
    if (!host || !url) return;
    if (LOGIN_STEP_PATH.test(url.pathname)) {
      this.loginSteps.set(host, this.env.now());
      return;
    }
    if (!LANDING_PATH.test(url.pathname)) return;
    const now = this.env.now();
    const last = this.landings.get(host);
    if (last?.inFlight) return;
    // Right after an answer of none the bridge would say none again; after a
    // navigation it must hear the landing (a bounce: the import did not hold).
    if (last && !last.navigated && now - last.at < LANDING_REPEAT_MS) return;
    this.landings.set(host, { at: now, inFlight: true, navigated: false });
    const target = url.searchParams.get('redirect');
    const answer = await this.send(
      NativeMessageType.NS_LOGIN_LANDING,
      { host, kind: 'tab', tab_id: details.tabId, ...(target ? { target } : {}) },
      LANDING_TIMEOUT_MS,
    );
    const go = answer?.action === 'navigate' ? parse(answer.url) : null;
    const navigated = !!go && go.hostname.toLowerCase() === host && go.protocol === 'https:';
    this.landings.set(host, { at: this.env.now(), inFlight: false, navigated });
    if (navigated) {
      await this.env.navigate(details.tabId, go!.toString()).catch(() => undefined);
    }
  }

  async onBeforeNavigate(details: { url: string; frameId: number }) {
    if (details.frameId !== 0) return;
    const url = parse(details.url);
    const host = accountHostOf(url);
    if (!host || !url) return;
    const reason = SWITCH_PATH.test(url.pathname)
      ? 'switch'
      : LOGOUT_PATH.test(url.pathname)
        ? 'logout'
        : null;
    if (!reason) return;
    await this.send(NativeMessageType.NS_SESSION_ENDING, { host, reason });
  }

  async onBeforeRedirect(details: {
    url: string;
    redirectUrl: string;
    type: string;
    initiator?: string;
  }) {
    if (details.type === 'main_frame' || details.type === 'sub_frame') return;
    if (details.initiator && details.initiator.startsWith(this.env.ownOrigin)) return;
    const to = parse(details.redirectUrl);
    const host = accountHostOf(to);
    if (!host || !to || !LOGIN_PATH.test(to.pathname)) return;
    const now = this.env.now();
    const last = this.fetchLandings.get(host);
    if (last !== undefined && now - last < FETCH_LANDING_MS) return;
    this.fetchLandings.set(host, now);
    await this.send(
      NativeMessageType.NS_LOGIN_LANDING,
      { host, kind: 'fetch' },
      LANDING_TIMEOUT_MS,
    );
  }

  async onCompleted(details: {
    url: string;
    statusCode: number;
    type: string;
    initiator?: string;
  }) {
    if (details.statusCode !== 200) return;
    if (details.type !== 'main_frame' && details.type !== 'xmlhttprequest') return;
    if (details.initiator && details.initiator.startsWith(this.env.ownOrigin)) return;
    const url = parse(details.url);
    const host = accountHostOf(url);
    if (!host || !url || LOGIN_PATH.test(url.pathname)) return;
    const now = this.env.now();
    const last = this.activity.get(host);
    if (last !== undefined && now - last < ACTIVITY_EVERY_MS) return;
    this.activity.set(host, now);
    await this.send(NativeMessageType.NS_ACTIVITY, { host });
  }
}

/** Whether transparent mode may act in this profile now. */
export async function nsTransparentEnabled(): Promise<boolean> {
  if (!(await moduleExplicitlyOn('netsuite'))) return false;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.NS_TRANSPARENT]);
    return stored?.[STORAGE_KEYS.NS_TRANSPARENT] !== false;
  } catch {
    return true;
  }
}

let started = false;

/** Register the listeners once, at service worker start. */
export function startNsTransparent(): void {
  if (started) return;
  started = true;
  const watcher = new NsWatcher({
    enabled: nsTransparentEnabled,
    ask: (type, payload, timeoutMs) => askBridge(type, payload, timeoutMs),
    navigate: async (tabId, url) => {
      await chrome.tabs.update(tabId, { url });
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ownOrigin: `chrome-extension://${chrome.runtime.id}`,
  });
  const netsuite = [{ hostSuffix: '.app.netsuite.com' }];
  chrome.cookies?.onChanged.addListener((info) => watcher.onCookieChanged(info as any));
  chrome.webNavigation?.onCommitted.addListener((d) => void watcher.onCommitted(d), {
    url: netsuite,
  });
  chrome.webNavigation?.onBeforeNavigate.addListener((d) => void watcher.onBeforeNavigate(d), {
    url: netsuite,
  });
  chrome.webRequest?.onBeforeRedirect.addListener((d) => void watcher.onBeforeRedirect(d as any), {
    urls: ['https://*.app.netsuite.com/*'],
  });
  chrome.webRequest?.onCompleted.addListener((d) => void watcher.onCompleted(d as any), {
    urls: ['https://*.app.netsuite.com/*'],
    types: ['main_frame', 'xmlhttprequest'],
  });
}
