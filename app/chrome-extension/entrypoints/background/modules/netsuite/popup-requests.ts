/**
 * The popup's NetSuite sessions section, background side: the list of live
 * sessions in the store, and a click that opens one in this profile, logged
 * in. Both go to the bridge as typed requests; the import itself runs between
 * the bridge and this extension (cookies.ts). No cookie value is part of any
 * message here: the replies carry account metadata, a URL or a short code.
 *
 * Failure codes the popup maps to its own text: module_off, store_unreachable,
 * other_user, could_not_check, open_failed.
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
/**
 * An open may read the profile's cookies, probe its session (up to 12 s) and
 * import the store's copy; the popup waits a little longer than this.
 */
export const OPEN_TIMEOUT_MS = 40_000;

export type NsPopupCode =
  | 'module_off'
  | 'store_unreachable'
  | 'other_user'
  | 'could_not_check'
  | 'open_failed';
const CODES = new Set<string>([
  'module_off',
  'store_unreachable',
  'other_user',
  'could_not_check',
  'open_failed',
]);

export interface NsPopupEnv {
  moduleOn(): Promise<boolean>;
  ask(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any>;
  openTab(url: string): Promise<number | undefined>;
  /** This extension's own pages (the popup), the only senders answered. */
  fromOwnPage(sender: chrome.runtime.MessageSender): boolean;
}

type Reply = { ok: true; [key: string]: unknown } | { ok: false; code: NsPopupCode };

const fail = (code: NsPopupCode): Reply => ({ ok: false, code });
const codeOf = (value: unknown, fallback: NsPopupCode): NsPopupCode =>
  typeof value === 'string' && CODES.has(value) ? (value as NsPopupCode) : fallback;

/** Whether a message comes from one of this extension's own pages, not a tab or another origin. */
export function isOwnPage(
  sender: chrome.runtime.MessageSender | undefined,
  extensionId: string,
  ownOrigin: string,
): boolean {
  return (
    !!sender &&
    sender.id === extensionId &&
    !sender.tab &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(ownOrigin)
  );
}

/** The URL the popup's new tab may open: https on an account host, rebuilt from origin and path. */
export function openableUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !ACCOUNT_HOST.test(parsed.hostname) || parsed.port) {
      return null;
    }
    return parsed.origin + parsed.pathname;
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
  if (!env.fromOwnPage(sender)) return fail('open_failed');
  if (!(await env.moduleOn())) return fail('module_off');
  if (type === NS_POPUP_LIST_MESSAGE) {
    try {
      const data = await env.ask(NativeMessageType.NS_POPUP_LIST, {}, LIST_TIMEOUT_MS);
      if (data?.ok === true && Array.isArray(data.entries))
        return { ok: true, entries: data.entries };
      return fail(codeOf(data?.code, 'store_unreachable'));
    } catch {
      return fail('store_unreachable');
    }
  }
  const account = typeof message?.account === 'string' ? message.account.trim() : '';
  if (!account) return fail('open_failed');
  const user =
    typeof message?.user === 'string' && message.user.trim() ? message.user.trim() : null;
  try {
    const data = await env.ask(
      NativeMessageType.NS_POPUP_OPEN,
      user ? { account, user } : { account },
      OPEN_TIMEOUT_MS,
    );
    if (data?.ok !== true) return fail(codeOf(data?.code, 'open_failed'));
    const url = openableUrl(data.url);
    if (!url) return fail('open_failed');
    const tabId = await env.openTab(url);
    return typeof tabId === 'number' ? { ok: true, tabId } : fail('open_failed');
  } catch {
    return fail('store_unreachable');
  }
}

const liveEnv: NsPopupEnv = {
  moduleOn: () => moduleExplicitlyOn('netsuite'),
  ask: (type, payload, timeoutMs) => askBridge(type, payload, timeoutMs),
  openTab: async (url) => (await chrome.tabs.create({ url, active: true })).id,
  fromOwnPage: (sender) => isOwnPage(sender, chrome.runtime.id, chrome.runtime.getURL('')),
};

let started = false;

/** Answer the popup's ns_sessions_list and ns_session_open messages. */
export function startNsPopup(env: NsPopupEnv = liveEnv): void {
  if (started) return;
  started = true;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message?.type;
    if (type !== NS_POPUP_LIST_MESSAGE && type !== NS_POPUP_OPEN_MESSAGE) return false;
    void handleNsPopupMessage(message, sender, env)
      .catch((): Reply => fail('open_failed'))
      .then((reply) => sendResponse(reply));
    return true;
  });
}
