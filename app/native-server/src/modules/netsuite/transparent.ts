/**
 * NetSuite session store, transparent mode, bridge side: what the extension
 * reports on its own (a session cookie changed, a login page landed, the
 * account was used, a logout started) and what the bridge does about it.
 * Every report carries a host, never a value; the cookies are read and
 * written through the phase 1 paths.
 *
 * Nothing here overwrites a live session: before an import or a bounce
 * report the profile's own session is checked, and only a dead one (or none)
 * is replaced. A profile with no expected user imports on its own when the
 * store has one live user for the account, and remembers it; with two or more
 * it does nothing.
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
  /** Per profile, host and tab: when a tab was last sent on because the session was live. */
  private readonly liveNavigations = new Map<string, number>();

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

  /**
   * A live session is already there: a tab just goes on to its target, once
   * per tab in IMPORT_GUARD_MS (a page that keeps coming back to the login
   * form is not sent on in a loop).
   */
  private alreadyLive(account: NsAccount, payload: any, profile: string): Json {
    if (payload?.kind !== 'tab') return { action: 'none', reason: 'already_live' };
    const key = `${profile}|${account.host}|${String(payload?.tab_id ?? '')}`;
    const now = this.deps.now();
    const last = this.liveNavigations.get(key);
    if (last !== undefined && now - last < IMPORT_GUARD_MS) {
      return { action: 'none', reason: 'loop_guard' };
    }
    this.liveNavigations.set(key, now);
    return {
      action: 'navigate',
      url: targetUrl(account.host, payload?.target),
      reason: 'already_live',
    };
  }

  /** ns_session_changed {host, after_login?}: publish the new session (user from the tab only). */
  async onChanged(payload: any, profile: string): Promise<Json> {
    const account = this.ready(payload);
    if ('reason' in account) return { state: 'skipped', reason: account.reason };
    const result = await this.tools.publishChanged(account, profile, payload?.after_login === true);
    return { state: result.state ?? 'error' };
  }

  /**
   * ns_login_landing {host, kind: tab|fetch, target?}: a page or a background
   * request of the profile landed on the account's login page.
   * - Its own session is logged in after all (a stale page, a second tab):
   *   no import; a tab goes on to its target.
   * - Its own session is unknown: leave it alone.
   * - Its session is dead or missing: if the profile has no remembered user,
   *   import only when the store has one live user for the account (and
   *   remember it); with two or more, do nothing. If the dead local session's
   *   fp matches a live store entry, report it dead (login_redirect) before
   *   ensuring once more for a newer generation.
   * When the session this guard imported is found dead on a new landing, it is
   * reported dead (import_bounced) and the store is asked once more.
   */
  async onLanding(payload: any, profile: string): Promise<Json> {
    const account = this.ready(payload);
    if ('reason' in account) return { action: 'none', reason: account.reason };
    const expected = this.tools.expectedUser(profile, account);
    const key = `${profile}|${account.host}`;
    const now = this.deps.now();
    const last = this.imports.get(key);
    const local = await this.tools.localFingerprint(account, profile).catch(() => null);
    let live: Array<Record<string, any>> | null = null;
    let bounced = false;
    if (local) {
      const state = await this.tools.probe(account, profile);
      if (state === 'alive') return this.alreadyLive(account, payload, profile);
      if (state === 'unknown') return { action: 'none', reason: 'probe_unknown' };
      // Dead. The session this guard just imported: report it, once.
      if (last && now - last.at < IMPORT_GUARD_MS) {
        if (last.retried || local !== last.fp) return { action: 'none', reason: 'loop_guard' };
        await this.tools.reportDead(account, local, 'import_bounced', profile).catch(() => false);
        bounced = true;
        last.retried = true;
      } else {
        // The store still offers this very session (any user, also none) as
        // live: it is dead, say so, and ask for a newer one below.
        live = await this.tools.liveEntries(account, profile).catch(() => []);
        if (live.some((e) => e.fp === local)) {
          const killed = await this.tools
            .reportDead(account, local, 'login_redirect', profile)
            .catch(() => false);
          if (killed) live = null;
        }
      }
    } else if (last && now - last.at < IMPORT_GUARD_MS) {
      return { action: 'none', reason: 'loop_guard' };
    }
    // A profile that never took this account takes it on its own only when
    // the store has exactly one live user for it; with two or more the
    // popup or an explicit ensure decides.
    if (!expected) {
      live ??= await this.tools.liveEntries(account, profile).catch(() => []);
      const users = new Set(
        live.map((e) => (typeof e.user === 'string' ? e.user.trim().toLowerCase() : '')),
      );
      if (users.size === 0) return { action: 'none', reason: 'none' };
      if (users.size > 1) return { action: 'none', reason: 'several_users' };
    }
    const result = await this.tools.ensureExpected(account, profile);
    if (result.state === 'already_live') return this.alreadyLive(account, payload, profile);
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
      // The store does not know this session. Publish it only when no other
      // machine or profile holds a live one for the same user.
      if (await this.tools.liveElsewhere(account, profile).catch(() => true)) {
        return { state: 'skipped', reason: 'live_elsewhere' };
      }
      const published = await this.tools.publishChanged(account, profile, false);
      return { state: 'published', publish: published.state ?? 'error' };
    }
    if (matched === true) {
      // Published earlier without its user: complete it once a tab tells who.
      const completed = await this.tools.completeUser(account, profile).catch(() => false);
      return completed ? { state: 'touched', completed_user: true } : { state: 'touched' };
    }
    return { state: 'no_session' };
  }

  /**
   * ns_session_ending {host, reason}: only a logout ends the session for every
   * machine. A role or account switch reports nothing: the next publish
   * replaces the entry, and another account's host stays alive.
   */
  async onEnding(payload: any, profile: string): Promise<Json> {
    const account = this.ready(payload);
    if ('reason' in account) return { state: 'skipped', reason: account.reason };
    if (payload?.reason !== 'logout') return { state: 'ignored', reason: 'switch' };
    const fp = await this.tools.localFingerprint(account, profile).catch(() => null);
    if (!fp) return { state: 'no_session' };
    const matched = await this.tools.reportDead(account, fp, 'logout', profile).catch(() => false);
    this.imports.delete(`${profile}|${account.host}`);
    return { state: matched ? 'reported' : 'not_in_store', reason: 'logout' };
  }
}
