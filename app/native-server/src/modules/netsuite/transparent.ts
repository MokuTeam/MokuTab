/**
 * NetSuite session store, transparent mode, bridge side: what the extension
 * reports on its own (a session cookie changed, a login page landed, the
 * account was used, a role or account switch or a logout started) and what
 * the bridge does about it. Every report carries a host, never a value; the
 * cookies are read and written through the phase 1 paths.
 */

import { accountFromHost, type NsAccount } from './account';
import type { NsSessionTools } from './session-tools';

/** One import per host and profile in this window (plus one retry after a bounce). */
export const IMPORT_GUARD_MS = 60_000;
/** At most one POST /touch per host and profile in this window. */
export const TOUCH_EVERY_MS = 2 * 60_000;

const LOGIN_PATH = /\/app\/login\/|\/pages\/customerlogin|loginchallenge|\/next\/app\/login\//i;
const DEFAULT_TARGET = '/app/center/card.nl';

type Json = Record<string, any>;

export interface NsTransparentDeps {
  /** Whether the netsuite module is on (read per report: it can change at any time). */
  isOn(): boolean;
  now(): number;
}

/** Where a tab goes after an import: its own target path, or the home card. */
export function targetUrl(host: string, target: unknown): string {
  const path =
    typeof target === 'string' &&
    target.startsWith('/') &&
    !target.startsWith('//') &&
    !/[\s\\]/.test(target) &&
    !LOGIN_PATH.test(target.split('?')[0])
      ? target
      : DEFAULT_TARGET;
  return `https://${host}${path}`;
}

export class NsTransparent {
  private readonly imports = new Map<string, { fp: string; at: number; retried: boolean }>();
  private readonly touches = new Map<string, number>();

  constructor(
    private readonly tools: NsSessionTools,
    private readonly deps: NsTransparentDeps,
  ) {}

  /** The account of a reported host, when the module is on and the store usable. */
  private ready(payload: any): NsAccount | { reason: string } {
    if (!this.deps.isOn()) return { reason: 'module_off' };
    const account = accountFromHost(payload?.host);
    if (!account) return { reason: 'not_an_account_host' };
    if (!this.tools.storeReady()) return { reason: 'no_store' };
    return account;
  }

  /** ns_session_changed {host, after_login?}: publish the new session. */
  async onChanged(payload: any, profile: string): Promise<Json> {
    const account = this.ready(payload);
    if ('reason' in account) return { state: 'skipped', reason: account.reason };
    const result = await this.tools.publishChanged(account, profile, payload?.after_login === true);
    return { state: result.state ?? 'error' };
  }

  /**
   * ns_login_landing {host, kind: tab|fetch, target?}: a page or a background
   * request of the profile landed on the account's login page. Take the
   * store's live session for the expected user; a tab then goes to its target.
   * When the same tab lands on the login page again with the session this
   * very guard imported, that session is reported dead (import_bounced) and
   * the store is asked once more: a newer session may be there.
   */
  async onLanding(payload: any, profile: string): Promise<Json> {
    const account = this.ready(payload);
    if ('reason' in account) return { action: 'none', reason: account.reason };
    const key = `${profile}|${account.host}`;
    const now = this.deps.now();
    const last = this.imports.get(key);
    let bounced = false;
    if (last && now - last.at < IMPORT_GUARD_MS) {
      if (last.retried) return { action: 'none', reason: 'loop_guard' };
      const local = await this.tools.localFingerprint(account, profile).catch(() => null);
      if (!local || local !== last.fp) return { action: 'none', reason: 'loop_guard' };
      await this.tools.reportDead(account, local, 'import_bounced', profile).catch(() => false);
      bounced = true;
      last.retried = true;
    }
    const result = await this.tools.ensureExpected(account, profile);
    if (result.state !== 'imported' || (bounced && result.fp === last?.fp)) {
      return { action: 'none', reason: String(result.state ?? 'error') };
    }
    this.imports.set(key, { fp: result.fp, at: now, retried: bounced });
    return payload?.kind === 'tab'
      ? { action: 'navigate', url: targetUrl(account.host, payload?.target), fp: result.fp }
      : { action: 'imported', fp: result.fp };
  }

  /** ns_activity {host}: the account was used; tell the store, at most every 2 minutes. */
  async onActivity(payload: any, profile: string): Promise<Json> {
    const account = this.ready(payload);
    if ('reason' in account) return { state: 'skipped', reason: account.reason };
    const key = `${profile}|${account.host}`;
    const now = this.deps.now();
    const last = this.touches.get(key);
    if (last !== undefined && now - last < TOUCH_EVERY_MS) return { state: 'throttled' };
    this.touches.set(key, now);
    const matched = await this.tools.touch(account, profile).catch(() => null);
    if (matched === false) {
      // The store does not know this session: publish it.
      const published = await this.tools.publishChanged(account, profile, false);
      return { state: 'published', publish: published.state ?? 'error' };
    }
    return { state: matched === true ? 'touched' : 'no_session' };
  }

  /** ns_session_ending {host, reason: switch|logout}: the session is about to end. */
  async onEnding(payload: any, profile: string): Promise<Json> {
    const account = this.ready(payload);
    if ('reason' in account) return { state: 'skipped', reason: account.reason };
    const reason = payload?.reason === 'logout' ? 'logout' : 'switch';
    const fp = await this.tools.localFingerprint(account, profile).catch(() => null);
    if (!fp) return { state: 'no_session' };
    const matched = await this.tools.reportDead(account, fp, reason, profile).catch(() => false);
    this.imports.delete(`${profile}|${account.host}`);
    return { state: matched ? 'reported' : 'not_in_store', reason };
  }
}
