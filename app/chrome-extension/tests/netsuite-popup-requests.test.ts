/**
 * The popup's NetSuite sessions section, background side: list and open go to
 * the bridge as typed requests, only from this extension's own pages and only
 * while the module is on; failures are short codes; no cookie value anywhere.
 */

import { describe, expect, test } from 'vitest';
import { NativeMessageType } from '@mokuhub/mokutab-shared';
import {
  LIST_TIMEOUT_MS,
  NS_POPUP_LIST_MESSAGE,
  NS_POPUP_OPEN_MESSAGE,
  OPEN_TIMEOUT_MS,
  handleNsPopupMessage,
  isOwnPage,
  openableUrl,
  type NsPopupEnv,
} from '@/entrypoints/background/modules/netsuite/popup-requests';

const HOST = '1234567-sb2.app.netsuite.com';
const CARD = `https://${HOST}/app/center/card.nl`;
const POPUP = {
  id: 'own',
  url: 'chrome-extension://own/popup.html',
} as chrome.runtime.MessageSender;
const ENTRY = {
  account: '1234567_SB2',
  user: 'a@example.com',
  role: '3',
  state: 'live',
  abs_expiry: 1,
  idle_expiry: 2,
  last_activity: 3,
  last_where: { machine: 'laptop', profile: 'work' },
};

function env(over: Partial<NsPopupEnv> & { answer?: (type: string, payload: any) => any } = {}) {
  const asked: Array<{ type: string; payload: any; timeoutMs: number }> = [];
  const opened: string[] = [];
  const e: NsPopupEnv = {
    moduleOn: async () => true,
    ask: async (type, payload, timeoutMs) => {
      asked.push({ type, payload, timeoutMs });
      return over.answer ? over.answer(type, payload) : { ok: true, entries: [ENTRY] };
    },
    openTab: async (url) => {
      opened.push(url);
      return 42;
    },
    fromOwnPage: (sender) => sender === POPUP,
    ...over,
  };
  return { env: e, asked, opened };
}

const open = (account: string, user?: string) => ({
  type: NS_POPUP_OPEN_MESSAGE,
  account,
  ...(user ? { user } : {}),
});

describe('popup NetSuite sessions requests', () => {
  test('list goes to the bridge and returns its entries', async () => {
    const h = env();
    expect(await handleNsPopupMessage({ type: NS_POPUP_LIST_MESSAGE }, POPUP, h.env)).toEqual({
      ok: true,
      entries: [ENTRY],
    });
    expect(h.asked).toEqual([
      { type: NativeMessageType.NS_POPUP_LIST, payload: {}, timeoutMs: LIST_TIMEOUT_MS },
    ]);
  });

  test('open passes account and user to the bridge, then opens the account URL', async () => {
    const h = env({ answer: () => ({ ok: true, url: CARD + '?x=1#y', action: 'imported' }) });
    expect(await handleNsPopupMessage(open('1234567_SB2', 'a@example.com'), POPUP, h.env)).toEqual({
      ok: true,
      tabId: 42,
    });
    expect(h.asked[0]).toEqual({
      type: NativeMessageType.NS_POPUP_OPEN,
      payload: { account: '1234567_SB2', user: 'a@example.com' },
      timeoutMs: OPEN_TIMEOUT_MS,
    });
    // Rebuilt from origin and path: no query or fragment from the answer.
    expect(h.opened).toEqual([CARD]);
  });

  test('an address outside NetSuite account hosts opens nothing', async () => {
    for (const url of [
      'https://evil.example/',
      'http://' + HOST + '/',
      'https://' + HOST + ':8443/',
      'javascript:alert(1)',
      42,
    ]) {
      const h = env({ answer: () => ({ ok: true, url }) });
      expect(await handleNsPopupMessage(open('1234567_SB2'), POPUP, h.env)).toEqual({
        ok: false,
        code: 'open_failed',
      });
      expect(h.opened).toEqual([]);
    }
    expect(openableUrl(CARD)).toBe(CARD);
  });

  test('module off, another sender or no account: refused without asking the bridge', async () => {
    const off = env({ moduleOn: async () => false });
    expect(await handleNsPopupMessage({ type: NS_POPUP_LIST_MESSAGE }, POPUP, off.env)).toEqual({
      ok: false,
      code: 'module_off',
    });
    const page = env();
    const tab = { id: 'own', tab: { id: 1 } } as unknown as chrome.runtime.MessageSender;
    expect(await handleNsPopupMessage({ type: NS_POPUP_LIST_MESSAGE }, tab, page.env)).toEqual({
      ok: false,
      code: 'open_failed',
    });
    const noAccount = env();
    expect(
      await handleNsPopupMessage({ type: NS_POPUP_OPEN_MESSAGE }, POPUP, noAccount.env),
    ).toEqual({ ok: false, code: 'open_failed' });
    expect([...off.asked, ...page.asked, ...noAccount.asked]).toEqual([]);
  });

  test('bridge codes pass through, unknown ones and failures map to a fixed code', async () => {
    const down = env({
      ask: async () => {
        throw new Error('the bridge did not answer');
      },
    });
    expect(await handleNsPopupMessage({ type: NS_POPUP_LIST_MESSAGE }, POPUP, down.env)).toEqual({
      ok: false,
      code: 'store_unreachable',
    });
    for (const [code, expected] of [
      ['other_user', 'other_user'],
      ['could_not_check', 'could_not_check'],
      ['something_else', 'open_failed'],
    ]) {
      const h = env({ answer: () => ({ ok: false, code }) });
      expect(await handleNsPopupMessage(open('1234567_SB2'), POPUP, h.env)).toEqual({
        ok: false,
        code: expected,
      });
    }
    expect(await handleNsPopupMessage({ type: 'get_modules' }, POPUP, env().env)).toBeNull();
  });

  test('isOwnPage: only this extension, no tab, a URL on its own origin', () => {
    const origin = 'chrome-extension://own/';
    const ok = { id: 'own', url: origin + 'popup.html' } as chrome.runtime.MessageSender;
    expect(isOwnPage(ok, 'own', origin)).toBe(true);
    expect(isOwnPage({ ...ok, tab: { id: 3 } as chrome.tabs.Tab }, 'own', origin)).toBe(false);
    expect(isOwnPage({ ...ok, url: 'https://evil.example/' }, 'own', origin)).toBe(false);
    expect(isOwnPage({ id: 'own' } as chrome.runtime.MessageSender, 'own', origin)).toBe(false);
    expect(isOwnPage({ ...ok, id: 'other' }, 'own', origin)).toBe(false);
    expect(isOwnPage(undefined, 'own', origin)).toBe(false);
  });
});
