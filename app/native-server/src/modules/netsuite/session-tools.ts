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

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NETSUITE_TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { pageMatchesVaultUris, scrubSecrets, type VaultUri } from '../../mcp/fn-vault';
import { fingerprint, normalizeAccount, type NsAccount } from './account';
import type { ExpectedUsers } from './expected-users';
import type { NsStoreClient, StoreAnswer } from './store-client';

const T = NETSUITE_TOOL_NAMES.NETSUITE_SESSION;
export const SESSION_COOKIE = 'JSESSIONID';
export const LOCK_POLL_MS = 3_000;
/** Below a function step's 120 s limit, so a login function's store step never times out first. */
export const MAX_LOCK_WAIT_MS = 110_000;

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
  /** Whether the profile's session for the host is logged in (card.nl does not land on a login page). */
  sessionAlive(profile: string, host: string): Promise<boolean>;
  vaultUris(item: string): Promise<VaultUri[]>;
  /** The username of a vault item (never its password). */
  vaultUsername(item: string): Promise<string>;
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

export class NsSessionTools {
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
        return this.status(account);
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

  /** The username of a vault item, only when the item is for this account's site. */
  private async vaultUser(item: unknown, account: NsAccount): Promise<string | null> {
    if (typeof item !== 'string' || !item) return null;
    let uris: VaultUri[];
    try {
      uris = await this.deps.vaultUris(item);
    } catch (err: any) {
      throw new ToolRefusal('VaultError', String(err?.message || err));
    }
    if (!pageMatchesVaultUris(`https://${account.host}/`, uris)) {
      throw new ToolRefusal(
        'VaultItemMismatch',
        `vault item ${item} is not a login for ${account.host}; nothing was read from it`,
      );
    }
    try {
      const name = await this.deps.vaultUsername(item);
      return name ? name.trim().toLowerCase() : null;
    } catch (err: any) {
      throw new ToolRefusal('VaultError', String(err?.message || err));
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

  async status(account: NsAccount | null): Promise<Json> {
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
    return { state: 'ok', ...(account ? { account: account.account } : {}), entries };
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
  ): Promise<Json> {
    let user = who.user;
    let source = who.source;
    const notes: string[] = [];
    let answer = await this.deps.store.request('GET', '/entry', {
      query: { account: account.account, user: user ?? undefined },
      profile,
    });
    if (answer.kind === 'error' && answer.code === 'ambiguous_user' && !user) {
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
      if (await this.deps.sessionAlive(profile, account.host)) {
        if (entryUser) this.deps.users.set(profile, account.account, entryUser);
        return { state: 'already_live', ...meta };
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
    if (!(await this.deps.sessionAlive(profile, account.host))) {
      return {
        state: 'no_session',
        account: account.account,
        note: `the session of ${account.host} in this profile is logged out; nothing was sent`,
      };
    }
    // The same user ensure and lock use: the checked vault item's, else the tab's.
    const identity = await this.deps.tabIdentity(profile, account.host).catch(() => null);
    const fromVault = await this.vaultUser(args.vault_item, account);
    let who: Who;
    if (fromVault) who = { user: fromVault, source: 'vault' };
    else if (identity?.user) who = { user: identity.user.toLowerCase(), source: 'tab' };
    else if (typeof args.user === 'string' && args.user.trim()) {
      who = { user: args.user.trim().toLowerCase(), source: 'args' };
    } else {
      const remembered = this.deps.users.get(profile, account.account);
      who = { user: remembered, source: remembered ? 'remembered' : null };
    }
    const fp = fingerprint(session.value);
    const now = this.deps.now();
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
    const answer = await this.deps.store.request('POST', '/lock', {
      body: {
        account: account.account,
        user: who.user,
        holder: this.holder(profile, args.run_id),
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
    const answer = await this.deps.store.request('POST', '/unlock', {
      body: { account: account.account, user: who.user, holder: this.holder(profile, args.run_id) },
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
