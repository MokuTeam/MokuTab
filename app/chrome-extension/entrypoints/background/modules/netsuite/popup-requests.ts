/**
 * The popup's NetSuite sessions section, background side: the list of live
 * sessions in the store, and a click that opens one in this profile, logged
 * in. Both go to the bridge as typed requests; the import itself runs between
 * the bridge and this extension (cookies.ts). No cookie value is part of any
 * message here: the replies carry account metadata and a URL only.
 *
 * Message contract: entrypoints/popup/ns-sessions.ts.
 */

import { NativeMessageType } from '@mokuhub/mokutab-shared';
import { askBridge } from '../../bridge-channel';
import { moduleExplicitlyOn } from '../../extension-module';
import { ACCOUNT_HOST } from './cookies';

export const NS_POPUP_LIST_MESSAGE = 'ns_sessions_list';
export const NS_POPUP_OPEN_MESSAGE = 'ns_session_open';
/** The popup waits 3 s for the list; the bridge gets a little less. */
export const LIST_TIMEOUT_MS = 2_800;
/** An open may import a session first (probe, cookie write). */
export const OPEN_TIMEOUT_MS = 14_000;

export interface NsPopupEnv {
  moduleOn(): Promise<boolean>;
  ask(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any>;
  openTab(url: string): Promise<number | undefined>;
  /** This extension's own pages (the popup), the only senders answered. */
  fromOwnPage(sender: chrome.runtime.MessageSender): boolean;
}

type Reply = { ok: true; [key: string]: unknown } | { ok: false; error: string };

function errorText(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return text && text.length < 200 ? text : fallback;
}

/** A URL the bridge may send the popup's new tab to: https on an account host only. */
export function openableUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ACCOUNT_HOST.test(parsed.hostname) ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The answer to one popup message, or null when the message is not ours. */
export async function handleNsPopupMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  env: NsPopupEnv,
): Promise<Reply | null> {
  const type = message?.type;
  if (type !== NS_POPUP_LIST_MESSAGE && type !== NS_POPUP_OPEN_MESSAGE) return null;
  if (!env.fromOwnPage(sender)) return { ok: false, error: 'not allowed' };
  if (!(await env.moduleOn())) return { ok: false, error: 'the NetSuite module is off' };
  if (type === NS_POPUP_LIST_MESSAGE) {
    try {
      const data = await env.ask(NativeMessageType.NS_POPUP_LIST, {}, LIST_TIMEOUT_MS);
      if (data?.ok === true && Array.isArray(data.entries))
        return { ok: true, entries: data.entries };
      return { ok: false, error: typeof data?.error === 'string' ? data.error : 'no answer' };
    } catch (err) {
      return { ok: false, error: errorText(err, 'session store not reachable') };
    }
  }
  const account = typeof message?.account === 'string' ? message.account.trim() : '';
  if (!account) return { ok: false, error: 'no account' };
  try {
    const data = await env.ask(NativeMessageType.NS_POPUP_OPEN, { account }, OPEN_TIMEOUT_MS);
    if (data?.ok !== true) {
      return { ok: false, error: typeof data?.error === 'string' ? data.error : 'could not open' };
    }
    const url = openableUrl(data.url);
    if (!url) return { ok: false, error: 'the bridge answered an unexpected address' };
    const tabId = await env.openTab(url);
    return typeof tabId === 'number' ? { ok: true, tabId } : { ok: false, error: 'no tab opened' };
  } catch (err) {
    return { ok: false, error: errorText(err, 'could not open the session') };
  }
}

const liveEnv: NsPopupEnv = {
  moduleOn: () => moduleExplicitlyOn('netsuite'),
  ask: (type, payload, timeoutMs) => askBridge(type, payload, timeoutMs),
  openTab: async (url) => (await chrome.tabs.create({ url, active: true })).id,
  fromOwnPage: (sender) =>
    sender?.id === chrome.runtime.id &&
    !sender.tab &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL('')),
};

let started = false;

/** Answer the popup's ns_sessions_list and ns_session_open messages. */
export function startNsPopup(env: NsPopupEnv = liveEnv): void {
  if (started) return;
  started = true;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message?.type;
    if (type !== NS_POPUP_LIST_MESSAGE && type !== NS_POPUP_OPEN_MESSAGE) return false;
    void handleNsPopupMessage(message, sender, env).then((reply) => sendResponse(reply));
    return true;
  });
}
