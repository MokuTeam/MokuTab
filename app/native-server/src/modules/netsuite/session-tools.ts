/**
 * The netsuite_session_* tools: the store client on one side, the profile's
 * cookies (through typed extension messages, never a tool) on the other.
 *
 * Every result is metadata only. Cookie values exist in this file only on
 * their way between the extension and the store; they are collected per call
 * and scrubbed from anything that could leave as a result or an error.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NETSUITE_TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { scrubSecrets } from '../../mcp/fn-vault';
import { fingerprint, normalizeAccount, type NsAccount } from './account';
import type { ExpectedUsers } from './expected-users';
import type { NsStoreClient, StoreAnswer } from './store-client';

const T = NETSUITE_TOOL_NAMES.NETSUITE_SESSION;
export const SESSION_COOKIE = 'JSESSIONID';
export const LOCK_POLL_MS = 3_000;
const MAX_LOCK_WAIT_MS = 125_000;

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
  /** The username of a vault item (never its password). */
  vaultUsername(item: string): Promise<string>;
  /** The profile a call runs in (null: none connected). */
  resolveProfile(profile: string | null): string | null;
  machine: string;
  sleep(ms: number): Promise<void>;
  now(): number;
}

type Json = Record<string, any>;

class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function ok(body: Json): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

function refusal(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

/** What a store answer means when it is no answer at all. */
function noStoreResult(answer: StoreAnswer, account?: string): Json | null {
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

/** Drop anything value-shaped a store answer might carry, whatever the contract says. */
function metadataOnly(entry: Json): Json {
  const { cookies: _cookies, value: _value, ...rest } = entry ?? {};
  return rest;
}

/** The body of a successful answer (null for any other). */
function bodyOf(answer: StoreAnswer): any {
  return answer.kind === 'ok' ? answer.body : null;
}

function sessionCookie(cookies: NsCookie[], host: string): NsCookie | undefined {
  const named = cookies.filter((c) => c.name === SESSION_COOKIE);
  return named.find((c) => c.domain === host) ?? named[0];
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
      return ok(scrubSecrets(body, secrets));
    } catch (err: any) {
      const code = err instanceof ToolRefusal ? err.code : 'NetSuiteSessionError';
      return refusal(code, scrubSecrets(String(err?.message || err), secrets));
    }
  }

  private dispatch(
    name: string,
    args: Json,
    profile: string | null,
    secrets: string[],
  ): Promise<Json> {
    switch (name) {
      case T.STATUS:
        return this.status(args);
      case T.ENSURE:
        return this.ensure(args, profile, secrets);
      case T.PUBLISH:
        return this.publish(args, profile, secrets);
      case T.LOCK:
        return this.lock(args, profile);
      case T.UNLOCK:
        return this.unlock(args, profile);
      default:
        throw new ToolRefusal('UnknownTool', `${name} is not a NetSuite session tool`);
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

  private profile(profile: string | null): string {
    const resolved = this.deps.resolveProfile(profile);
    if (!resolved) throw new ToolRefusal('ProfileNotConnected', 'no Chrome profile is connected');
    return resolved;
  }

  private async userOf(args: Json): Promise<string | null> {
    if (typeof args.user === 'string' && args.user.trim()) return args.user.trim().toLowerCase();
    if (typeof args.vault_item === 'string' && args.vault_item) {
      const name = await this.deps.vaultUsername(args.vault_item);
      return name ? name.trim().toLowerCase() : null;
    }
    return null;
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

  async status(args: Json): Promise<Json> {
    const account = this.account(args, false);
    const answer = await this.deps.store.request('GET', '/list', {
      query: { account: account?.account },
    });
    const none = noStoreResult(answer, account?.account);
    if (none) return none;
    if (answer.kind === 'error')
      throw new ToolRefusal(answer.code, `the store refused the list (${answer.status})`);
    const listed = bodyOf(answer)?.entries;
    const entries = Array.isArray(listed) ? listed.map(metadataOnly) : [];
    return { state: 'ok', ...(account ? { account: account.account } : {}), entries };
  }

  async ensure(args: Json, callProfile: string | null, secrets: string[]): Promise<Json> {
    const account = this.account(args, true)!;
    const profile = this.profile(callProfile);
    const deadline = this.deps.now() + MAX_LOCK_WAIT_MS;
    for (;;) {
      const result = await this.ensureOnce(account, args, profile, secrets);
      if (result.state !== 'locked_by' || args.wait_for_lock !== true) return result;
      const until = Date.parse(result.until ?? '') || this.deps.now();
      if (this.deps.now() >= Math.min(until, deadline)) return result;
      await this.deps.sleep(LOCK_POLL_MS);
    }
  }

  private async ensureOnce(
    account: NsAccount,
    args: Json,
    profile: string,
    secrets: string[],
  ): Promise<Json> {
    const asked = await this.userOf(args);
    let user = asked ?? this.deps.users.get(profile, account.account);
    const notes: string[] = [];
    let answer = await this.deps.store.request('GET', '/entry', {
      query: { account: account.account, user: user ?? undefined },
    });
    if (answer.kind === 'error' && answer.code === 'ambiguous_user' && !asked) {
      const users = Array.isArray(answer.body?.users) ? answer.body.users : [];
      const newest = [...users].sort(
        (a, b) =>
          (Date.parse(b?.last_activity) || Number(b?.last_activity) || 0) -
          (Date.parse(a?.last_activity) || Number(a?.last_activity) || 0),
      )[0];
      if (typeof newest?.user === 'string') {
        user = newest.user;
        notes.push(
          `${users.length} users have a live session for ${account.account}; took the most recently active one (${user}) and this profile will expect it from now on.`,
        );
        answer = await this.deps.store.request('GET', '/entry', {
          query: { account: account.account, user: user ?? undefined },
        });
      }
    }
    const none = noStoreResult(answer, account.account);
    if (none) return none;
    if (answer.kind === 'error') {
      if (answer.code === 'none' || answer.status === 404)
        return this.noneOrLocked(account, user, profile);
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
    const meta = {
      account: account.account,
      user: entry.user ?? user ?? null,
      role: entry.role ?? null,
      fp,
      generation: entry.generation ?? null,
      login_at: entry.login_at ?? null,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
    const local = await this.deps.readCookies(profile, account.host);
    for (const c of local) if (typeof c?.value === 'string') secrets.push(c.value);
    const localSession = sessionCookie(local, account.host);
    if (meta.user) this.deps.users.set(profile, account.account, meta.user);
    if (localSession && fingerprint(localSession.value) === fp)
      return { state: 'already_live', ...meta };
    const written = await this.deps.writeCookies(profile, account.host, cookies);
    return { state: 'imported', ...meta, cookies_set: written, next: 'reload the NetSuite page' };
  }

  private async noneOrLocked(
    account: NsAccount,
    user: string | null,
    profile: string,
  ): Promise<Json> {
    const answer = await this.deps.store.request('GET', '/list', {
      query: { account: account.account },
    });
    const entries: Json[] =
      answer.kind === 'ok' && Array.isArray(answer.body?.entries) ? answer.body.entries : [];
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
        user: locked.user ?? user,
        holder: locked.lock.holder,
        until: locked.lock.until,
      };
    }
    return {
      state: 'none',
      account: account.account,
      ...(user ? { user } : {}),
      next: 'log in, then netsuite_session_publish',
    };
  }

  async publish(args: Json, callProfile: string | null, secrets: string[]): Promise<Json> {
    const account = this.account(args, true)!;
    const profile = this.profile(callProfile);
    const cookies = await this.deps.readCookies(profile, account.host);
    for (const c of cookies) if (typeof c?.value === 'string') secrets.push(c.value);
    const session = sessionCookie(cookies, account.host);
    if (!session)
      return {
        state: 'no_session',
        account: account.account,
        note: `no ${SESSION_COOKIE} for ${account.host} in this profile`,
      };
    const identity = await this.deps.tabIdentity(profile, account.host).catch(() => null);
    const user =
      identity?.user?.toLowerCase() ||
      (await this.userOf(args)) ||
      this.deps.users.get(profile, account.account);
    const fp = fingerprint(session.value);
    const now = this.deps.now();
    const answer = await this.deps.store.request('POST', '/entry', {
      body: {
        account: account.account,
        user: user ?? null,
        host: account.host,
        role: identity?.role ?? null,
        role_id: identity?.role_id ?? null,
        fp,
        cookies,
        origin: { machine: this.deps.machine, profile },
        login_at: args.login_at === true ? now : null,
        seen_at: now,
      },
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
    if (user) this.deps.users.set(profile, account.account, user);
    return {
      state: bodyOf(answer)?.stored === false ? 'unchanged' : 'published',
      account: account.account,
      user: user ?? null,
      role: identity?.role ?? null,
      fp,
      generation: bodyOf(answer)?.generation ?? null,
    };
  }

  async lock(args: Json, callProfile: string | null): Promise<Json> {
    const account = this.account(args, true)!;
    const profile = this.profile(callProfile);
    const user = (await this.userOf(args)) ?? this.deps.users.get(profile, account.account);
    if (!user) throw new ToolRefusal('UserRequired', 'the lock needs user or vault_item');
    const ttl = Math.max(10, Math.min(120, Number(args.ttl_s) || 120));
    const answer = await this.deps.store.request('POST', '/lock', {
      body: {
        account: account.account,
        user,
        holder: this.holder(profile, args.run_id),
        ttl_s: ttl,
      },
    });
    const none = noStoreResult(answer, account.account);
    if (none) return none;
    if (answer.kind === 'error') {
      if (answer.code === 'locked') {
        return {
          state: 'locked_by',
          account: account.account,
          user,
          holder: answer.body?.holder ?? null,
          until: answer.body?.until ?? null,
        };
      }
      throw new ToolRefusal(answer.code, `the store refused the lock (${answer.status})`);
    }
    return {
      state: 'locked',
      account: account.account,
      user,
      until: bodyOf(answer)?.until ?? null,
    };
  }

  async unlock(args: Json, callProfile: string | null): Promise<Json> {
    const account = this.account(args, true)!;
    const profile = this.profile(callProfile);
    const user = (await this.userOf(args)) ?? this.deps.users.get(profile, account.account);
    if (!user) throw new ToolRefusal('UserRequired', 'the unlock needs user or vault_item');
    const answer = await this.deps.store.request('POST', '/unlock', {
      body: { account: account.account, user, holder: this.holder(profile, args.run_id) },
    });
    const none = noStoreResult(answer, account.account);
    if (none) return none;
    if (answer.kind === 'error')
      throw new ToolRefusal(answer.code, `the store refused the unlock (${answer.status})`);
    return { state: 'unlocked', account: account.account, user };
  }
}
