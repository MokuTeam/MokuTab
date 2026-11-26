/**
 * The popup's NetSuite sessions section, background side: list and open go to
 * the bridge as typed requests, only from this extension's own pages and only
 * while the module is on; no cookie value is in any reply.
 */

import { describe, expect, test } from 'vitest';
import { NativeMessageType } from '@mokuhub/mokutab-shared';
import {
  LIST_TIMEOUT_MS,
  NS_POPUP_LIST_MESSAGE,
  NS_POPUP_OPEN_MESSAGE,
  OPEN_TIMEOUT_MS,
  handleNsPopupMessage,
  openableUrl,
  type NsPopupEnv,
} from '@/entrypoints/background/modules/netsuite/popup-requests';

const HOST = '1234567-sb2.app.netsuite.com';
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

describe('popup NetSuite sessions requests', () => {
  test('list goes to the bridge and returns its entries', async () => {
    const h = env();
    const reply = await handleNsPopupMessage({ type: NS_POPUP_LIST_MESSAGE }, POPUP, h.env);
    expect(reply).toEqual({ ok: true, entries: [ENTRY] });
    expect(h.asked).toEqual([
      { type: NativeMessageType.NS_POPUP_LIST, payload: {}, timeoutMs: LIST_TIMEOUT_MS },
    ]);
  });

  test('open asks the bridge, then opens the account URL in a new tab', async () => {
    const h = env({
      answer: () => ({ ok: true, url: `https://${HOST}/app/center/card.nl`, action: 'imported' }),
    });
    const reply = await handleNsPopupMessage(
      { type: NS_POPUP_OPEN_MESSAGE, account: '1234567_SB2' },
      POPUP,
      h.env,
    );
    expect(reply).toEqual({ ok: true, tabId: 42 });
    expect(h.asked[0]).toEqual({
      type: NativeMessageType.NS_POPUP_OPEN,
      payload: { account: '1234567_SB2' },
      timeoutMs: OPEN_TIMEOUT_MS,
    });
    expect(h.opened).toEqual([`https://${HOST}/app/center/card.nl`]);
  });

  test('a bridge answer with an address outside NetSuite account hosts opens nothing', async () => {
    for (const url of [
      'https://evil.example/',
      'http://' + HOST + '/',
      'javascript:alert(1)',
      42,
    ]) {
      const h = env({ answer: () => ({ ok: true, url }) });
      const reply = await handleNsPopupMessage(
        { type: NS_POPUP_OPEN_MESSAGE, account: '1234567_SB2' },
        POPUP,
        h.env,
      );
      expect(reply?.ok).toBe(false);
      expect(h.opened).toEqual([]);
    }
    expect(openableUrl(`https://${HOST}/app/center/card.nl`)).toBe(
      `https://${HOST}/app/center/card.nl`,
    );
  });

  test('module off, another sender or no account: refused without asking the bridge', async () => {
    const off = env({ moduleOn: async () => false });
    expect(await handleNsPopupMessage({ type: NS_POPUP_LIST_MESSAGE }, POPUP, off.env)).toEqual({
      ok: false,
      error: 'the NetSuite module is off',
    });
    const page = env();
    const tab = { id: 'own', tab: { id: 1 } } as unknown as chrome.runtime.MessageSender;
    expect(await handleNsPopupMessage({ type: NS_POPUP_LIST_MESSAGE }, tab, page.env)).toEqual({
      ok: false,
      error: 'not allowed',
    });
    const noAccount = env();
    expect(
      await handleNsPopupMessage({ type: NS_POPUP_OPEN_MESSAGE }, POPUP, noAccount.env),
    ).toEqual({ ok: false, error: 'no account' });
    expect([...off.asked, ...page.asked, ...noAccount.asked]).toEqual([]);
  });

  test('bridge errors and timeouts become short texts; other messages are not ours', async () => {
    const down = env({
      ask: async () => {
        throw new Error('the bridge did not answer');
      },
    });
    expect(await handleNsPopupMessage({ type: NS_POPUP_LIST_MESSAGE }, POPUP, down.env)).toEqual({
      ok: false,
      error: 'the bridge did not answer',
    });
    const refused = env({
      answer: () => ({ ok: false, error: 'no live session for this account' }),
    });
    expect(
      await handleNsPopupMessage(
        { type: NS_POPUP_OPEN_MESSAGE, account: '1234567_SB2' },
        POPUP,
        refused.env,
      ),
    ).toEqual({ ok: false, error: 'no live session for this account' });
    expect(await handleNsPopupMessage({ type: 'get_modules' }, POPUP, env().env)).toBeNull();
  });
});
