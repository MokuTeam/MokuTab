/**
 * NetSuite transparent mode, extension side: what this profile reports to the
 * bridge on its own. Only hosts (and a tab id, a target path or a reason)
 * ever go out; never a cookie value.
 */

import { describe, expect, test, vi } from 'vitest';
import { NativeMessageType } from '@mokuhub/mokutab-shared';
import { writeNsCookies } from '@/entrypoints/background/modules/netsuite/cookies';
import { applyBridgeModulesState } from '@/entrypoints/background/extension-module';
import {
  nsTransparentEnabled,
  startNsTransparent,
  ACTIVITY_EVERY_MS,
  CHANGE_DEBOUNCE_MS,
  FETCH_LANDING_MS,
  LANDING_REPEAT_MS,
  NsWatcher,
  type NsWatchEnv,
} from '@/entrypoints/background/modules/netsuite/transparent';

const HOST = '1234567-sb2.app.netsuite.com';
const VALUE = 'JSESS-SECRET-VALUE-abcdef0123';
const OWN = 'chrome-extension://own-id';

interface Sent {
  type: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}

function harness(over: Partial<NsWatchEnv> & { answer?: (s: Sent) => any; on?: boolean } = {}) {
  let now = 1_000_000;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextId = 1;
  const sent: Sent[] = [];
  const navigated: Array<{ tabId: number; url: string }> = [];
  let on = over.on ?? true;
  const env: NsWatchEnv = {
    enabled: async () => on,
    ask: async (type, payload, timeoutMs) => {
      const s = { type, payload, timeoutMs };
      sent.push(s);
      return over.answer ? over.answer(s) : { action: 'none' };
    },
    navigate: async (tabId, url) => {
      navigated.push({ tabId, url });
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimer: (handle) => {
      const i = timers.findIndex((t) => t.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
    ownOrigin: OWN,
    ...over,
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at <= now) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    watcher: new NsWatcher(env),
    sent,
    navigated,
    advance,
    setOn: (v: boolean) => (on = v),
  };
}

const changed = (over: any = {}) => ({
  removed: false,
  cause: 'explicit',
  cookie: { name: 'JSESSIONID', domain: HOST, value: VALUE },
  ...over,
});

function noValues(sent: Sent[]) {
  const text = JSON.stringify(sent);
  expect(text).not.toContain(VALUE);
  for (const s of sent) {
    for (const key of Object.keys(s.payload)) {
      expect(['host', 'after_login', 'kind', 'tab_id', 'target', 'reason']).toContain(key);
    }
  }
}

describe('publish on a new JSESSIONID', () => {
  test('debounced 3 s per host, host only, after_login after a login step', async () => {
    const h = harness();
    h.watcher.onCookieChanged(changed());
    h.watcher.onCookieChanged(changed());
    await h.advance(CHANGE_DEBOUNCE_MS - 1);
    expect(h.sent).toEqual([]);
    await h.advance(1);
    expect(h.sent).toEqual([
      {
        type: NativeMessageType.NS_SESSION_CHANGED,
        payload: { host: HOST, after_login: false },
        timeoutMs: undefined,
      },
    ]);
    await h.watcher.onCommitted({
      url: `https://${HOST}/app/login/secure/authenticaterole.nl`,
      frameId: 0,
      tabId: 3,
    });
    h.watcher.onCookieChanged(
      changed({ cookie: { name: 'JSESSIONID', domain: `.${HOST}`, value: VALUE } }),
    );
    await h.advance(CHANGE_DEBOUNCE_MS);
    expect(h.sent[1].payload).toEqual({ host: HOST, after_login: true });
    noValues(h.sent);
  });

  test('ignores removals, other causes, other cookies, other hosts and a profile switched off', async () => {
    const h = harness();
    h.watcher.onCookieChanged(changed({ removed: true }));
    h.watcher.onCookieChanged(changed({ cause: 'overwrite' }));
    h.watcher.onCookieChanged(changed({ cookie: { name: 'NS_ROUTING', domain: HOST } }));
    h.watcher.onCookieChanged(
      changed({ cookie: { name: 'JSESSIONID', domain: 'system.netsuite.com' } }),
    );
    await h.advance(CHANGE_DEBOUNCE_MS);
    expect(h.sent).toEqual([]);
    h.setOn(false);
    h.watcher.onCookieChanged(changed());
    await h.advance(CHANGE_DEBOUNCE_MS);
    expect(h.sent).toEqual([]);
  });
});

describe('import on a login landing', () => {
  const landing = (
    path = '/app/login/secure/enterpriselogin.nl?c=1234567_SB2&redirect=%2Fapp%2Fcenter%2Fcard.nl%3Fx%3D1',
  ) => ({ url: `https://${HOST}${path}`, frameId: 0, tabId: 7 });

  test('asks with host, tab and target; navigates only to the same host', async () => {
    const h = harness({
      answer: () => ({ action: 'navigate', url: `https://${HOST}/app/center/card.nl?x=1` }),
    });
    await h.watcher.onCommitted(landing());
    expect(h.sent[0]).toMatchObject({
      type: NativeMessageType.NS_LOGIN_LANDING,
      payload: { host: HOST, kind: 'tab', tab_id: 7, target: '/app/center/card.nl?x=1' },
    });
    expect(h.navigated).toEqual([{ tabId: 7, url: `https://${HOST}/app/center/card.nl?x=1` }]);
    const evil = harness({ answer: () => ({ action: 'navigate', url: 'https://evil.example/' }) });
    await evil.watcher.onCommitted(landing());
    expect(evil.navigated).toEqual([]);
    noValues(h.sent);
  });

  test('after an answer of none the same landing is not re-sent for 10 s; after a navigation it is (bounce)', async () => {
    let answer: any = { action: 'none' };
    const h = harness({ answer: () => answer });
    await h.watcher.onCommitted(landing());
    await h.watcher.onCommitted(landing());
    expect(h.sent).toHaveLength(1);
    await h.advance(LANDING_REPEAT_MS);
    answer = { action: 'navigate', url: `https://${HOST}/app/center/card.nl` };
    await h.watcher.onCommitted(landing());
    expect(h.sent).toHaveLength(2);
    // The imported session bounced: the landing right after a navigation is reported.
    answer = { action: 'none', reason: 'loop_guard' };
    await h.watcher.onCommitted(landing());
    expect(h.sent).toHaveLength(3);
  });

  test('login steps, subframes and pages that are not landings are not reported', async () => {
    const h = harness();
    await h.watcher.onCommitted({ ...landing(), frameId: 2 });
    await h.watcher.onCommitted(landing('/app/login/secure/authenticaterole.nl'));
    await h.watcher.onCommitted(landing('/app/center/card.nl'));
    await h.watcher.onCommitted({
      url: 'https://system.netsuite.com/pages/customerlogin.jsp',
      frameId: 0,
      tabId: 1,
    });
    expect(h.sent).toEqual([]);
  });

  test('a background request redirected to the login page imports once a minute, never for our own probe', async () => {
    const h = harness();
    const redirect = (initiator?: string) => ({
      url: `https://${HOST}/app/center/card.nl`,
      redirectUrl: `https://${HOST}/app/login/secure/enterpriselogin.nl?c=1`,
      type: 'xmlhttprequest',
      initiator,
    });
    await h.watcher.onBeforeRedirect(redirect(OWN));
    expect(h.sent).toEqual([]);
    await h.watcher.onBeforeRedirect(redirect('chrome-extension://another-extension'));
    await h.watcher.onBeforeRedirect(redirect());
    expect(h.sent).toEqual([
      {
        type: NativeMessageType.NS_LOGIN_LANDING,
        payload: { host: HOST, kind: 'fetch' },
        timeoutMs: 30_000,
      },
    ]);
    await h.advance(FETCH_LANDING_MS);
    await h.watcher.onBeforeRedirect(redirect());
    expect(h.sent).toHaveLength(2);
    await h.watcher.onBeforeRedirect({ ...redirect(), type: 'main_frame' });
    expect(h.sent).toHaveLength(2);
  });
});

describe('activity and death signals', () => {
  test('activity: 200 on the account host, not a login page, not our own request, once per 30 s', async () => {
    const h = harness();
    const done = (over: any = {}) => ({
      url: `https://${HOST}/app/center/card.nl`,
      statusCode: 200,
      type: 'main_frame',
      ...over,
    });
    await h.watcher.onCompleted(done({ initiator: OWN }));
    await h.watcher.onCompleted(done({ statusCode: 302 }));
    await h.watcher.onCompleted(
      done({ url: `https://${HOST}/app/login/secure/enterpriselogin.nl` }),
    );
    await h.watcher.onCompleted(done({ type: 'image' }));
    expect(h.sent).toEqual([]);
    await h.watcher.onCompleted(done());
    await h.watcher.onCompleted(done({ type: 'xmlhttprequest' }));
    expect(h.sent).toEqual([
      { type: NativeMessageType.NS_ACTIVITY, payload: { host: HOST }, timeoutMs: undefined },
    ]);
    await h.advance(ACTIVITY_EVERY_MS);
    await h.watcher.onCompleted(done());
    expect(h.sent).toHaveLength(2);
  });

  test('a role or account switch and a logout report the session ending with their reason', async () => {
    const h = harness();
    const nav = (path: string) => ({ url: `https://${HOST}${path}`, frameId: 0 });
    await h.watcher.onBeforeNavigate(nav('/app/login/secure/changerole.nl?id=3'));
    await h.watcher.onBeforeNavigate(nav('/app/login/secure/changeaccount.nl'));
    await h.watcher.onBeforeNavigate(nav('/app/login/secure/chooserole.nl'));
    await h.watcher.onBeforeNavigate(nav('/pages/nllogoutnoback.jsp'));
    await h.watcher.onBeforeNavigate(nav('/app/center/card.nl'));
    expect(h.sent.map((s) => [s.type, s.payload.reason])).toEqual([
      [NativeMessageType.NS_SESSION_ENDING, 'switch'],
      [NativeMessageType.NS_SESSION_ENDING, 'switch'],
      [NativeMessageType.NS_SESSION_ENDING, 'switch'],
      [NativeMessageType.NS_SESSION_ENDING, 'logout'],
    ]);
    noValues(h.sent);
  });

  test('nothing is sent while the module or the profile switch is off', async () => {
    const h = harness({ on: false });
    await h.watcher.onBeforeNavigate({
      url: `https://${HOST}/pages/nllogoutnoback.jsp`,
      frameId: 0,
    });
    await h.watcher.onCompleted({
      url: `https://${HOST}/app/center/card.nl`,
      statusCode: 200,
      type: 'main_frame',
    });
    expect(h.sent).toEqual([]);
  });
});

describe('wiring', () => {
  test('the cookie changes of an import are not taken for a new session', async () => {
    (globalThis as any).chrome.cookies = {
      set: vi.fn(async (d: any) => d),
      getAll: vi.fn(async () => []),
    };
    await writeNsCookies({
      host: HOST,
      cookies: [
        { name: 'JSESSIONID', value: VALUE, domain: HOST, path: '/', secure: true, httpOnly: true },
      ],
    });
    const h = harness();
    h.watcher.onCookieChanged(changed());
    await h.advance(CHANGE_DEBOUNCE_MS);
    expect(h.sent).toEqual([]);
  });

  test('transparent mode needs the module explicitly on and the profile switch not off', async () => {
    const store: Record<string, unknown> = {};
    (globalThis as any).chrome.storage.local.get = vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
    );
    (globalThis as any).chrome.storage.local.set = vi.fn(async (o: Record<string, unknown>) =>
      Object.assign(store, o),
    );
    await applyBridgeModulesState({
      modules: [{ id: 'netsuite', title: 'NetSuite', enabled: false }],
    });
    expect(await nsTransparentEnabled()).toBe(false);
    await applyBridgeModulesState({
      modules: [{ id: 'netsuite', title: 'NetSuite', enabled: true }],
    });
    expect(await nsTransparentEnabled()).toBe(true);
    store.nsTransparent = false;
    expect(await nsTransparentEnabled()).toBe(false);
  });

  test('start registers the listeners once, filtered to NetSuite account hosts', () => {
    const add = () => ({ addListener: vi.fn() });
    const chrome = (globalThis as any).chrome;
    chrome.cookies = { onChanged: add() };
    chrome.webNavigation = { onCommitted: add(), onBeforeNavigate: add() };
    chrome.webRequest = { onBeforeRedirect: add(), onCompleted: add() };
    startNsTransparent();
    startNsTransparent();
    expect(chrome.cookies.onChanged.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.webNavigation.onCommitted.addListener.mock.calls[0][1]).toEqual({
      url: [{ hostSuffix: '.app.netsuite.com' }],
    });
    expect(chrome.webRequest.onCompleted.addListener.mock.calls[0][1]).toEqual({
      urls: ['https://*.app.netsuite.com/*'],
      types: ['main_frame', 'xmlhttprequest'],
    });
  });
});
