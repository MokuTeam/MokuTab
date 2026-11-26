/**
 * The netsuite_session_* tools: the store client on one side, the profile's
 * cookies (through typed extension messages, never a tool) on the other.
 *
 * Every result is metadata only. Cookie values exist in this file only on
 * their way between the extension and the store; they are collected per call
 * and scrubbed from the free-text fields (note, error) of anything that
 * leaves. A username read from a vault item is never echoed: such a result
 * says user_source: vault instead.
 */

import { randomUUID } from 'crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NETSUITE_TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { scrubSecrets, type VaultUri } from '../../mcp/fn-vault';
import { fingerprint, normalizeAccount, type NsAccount } from './account';
import type { ExpectedUsers } from './expected-users';
import type { NsStoreClient, StoreAnswer } from './store-client';

const T = NETSUITE_TOOL_NAMES.NETSUITE_SESSION;
export const SESSION_COOKIE = 'JSESSIONID';
export const LOCK_POLL_MS = 3_000;
/** Below a function step's 120 s limit, so a login function's store step never times out first. */
export const MAX_LOCK_WAIT_MS = 110_000;
/** A checked vault username is reused this long (names only, never a password). */
export const VAULT_USER_TTL_MS = 10 * 60 * 1000;
/** A transparent publish waits this long for an open tab to tell the user, polling every 3 s. */
export const IDENTITY_WAIT_MS = 30_000;
export const IDENTITY_POLL_MS = 3_000;

function uriHost(uri: string): string | null {
  try {
    return new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `https://${uri}`,
    ).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a vault item is a login for this account: one of its URIs is the
 * account host itself or system.netsuite.com (the generic NetSuite login).
 * Stricter than Bitwarden's base-domain match, which takes any *.netsuite.com.
 */
export function vaultItemIsFor(uris: VaultUri[], host: string): boolean {
  return uris.some(({ uri, match }) => {
    if (match === 4 || match === 5) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) && !/^https?:\/\//i.test(uri)) return false;
    const h = uriHost(uri);
    return h === host || h === 'system.netsuite.com';
  });
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

export interface TabIdentity {
  user: string | null;
  role: string | null;
  role_id: string | null;
}

export interface NsDeps {
  store: NsStoreClient;
  users: ExpectedUsers;
  readCookies(profile: string, host: string): Promise<NsCookie[]>;
  writeCookies(profile: string, host: string, cookies: NsCookie[]): Promise<number>;
  tabIdentity(profile: string, host: string): Promise<TabIdentity | null>;
  /**
   * Whether the profile's session for the host is logged in: dead only when
   * card.nl lands on a login page of the host; unknown when that could not be
   * told (network, 429, 5xx, an older extension).
   */
  sessionState(profile: string, host: string): Promise<'alive' | 'dead' | 'unknown'>;
  vaultUris(item: string): Promise<VaultUri[]>;
  /** The username of a vault item (never its password). */
  vaultUsername(item: string): Promise<string>;
  /** Whether a vault item has a TOTP (never the secret); absent: not known. */
  vaultHasTotp?(item: string): Promise<boolean>;
  connectedProfiles(): string[];
  machine: string;
  sleep(ms: number): Promise<void>;
  now(): number;
}

type Json = Record<string, any>;
type UserSource = 'args' | 'vault' | 'remembered' | 'tab';
interface Who {
  user: string | null;
  source: UserSource | null;
}

class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function refusal(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

/** What a store answer means when it is no answer at all. */
function noStoreResult(answer: StoreAnswer | null, account?: string): Json | null {
  if (!answer) return null;
  if (answer.kind === 'unconfigured') {
    return {
      state: 'store_unconfigured',
      ...(account ? { account } : {}),
      note: 'This machine has no session store token: behave as without the store.',
    };
  }
  if (answer.kind === 'no_store') {
    return {
      state: 'no_store',
      ...(account ? { account } : {}),
      note: `${answer.reason}: behave as without the store.`,
    };
  }
  return null;
}

/** The body of a successful answer (null for any other). */
function bodyOf(answer: StoreAnswer): any {
  return answer.kind === 'ok' ? answer.body : null;
}

/** Drop anything value-shaped a store answer might carry, whatever the contract says. */
function metadataOnly(entry: Json): Json {
  const { cookies: _cookies, value: _value, ...rest } = entry ?? {};
  return rest;
}

/** An epoch-ms number, a numeric string or an ISO date; NaN for anything else. */
export function untilMs(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    return /^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
  }
  return NaN;
}

function sessionCookie(cookies: NsCookie[], host: string): NsCookie | undefined {
  const named = cookies.filter((c) => c.name === SESSION_COOKIE);
  return named.find((c) => c.domain === host) ?? named[0];
}

/** What the store gets: no hostOnly flag (a host-only cookie is a domain without the dot). */
function forStore(cookies: NsCookie[]): NsCookie[] {
  return cookies.map(({ hostOnly: _hostOnly, ...rest }) => rest);
}

function lockKey(account: string, user: string, profile: string): string {
  return `${account}\u0000${user.toLowerCase()}\u0000${profile}`;
}

export class NsSessionTools {
  /** lock_id per (account, user, profile) from the last lock, sent back on unlock. */
  private readonly lockIds = new Map<string, string>();
  /**
   * The run_id a lock was taken with when the caller named none: the store
   * needs one in every holder, and a relock or unlock must send the same.
   */
  private readonly runIds = new Map<string, string>();

  private runIdFor(key: string, given: unknown, create: boolean): string | undefined {
    if (typeof given === 'string' && given) return given;
    const known = this.runIds.get(key);
    if (known || !create) return known;
    const made = `auto-${randomUUID()}`;
    this.runIds.set(key, made);
    return made;
  }

  /** Per profile and host: the fp last published without a user (filled in by completeUser). */
  private readonly userless = new Map<string, string>();

  /** Checked vault usernames by item and host, with when they were read. */
  private readonly vaultUsers = new Map<string, { user: string | null; at: number }>();
  /** Whether a vault item has a TOTP, per item (no secret kept). */
  private readonly vaultTotp = new Map<string, { has: boolean; at: number }>();

  constructor(private readonly deps: NsDeps) {}

  owns(name: string): boolean {
    return (Object.values(T) as string[]).includes(name);
  }

  async call(name: string, args: Json, profile: string | null): Promise<CallToolResult> {
    const secrets: string[] = [];
    try {
      const body = await this.dispatch(name, args ?? {}, profile, secrets);
      // Only free text is scrubbed: a state or a name must never be rewritten.
      if (typeof body.note === 'string') body.note = scrubSecrets(body.note, secrets);
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (err: any) {
      const code = err instanceof ToolRefusal ? err.code : 'NetSuiteSessionError';
      return refusal(code, scrubSecrets(String(err?.message || err), secrets));
    }
  }

  private async dispatch(
    name: string,
    args: Json,
    profile: string | null,
    secrets: string[],
  ): Promise<Json> {
    if (!this.owns(name)) {
      throw new ToolRefusal('UnknownTool', `${name} is not a NetSuite session tool`);
    }
    const account = this.account(args, name !== T.STATUS);
    // No store: answer at once, before any vault read, cookie read or tab script.
    const early = noStoreResult(this.deps.store.precheck(), account?.account);
    if (early) return early;
    switch (name) {
      case T.STATUS:
        return this.status(account, this.softProfile(profile));
      case T.ENSURE:
        return this.ensure(account!, args, this.profile(profile), secrets);
      case T.PUBLISH:
        return this.publish(account!, args, this.profile(profile), secrets);
      case T.LOCK:
        return this.lock(account!, args, this.profile(profile));
      default:
        return this.unlock(account!, args, this.profile(profile));
    }
  }

  private account(args: Json, required: boolean): NsAccount | null {
    if (args.account === undefined && !required) return null;
    const parsed = normalizeAccount(args.account);
    if (!parsed) {
      throw new ToolRefusal('InvalidAccount', `not a NetSuite account id: ${String(args.account)}`);
    }
    return parsed;
  }

  /**
   * The profile the call is for: the one it names (or the session pin), else
   * the only connected one. With several connected and none named the call is
   * refused: a session must never land in whichever profile is the default.
   */
  private profile(profile: string | null): string {
    if (profile) return profile;
    const connected = this.deps.connectedProfiles();
    if (connected.length === 1) return connected[0];
    if (connected.length === 0) {
      throw new ToolRefusal('ProfileNotConnected', 'no Chrome profile is connected');
    }
    throw new ToolRefusal(
      'ProfileRequired',
      `${connected.length} Chrome profiles are connected (${connected.join(', ')}): pass profile`,
    );
  }

  /** The profile for a read that does not need one: named, pinned or the only connected. */
  private softProfile(profile: string | null): string | null {
    if (profile) return profile;
    const connected = this.deps.connectedProfiles();
    return connected.length === 1 ? connected[0] : null;
  }

  /**
   * The username of a vault item, only when the item is a login for this
   * account (vaultItemIsFor). Kept for VAULT_USER_TTL_MS per item and host, so
   * a login function's several store steps read the vault once.
   */
  private async vaultUser(item: unknown, account: NsAccount): Promise<string | null> {
    if (typeof item !== 'string' || !item) return null;
    const key = `${item}|${account.host}`;
    const cached = this.vaultUsers.get(key);
    if (cached && this.deps.now() - cached.at < VAULT_USER_TTL_MS) return cached.user;
    let uris: VaultUri[];
    try {
      uris = await this.deps.vaultUris(item);
    } catch (err: any) {
      throw new ToolRefusal('VaultError', String(err?.message || err));
    }
    if (!vaultItemIsFor(uris, account.host)) {
      throw new ToolRefusal(
        'VaultItemMismatch',
        `vault item ${item} is not a login for ${account.host} or system.netsuite.com; nothing was read from it`,
      );
    }
    let user: string | null;
    try {
      const name = await this.deps.vaultUsername(item);
      user = name ? name.trim().toLowerCase() : null;
    } catch (err: any) {
      throw new ToolRefusal('VaultError', String(err?.message || err));
    }
    this.vaultUsers.set(key, { user, at: this.deps.now() });
    return user;
  }

  /** Whether a checked vault item has a TOTP; null when that cannot be told. Cached like the username. */
  private async vaultHasTotp(item: unknown): Promise<boolean | null> {
    if (typeof item !== 'string' || !item || !this.deps.vaultHasTotp) return null;
    const cached = this.vaultTotp.get(item);
    if (cached && this.deps.now() - cached.at < VAULT_USER_TTL_MS) return cached.has;
    try {
      const has = await this.deps.vaultHasTotp(item);
      this.vaultTotp.set(item, { has, at: this.deps.now() });
      return has;
    } catch {
      return null;
    }
  }

  /** args.user, else the checked vault item's username, else the profile's remembered user. */
  private async who(args: Json, account: NsAccount, profile: string): Promise<Who> {
    if (typeof args.user === 'string' && args.user.trim()) {
      return { user: args.user.trim().toLowerCase(), source: 'args' };
    }
    const fromVault = await this.vaultUser(args.vault_item, account);
    if (fromVault) return { user: fromVault, source: 'vault' };
    const remembered = this.deps.users.get(profile, account.account);
    return remembered ? { user: remembered, source: 'remembered' } : { user: null, source: null };
  }

  /** How a result names the user: never a name read from the vault. */
  private userFields(user: string | null, source: UserSource | null): Json {
    if (source === 'vault') return { user_source: 'vault' };
    return { user: user ?? null, ...(source ? { user_source: source } : {}) };
  }

  private holder(profile: string, runId?: unknown) {
    return {
      machine: this.deps.machine,
      profile,
      ...(typeof runId === 'string' && runId ? { run_id: runId } : {}),
    };
  }

  private sameHolder(holder: any, profile: string): boolean {
    return holder?.machine === this.deps.machine && holder?.profile === profile;
  }

  async status(account: NsAccount | null, profile: string | null = null): Promise<Json> {
    const answer = await this.deps.store.request('GET', '/list', {
      query: { account: account?.account },
    });
    const none = noStoreResult(answer, account?.account);
    if (none) return none;
    if (answer.kind === 'error') {
      throw new ToolRefusal(answer.code, `the store refused the list (${answer.status})`);
    }
    const listed = bodyOf(answer)?.entries;
    const entries = Array.isArray(listed) ? listed.map(metadataOnly) : [];
    // Which user this profile takes for each account (names only): the
    // transparent import follows it, so it is shown, never silent.
    const expected = profile ? this.deps.users.all(profile) : null;
    return {
      state: 'ok',
      ...(account ? { account: account.account } : {}),
      entries,
      ...(profile && expected
        ? {
            profile,
            expected_users: account
              ? Object.fromEntries(
                  Object.entries(expected).filter(([acct]) => acct === account.account),
                )
              : expected,
          }
        : {}),
    };
  }

  // The popup's NetSuite sessions section (metadata only). Every failure is
  // a short code the popup maps to its own text: store_unreachable,
  // other_user, could_not_check, open_failed.

  /** The store's live and dying entries, as the popup lists them. */
  async popupList(): Promise<Json> {
    let result: Json;
    try {
      result = await this.status(null);
    } catch {
      return { ok: false, code: 'store_unreachable' };
    }
    if (result.state !== 'ok') return { ok: false, code: 'store_unreachable' };
    const time = (v: unknown): number | null => {
      const ms = untilMs(v);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    };
    const entries = (result.entries as Json[])
      .filter((e) => e?.state === 'live' || e?.state === 'dying')
      .map((e) => ({
        account: e.account,
        user: typeof e.user === 'string' ? e.user : null,
        role: e.role ?? null,
        state: e.state,
        abs_expiry: time(e.abs_expiry),
        idle_expiry: time(e.idle_expiry),
        last_activity: time(e.last_activity),
        last_where:
          e.last_where && typeof e.last_where === 'object'
            ? {
                machine: String(e.last_where.machine ?? ''),
                profile: String(e.last_where.profile ?? ''),
              }
            : null,
      }));
    return { ok: true, entries };
  }

  /**
   * The popup's click on an account (and user): open it in this profile,
   * logged in. A click is an explicit action, so the store's live user is
   * imported even when this profile remembers nobody for the account (and is
   * remembered after). A session this profile already has is replaced only
   * when a probe says it is logged out: alive with the same user just opens,
   * alive with another user or an unknown user, or a probe that could not
   * tell, changes nothing. Answers the URL the extension opens, never a value.
   */
  async popupOpen(payload: Json, profile: string): Promise<Json> {
    const account = normalizeAccount(String(payload?.account ?? ''));
    if (!account) return { ok: false, code: 'open_failed' };
    const wanted =
      typeof payload?.user === 'string' && payload.user.trim()
        ? payload.user.trim().toLowerCase()
        : null;
    const url = `https://${account.host}/app/center/card.nl`;
    const secrets: string[] = [];
    try {
      const listed = await this.status(account);
      if (listed.state !== 'ok') return { ok: false, code: 'store_unreachable' };
      const live = (listed.entries as Json[])
        .filter(
          (e) =>
            e?.account === account.account &&
            (e?.state === 'live' || e?.state === 'dying') &&
            (!wanted || (typeof e.user === 'string' && e.user.toLowerCase() === wanted)),
        )
        .sort((x, y) => (untilMs(y?.last_activity) || 0) - (untilMs(x?.last_activity) || 0));
      if (!live.length) return { ok: false, code: 'open_failed' };
      const user: string | null = typeof live[0].user === 'string' ? live[0].user : null;
      let local: string | null;
      try {
        local = await this.localFingerprint(account, profile);
      } catch {
        return { ok: false, code: 'could_not_check' };
      }
      if (local) {
        const state = await this.probe(account, profile);
        if (state === 'unknown') return { ok: false, code: 'could_not_check' };
        if (state === 'alive') {
          const identity = await this.deps.tabIdentity(profile, account.host).catch(() => null);
          const current = identity?.user
            ? identity.user.trim().toLowerCase()
            : this.deps.users.get(profile, account.account);
          if (!current || !user) return { ok: false, code: 'could_not_check' };
          if (current !== user.toLowerCase()) return { ok: false, code: 'other_user' };
          return { ok: true, url, action: 'opened' };
        }
      }
      const result = await this.ensureOnce(
        account,
        { user, source: user ? 'args' : null },
        profile,
        secrets,
      );
      if (result.state === 'imported' || result.state === 'already_live') {
        return { ok: true, url, action: result.state };
      }
      if (result.state === 'store_unconfigured' || result.state === 'no_store') {
        return { ok: false, code: 'store_unreachable' };
      }
      if (result.state === 'already_live_unverified') return { ok: false, code: 'could_not_check' };
      return { ok: false, code: 'open_failed' };
    } catch {
      return { ok: false, code: 'open_failed' };
    }
  }

  // Transparent mode (the extension reports a host; values never leave this
  // process except to the store and back to the extension).

  /** Whether the store can be used now (token present, not backing off). */
  storeReady(): boolean {
    return noStoreResult(this.deps.store.precheck()) === null;
  }

  /** The profile's session changed: publish it; login_at only right after a login. */
  async publishChanged(account: NsAccount, profile: string, afterLogin: boolean): Promise<Json> {
    const secrets: string[] = [];
    try {
      return await this.publish(
        account,
        { login_at: afterLogin, transparent: true },
        profile,
        secrets,
      );
    } catch (err: any) {
      return {
        state: 'error',
        code: err instanceof ToolRefusal ? err.code : 'NetSuiteSessionError',
      };
    }
  }

  /** Ensure for the profile's expected user (or the only live one): what a login landing runs. */
  async ensureExpected(account: NsAccount, profile: string): Promise<Json> {
    const secrets: string[] = [];
    const remembered = this.deps.users.get(profile, account.account);
    try {
      return await this.ensureOnce(
        account,
        { user: remembered, source: remembered ? 'remembered' : null },
        profile,
        secrets,
        false,
      );
    } catch (err: any) {
      return {
        state: 'error',
        code: err instanceof ToolRefusal ? err.code : 'NetSuiteSessionError',
      };
    }
  }

  /**
   * The profile's session was published without a user (no open tab then).
   * Once a tab tells the user, publish the same session again: the store
   * merges the user into the entry, so other machines can find it by user and
   * this profile remembers it. True when it published.
   */
  async completeUser(account: NsAccount, profile: string): Promise<boolean> {
    const key = `${profile}|${account.host}`;
    const pending = this.userless.get(key);
    if (!pending) return false;
    const fp = await this.localFingerprint(account, profile).catch(() => null);
    if (fp !== pending) {
      this.userless.delete(key);
      return false;
    }
    const identity = await this.deps.tabIdentity(profile, account.host).catch(() => null);
    if (!identity?.user) return false;
    const result = await this.publishChanged(account, profile, false);
    return result.state === 'published' || result.state === 'unchanged';
  }

  /** Whether the profile's session for the host is logged in (alive, dead or unknown). */
  async probe(account: NsAccount, profile: string): Promise<'alive' | 'dead' | 'unknown'> {
    try {
      return await this.deps.sessionState(profile, account.host);
    } catch {
      return 'unknown';
    }
  }

  /**
   * The store's live (or dying) entries for the account, metadata only:
   * {user, fp, origin}. Empty when the store cannot be asked.
   */
  async liveEntries(account: NsAccount, profile: string): Promise<Json[]> {
    const answer = await this.deps.store.request('GET', '/list', {
      query: { account: account.account },
      profile,
    });
    const listed = bodyOf(answer)?.entries;
    const entries: Json[] = Array.isArray(listed) ? listed : [];
    return entries
      .filter(
        (e) =>
          (e?.state === 'live' || e?.state === 'dying') &&
          (!e?.account || e.account === account.account),
      )
      .map((e) => ({ user: e.user ?? null, fp: e.fp ?? null, origin: e.origin ?? null }));
  }

  /** The user this profile remembers for the account, or null. */
  expectedUser(profile: string, account: NsAccount): string | null {
    return this.deps.users.get(profile, account.account);
  }

  /**
   * Whether the store has a live (or dying) entry for this account and user
   * that another machine or profile published: then a session this profile
   * has but the store does not know must not replace it (two live sessions
   * would take turns). With user null, any live entry of the account counts.
   */
  async liveElsewhere(account: NsAccount, profile: string): Promise<boolean> {
    const identity = await this.deps.tabIdentity(profile, account.host).catch(() => null);
    const user = identity?.user ? identity.user.trim().toLowerCase() : null;
    const answer = await this.deps.store.request('GET', '/list', {
      query: { account: account.account },
      profile,
    });
    const listed = bodyOf(answer)?.entries;
    const entries: Json[] = Array.isArray(listed) ? listed : [];
    return entries.some(
      (e) =>
        (e?.state === 'live' || e?.state === 'dying') &&
        (!user || !e.user || e.user === user) &&
        !(e?.origin?.machine === this.deps.machine && e?.origin?.profile === profile),
    );
  }

  /** The fingerprint of the profile's session cookie for the account, or null. */
  async localFingerprint(account: NsAccount, profile: string): Promise<string | null> {
    const cookies = await this.deps.readCookies(profile, account.host);
    const session = sessionCookie(cookies, account.host);
    return session && typeof session.value === 'string' ? fingerprint(session.value) : null;
  }

  /** POST /dead for a fingerprint; true when the store matched it. */
  async reportDead(
    account: NsAccount,
    fp: string,
    reason: 'login_redirect' | 'import_bounced' | 'switch' | 'logout' | 'expired',
    profile: string,
  ): Promise<boolean> {
    const answer = await this.deps.store.request('POST', '/dead', {
      body: {
        account: account.account,
        fp,
        reason,
        where: { machine: this.deps.machine, profile },
      },
      profile,
    });
    return answer.kind === 'ok' && bodyOf(answer)?.matched === true;
  }

  /** POST /touch for the profile's session: matched true/false, or null without a session. */
  async touch(account: NsAccount, profile: string): Promise<boolean | null> {
    const fp = await this.localFingerprint(account, profile);
    if (!fp) return null;
    const answer = await this.deps.store.request('POST', '/touch', {
      body: {
        account: account.account,
        fp,
        where: { machine: this.deps.machine, profile },
        at: this.deps.now(),
      },
      profile,
    });
    if (answer.kind !== 'ok') return null;
    return bodyOf(answer)?.matched === true;
  }

  async ensure(account: NsAccount, args: Json, profile: string, secrets: string[]): Promise<Json> {
    // Resolved once: polling a lock never reads the vault again.
    const who = await this.who(args, account, profile);
    const deadline = this.deps.now() + MAX_LOCK_WAIT_MS;
    for (;;) {
      const result = await this.ensureOnce(account, who, profile, secrets);
      if (result.state !== 'locked_by' || args.wait_for_lock !== true) return result;
      const until = untilMs(result.until);
      const stop = Number.isFinite(until) ? Math.min(until, deadline) : this.deps.now();
      if (this.deps.now() >= stop) return result;
      await this.deps.sleep(LOCK_POLL_MS);
    }
  }

  private async ensureOnce(
    account: NsAccount,
    who: Who,
    profile: string,
    secrets: string[],
    pickAmbiguous = true,
  ): Promise<Json> {
    let user = who.user;
    let source = who.source;
    const notes: string[] = [];
    let answer = await this.deps.store.request('GET', '/entry', {
      query: { account: account.account, user: user ?? undefined },
      profile,
    });
    if (answer.kind === 'error' && answer.code === 'ambiguous_user' && !user) {
      if (!pickAmbiguous) {
        return { state: 'several_users', account: account.account };
      }
      const users = Array.isArray(answer.body?.users) ? answer.body.users : [];
      const newest = [...users].sort(
        (a, b) => (untilMs(b?.last_activity) || 0) - (untilMs(a?.last_activity) || 0),
      )[0];
      if (typeof newest?.user === 'string') {
        user = newest.user;
        source = null;
        notes.push(
          `${users.length} users have a live session for ${account.account}; took the most recently active one and this profile will expect it from now on.`,
        );
        answer = await this.deps.store.request('GET', '/entry', {
          query: { account: account.account, user: user ?? undefined },
          profile,
        });
      }
    }
    const none = noStoreResult(answer, account.account);
    if (none) return none;
    if (answer.kind === 'error') {
      if (answer.code === 'none' || answer.status === 404) {
        return this.noneOrLocked(account, user, source, profile);
      }
      throw new ToolRefusal(answer.code, `the store refused the entry (${answer.status})`);
    }
    const entry = bodyOf(answer) ?? {};
    const cookies: NsCookie[] = Array.isArray(entry.cookies) ? entry.cookies : [];
    for (const c of cookies) if (typeof c?.value === 'string') secrets.push(c.value);
    const remote = sessionCookie(cookies, account.host);
    if (!remote || typeof remote.value !== 'string') {
      throw new ToolRefusal('StoreEntryInvalid', 'the store entry has no session cookie');
    }
    const fp = fingerprint(remote.value);
    const entryUser: string | null = typeof entry.user === 'string' ? entry.user : user;
    const meta = {
      account: account.account,
      ...this.userFields(entryUser, source),
      role: entry.role ?? null,
      fp,
      generation: entry.generation ?? null,
      login_at: entry.login_at ?? null,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
    const local = await this.deps.readCookies(profile, account.host);
    for (const c of local) if (typeof c?.value === 'string') secrets.push(c.value);
    const localSession = sessionCookie(local, account.host);
    if (localSession && fingerprint(localSession.value) === fp) {
      const probed = await this.deps.sessionState(profile, account.host);
      if (probed === 'alive') {
        if (entryUser) this.deps.users.set(profile, account.account, entryUser);
        return { state: 'already_live', ...meta };
      }
      if (probed === 'unknown') {
        // Not known to be dead: never reported, and nothing to import (same session).
        return {
          state: 'already_live_unverified',
          ...meta,
          note: 'this profile already has the store session; whether it is logged in could not be checked (reload the page to see).',
        };
      }
      // The profile has the store's session and it lands on the login page: it is dead.
      await this.deps.store.request('POST', '/dead', {
        body: {
          account: account.account,
          fp,
          reason: 'login_redirect',
          where: { machine: this.deps.machine, profile },
        },
        profile,
      });
      return {
        state: 'none',
        account: account.account,
        ...this.userFields(entryUser, source),
        note: "the store's session for this account is the one this profile has, and it is logged out (reported dead): log in, then netsuite_session_publish.",
      };
    }
    const written = await this.deps.writeCookies(profile, account.host, cookies);
    if (written < cookies.length) {
      return {
        state: 'partial_import',
        ...meta,
        cookies_set: written,
        cookies_total: cookies.length,
        note: 'Chrome refused some cookies; the session may not work: reload and check, or log in.',
      };
    }
    if (entryUser) this.deps.users.set(profile, account.account, entryUser);
    return { state: 'imported', ...meta, cookies_set: written, next: 'reload the NetSuite page' };
  }

  private async noneOrLocked(
    account: NsAccount,
    user: string | null,
    source: UserSource | null,
    profile: string,
  ): Promise<Json> {
    const answer = await this.deps.store.request('GET', '/list', {
      query: { account: account.account },
      profile,
    });
    const listed = bodyOf(answer)?.entries;
    const entries: Json[] = Array.isArray(listed) ? listed : [];
    const locked = entries.find(
      (e) =>
        e?.lock &&
        (!user || !e.user || e.user === user) &&
        !this.sameHolder(e.lock.holder, profile),
    );
    if (locked) {
      return {
        state: 'locked_by',
        account: account.account,
        ...this.userFields(locked.user ?? user, source),
        holder: locked.lock.holder,
        until: locked.lock.until,
      };
    }
    return {
      state: 'none',
      account: account.account,
      ...(user ? this.userFields(user, source) : {}),
      next: 'log in, then netsuite_session_publish',
    };
  }

  async publish(account: NsAccount, args: Json, profile: string, secrets: string[]): Promise<Json> {
    const cookies = await this.deps.readCookies(profile, account.host);
    for (const c of cookies) if (typeof c?.value === 'string') secrets.push(c.value);
    const session = sessionCookie(cookies, account.host);
    if (!session) {
      return {
        state: 'no_session',
        account: account.account,
        note: `no ${SESSION_COOKIE} for ${account.host} in this profile`,
      };
    }
    const probed = await this.deps.sessionState(profile, account.host);
    if (probed === 'dead') {
      return {
        state: 'no_session',
        account: account.account,
        note: `the session of ${account.host} in this profile is logged out; nothing was sent`,
      };
    }
    if (probed === 'unknown') {
      return {
        state: 'probe_unknown',
        account: account.account,
        note: 'whether the session is logged in could not be checked; nothing was sent: try again.',
      };
    }
    // The tab's user first; with a vault item too, both must be the same user.
    let identity = await this.deps.tabIdentity(profile, account.host).catch(() => null);
    if (args.transparent === true) {
      // A tab right after a login may still be loading: wait for it a while
      // rather than store a session without its user.
      for (let waited = 0; !identity?.user && waited < IDENTITY_WAIT_MS; ) {
        await this.deps.sleep(IDENTITY_POLL_MS);
        waited += IDENTITY_POLL_MS;
        identity = await this.deps.tabIdentity(profile, account.host).catch(() => null);
      }
    }
    const tabUser = identity?.user ? identity.user.trim().toLowerCase() : null;
    const fromVault = await this.vaultUser(args.vault_item, account);
    if (tabUser && fromVault && tabUser !== fromVault) {
      throw new ToolRefusal(
        'UserMismatch',
        "the account's open tab is logged in as another user than the vault item's; nothing was sent",
      );
    }
    let who: Who;
    if (tabUser) who = { user: tabUser, source: 'tab' };
    else if (args.transparent === true) {
      // Reported by the extension, not asked for: without an open tab the user
      // is not known, and a remembered user may be someone else's session.
      who = { user: null, source: null };
    } else if (fromVault) who = { user: fromVault, source: 'vault' };
    else if (typeof args.user === 'string' && args.user.trim()) {
      who = { user: args.user.trim().toLowerCase(), source: 'args' };
    } else {
      const remembered = this.deps.users.get(profile, account.account);
      who = { user: remembered, source: remembered ? 'remembered' : null };
    }
    const fp = fingerprint(session.value);
    const now = this.deps.now();
    // Whether this account can be renewed without a person (the item has a
    // TOTP): only from an explicit publish with a vault item that passed the
    // check above; a transparent publish cannot know and leaves it out.
    const autoRenew =
      args.transparent !== true && fromVault ? await this.vaultHasTotp(args.vault_item) : null;
    const answer = await this.deps.store.request('POST', '/entry', {
      body: {
        account: account.account,
        user: who.user,
        host: account.host,
        role: identity?.role ?? null,
        role_id: identity?.role_id ?? null,
        fp,
        cookies: forStore(cookies),
        origin: { machine: this.deps.machine, profile },
        login_at: args.login_at === true ? now : null,
        seen_at: now,
        ...(typeof autoRenew === 'boolean' ? { auto_renew: autoRenew } : {}),
      },
      profile,
    });
    const none = noStoreResult(answer, account.account);
    if (none) return none;
    if (answer.kind === 'error') {
      if (answer.code === 'store_full') {
        return {
          state: 'no_store',
          account: account.account,
          note: 'the store is full (409 store_full): behave as without the store.',
        };
      }
      if (answer.code === 'dead_fp') {
        return {
          state: 'dead_session',
          account: account.account,
          fp,
          note: 'the store already saw this session die: log in again.',
        };
      }
      throw new ToolRefusal(answer.code, `the store refused the publish (${answer.status})`);
    }
    if (who.user) this.deps.users.set(profile, account.account, who.user);
    // A session stored without its user is filled in later (completeUser).
    const key = `${profile}|${account.host}`;
    if (who.user) this.userless.delete(key);
    else this.userless.set(key, fp);
    return {
      state: bodyOf(answer)?.stored === false ? 'unchanged' : 'published',
      account: account.account,
      ...this.userFields(who.user, who.source),
      role: identity?.role ?? null,
      fp,
      generation: bodyOf(answer)?.generation ?? null,
    };
  }

  async lock(account: NsAccount, args: Json, profile: string): Promise<Json> {
    const who = await this.who(args, account, profile);
    if (!who.user) throw new ToolRefusal('UserRequired', 'the lock needs user or vault_item');
    const ttl = Math.max(10, Math.min(120, Number(args.ttl_s) || 120));
    const runId = this.runIdFor(lockKey(account.account, who.user, profile), args.run_id, true);
    const answer = await this.deps.store.request('POST', '/lock', {
      body: {
        account: account.account,
        user: who.user,
        holder: this.holder(profile, runId),
        ttl_s: ttl,
      },
      profile,
    });
    const none = noStoreResult(answer, account.account);
    if (none) return none;
    if (answer.kind === 'error') {
      if (answer.code === 'locked') {
        return {
          state: 'locked_by',
          account: account.account,
          ...this.userFields(who.user, who.source),
          holder: answer.body?.holder ?? null,
          until: answer.body?.until ?? null,
        };
      }
      throw new ToolRefusal(answer.code, `the store refused the lock (${answer.status})`);
    }
    // The lock handle stays in the bridge (never in a result): unlock sends it back.
    const lockId = bodyOf(answer)?.lock_id;
    if (typeof lockId === 'string' && lockId) {
      this.lockIds.set(lockKey(account.account, who.user, profile), lockId);
    }
    return {
      state: 'locked',
      account: account.account,
      ...this.userFields(who.user, who.source),
      until: bodyOf(answer)?.until ?? null,
    };
  }

  async unlock(account: NsAccount, args: Json, profile: string): Promise<Json> {
    const who = await this.who(args, account, profile);
    if (!who.user) throw new ToolRefusal('UserRequired', 'the unlock needs user or vault_item');
    const key = lockKey(account.account, who.user, profile);
    const lockId = this.lockIds.get(key);
    const runId = this.runIdFor(key, args.run_id, false);
    this.lockIds.delete(key);
    this.runIds.delete(key);
    // Both the handle and the holder: the store matches on whichever it keeps.
    const answer = await this.deps.store.request('POST', '/unlock', {
      body: {
        account: account.account,
        user: who.user,
        ...(lockId ? { lock_id: lockId } : {}),
        holder: this.holder(profile, runId),
      },
      profile,
    });
    const none = noStoreResult(answer, account.account);
    if (none) return none;
    if (answer.kind === 'error') {
      throw new ToolRefusal(answer.code, `the store refused the unlock (${answer.status})`);
    }
    return {
      state: 'unlocked',
      account: account.account,
      ...this.userFields(who.user, who.source),
    };
  }
}
