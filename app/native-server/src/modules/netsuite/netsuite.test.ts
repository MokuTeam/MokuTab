import { describe, expect, test } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { accountFromHost, fingerprint, normalizeAccount } from './account';
import { ExpectedUsers } from './expected-users';
import {
  NsSessionTools,
  untilMs,
  vaultItemIsFor,
  type NsCookie,
  type NsDeps,
} from './session-tools';
import { NsStoreClient, parseTokenFile, type StoreIo } from './store-client';
import { IMPORT_GUARD_MS, NsTransparent, TOUCH_EVERY_MS, targetUrl } from './transparent';

const SECRET = 'JSESS-VALUE-0123456789abcdef';
const OTHER = 'OTHER-COOKIE-VALUE-zyxw9876';
const HOST = '1234567-sb2.app.netsuite.com';

const cookie = (name: string, value: string, domain = HOST): NsCookie => ({
  name,
  value,
  domain,
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'no_restriction',
});

describe('account ids and hosts', () => {
  test('normalises ids and hosts both ways', () => {
    expect(normalizeAccount('1234567_sb2')).toEqual({ account: '1234567_SB2', host: HOST });
    expect(normalizeAccount('1234567-SB2')).toEqual({ account: '1234567_SB2', host: HOST });
    expect(normalizeAccount('td3125712')).toEqual({
      account: 'TD3125712',
      host: 'td3125712.app.netsuite.com',
    });
    expect(normalizeAccount('7654321')?.host).toBe('7654321.app.netsuite.com');
    expect(normalizeAccount('system')).toBeNull();
    expect(normalizeAccount('1;rm')).toBeNull();
    expect(accountFromHost(HOST)?.account).toBe('1234567_SB2');
    expect(accountFromHost('system.netsuite.com')).toBeNull();
  });

  test('fp is the first 8 hex chars of sha256', () => {
    expect(fingerprint('abc')).toBe('ba7816bf');
    expect(fingerprint(SECRET)).toMatch(/^[0-9a-f]{8}$/);
  });
});

/** A store answering from a route table; records calls (bodies kept in memory only). */
function fakeStore(
  routes: Record<
    string,
    (body: any, query: URLSearchParams) => { status: number; body?: any; raw?: string }
  >,
) {
  const calls: Array<{
    method: string;
    route: string;
    headers: Record<string, string>;
    body: any;
  }> = [];
  const fetchFn = (async (url: string, init: any) => {
    const u = new URL(url);
    const route = u.pathname.replace(/^\/api\/ns-sessions/, '');
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, route, headers: init.headers, body });
    const handler = routes[`${init.method} ${route}`];
    const answer = handler
      ? handler(body, u.searchParams)
      : { status: 404, body: { ok: false, code: 'none' } };
    const text = answer.raw ?? (answer.body === undefined ? '' : JSON.stringify(answer.body));
    return { status: answer.status, text: async () => text } as any;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function clientWith(fetchFn: typeof fetch, extra: Partial<StoreIo> = {}) {
  const logs: string[] = [];
  let clock = 1_000_000;
  const io: Partial<StoreIo> = {
    readFile: () => 'tok-123\n',
    mtime: () => 1,
    fetch: fetchFn,
    now: () => clock,
    log: (line) => logs.push(line),
    env: {},
    ...extra,
  };
  const client = new NsStoreClient(() => '/state/ns-store-token', io, {
    version: '9.9.9',
    machine: 'laptop',
  });
  return { client, logs, advance: (ms: number) => (clock += ms) };
}

describe('store client', () => {
  test('token file: line 1 token, optional line 2 base URL', () => {
    expect(parseTokenFile('abc\n')).toEqual({ token: 'abc' });
    expect(parseTokenFile('abc\r\nhttp://127.0.0.1:12423/api/ns-sessions/\n')).toEqual({
      token: 'abc',
      base: 'http://127.0.0.1:12423/api/ns-sessions',
    });
    // A base URL off this machine is ignored.
    expect(parseTokenFile('abc\nhttp://10.0.0.2:12422/api/ns-sessions\n')).toEqual({
      token: 'abc',
    });
    expect(parseTokenFile('abc\nhttps://localhost.evil.net/x\n')).toEqual({ token: 'abc' });
    expect(parseTokenFile('')).toBeNull();
    expect(parseTokenFile('two words')).toBeNull();
  });

  test('no file: unconfigured; the file is re-read when its mtime changes', async () => {
    let mtime: number | null = null;
    let text = 'first\n';
    const { fetchFn, calls } = fakeStore({
      'GET /list': () => ({ status: 200, body: { ok: true, entries: [] } }),
    });
    const { client } = clientWith(fetchFn, { mtime: () => mtime, readFile: () => text });
    expect((await client.request('GET', '/list')).kind).toBe('unconfigured');
    mtime = 1;
    await client.request('GET', '/list');
    text = 'second\n';
    await client.request('GET', '/list');
    mtime = 2;
    await client.request('GET', '/list');
    expect(calls.map((c) => c.headers['X-NS-Store-Token'])).toEqual(['first', 'first', 'second']);
    expect(calls[0].headers['X-Board']).toBe('1');
    expect(calls[0].headers['X-NS-Store-Client']).toBe('mokutab/9.9.9 laptop/-');
  });

  test('MOKUTAB_NS_STORE_URL overrides the base URL', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(url);
      return { status: 200, text: async () => '{"ok":true}' } as any;
    }) as unknown as typeof fetch;
    const { client } = clientWith(fetchFn, {
      env: { MOKUTAB_NS_STORE_URL: 'http://127.0.0.1:9999/api/ns-sessions/' },
    });
    await client.request('GET', '/list', { query: { account: '1234567_SB2' } });
    expect(seen).toEqual(['http://127.0.0.1:9999/api/ns-sessions/list?account=1234567_SB2']);
  });

  test('503, 5xx, bad JSON and a dead socket are "no store", and back off for 30 s', async () => {
    for (const answer of [
      { status: 503, body: { code: 'node-master-offline' } },
      { status: 500 },
      { status: 200, raw: 'nope' },
    ]) {
      const { fetchFn, calls } = fakeStore({ 'GET /list': () => answer });
      const { client, advance } = clientWith(fetchFn);
      expect((await client.request('GET', '/list')).kind).toBe('no_store');
      expect((await client.request('GET', '/list')).kind).toBe('no_store');
      expect(calls).toHaveLength(1);
      advance(30_001);
      await client.request('GET', '/list');
      expect(calls).toHaveLength(2);
    }
    const dead = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;
    const { client } = clientWith(dead);
    const answer = await client.request('GET', '/list');
    expect(answer).toEqual({ kind: 'no_store', reason: 'the store did not answer in 4 s' });
  });

  test('4xx answers keep their code; logs carry method, path, status and time only', async () => {
    const { fetchFn } = fakeStore({
      'POST /entry': () => ({ status: 409, body: { ok: false, code: 'dead_fp', message: 'x' } }),
    });
    const { client, logs } = clientWith(fetchFn);
    const answer = await client.request('POST', '/entry', {
      body: { cookies: [cookie('JSESSIONID', SECRET)] },
    });
    expect(answer.kind).toBe('error');
    expect((answer as any).code).toBe('dead_fp');
    expect(logs).toEqual([expect.stringMatching(/^\[ns-store\] POST \/entry 409 \d+ms$/)]);
    expect(logs.join('\n')).not.toContain(SECRET);
  });
});

interface FakeBrowser {
  cookies: NsCookie[];
  written: NsCookie[][];
  identity: { user: string | null; role: string | null; role_id: string | null } | null;
  probe: 'alive' | 'dead' | 'unknown';
}

const ITEM = '081555dc-d350-485b-99ae-b4ed017046b4';

function toolsWith(
  routes: Parameters<typeof fakeStore>[0],
  browser: Partial<FakeBrowser> = {},
  opts: {
    tokenMissing?: boolean;
    failWrite?: boolean;
    partialWrite?: boolean;
    profiles?: string[];
    vaultUris?: string[];
    totp?: boolean | 'throw';
  } = {},
) {
  const store = fakeStore(routes);
  const { client, logs } = clientWith(
    store.fetchFn,
    opts.tokenMissing ? { mtime: () => null } : {},
  );
  const b: FakeBrowser = { cookies: [], written: [], identity: null, probe: 'alive', ...browser };
  const usersFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-users-')), 'u.json');
  let clock = Date.parse('2026-11-26T15:00:00Z');
  const sleeps: number[] = [];
  const touched: string[] = [];
  const deps: NsDeps = {
    store: client,
    users: new ExpectedUsers(
      () => usersFile,
      () => clock,
    ),
    readCookies: async () => {
      touched.push('readCookies');
      return b.cookies;
    },
    writeCookies: async (_p, _h, cookies) => {
      touched.push('writeCookies');
      if (opts.failWrite) throw new Error(`chrome refused ${cookies[0]?.value}`);
      b.written.push(cookies);
      b.cookies = cookies;
      return opts.partialWrite ? cookies.length - 1 : cookies.length;
    },
    tabIdentity: async () => {
      touched.push('tabIdentity');
      return b.identity;
    },
    sessionState: async () => {
      touched.push('sessionState');
      return b.probe;
    },
    vaultUris: async () => {
      touched.push('vaultUris');
      return (opts.vaultUris ?? ['https://system.netsuite.com']).map((uri) => ({
        uri,
        match: null,
      }));
    },
    vaultUsername: async () => {
      touched.push('vaultUsername');
      return 'Support_User@example.com';
    },
    ...(opts.totp === undefined
      ? {}
      : {
          vaultHasTotp: async () => {
            touched.push('vaultHasTotp');
            if (opts.totp === 'throw') throw new Error('bw failed');
            return opts.totp as boolean;
          },
        }),
    connectedProfiles: () => opts.profiles ?? ['work'],
    machine: 'laptop',
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return {
    tools: new NsSessionTools(deps),
    store,
    browser: b,
    logs,
    sleeps,
    users: deps.users,
    touched,
  };
}

const parse = (result: any) => JSON.parse(result.content[0].text);
const entryBody = (over: any = {}) => ({
  ok: true,
  account: '1234567_SB2',
  user: 'support_user@example.com',
  role: '3',
  generation: 4,
  state: 'live',
  cookies: [cookie('JSESSIONID', SECRET), cookie('NS_ROUTING', OTHER, '.' + HOST)],
  ...over,
});
const ALL = [
  'netsuite_session_status',
  'netsuite_session_ensure',
  'netsuite_session_publish',
  'netsuite_session_lock',
  'netsuite_session_unlock',
];

describe('netsuite_session_* tools', () => {
  test('without a token every tool says store_unconfigured and touches nothing', async () => {
    const { tools, touched, store } = toolsWith(
      {},
      {},
      { tokenMissing: true, profiles: ['a', 'b'] },
    );
    for (const name of ALL) {
      const out = parse(await tools.call(name, { account: '1234567_SB2', vault_item: ITEM }, null));
      expect(out.state).toBe('store_unconfigured');
    }
    expect(touched).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  test('while backing off after a failure, tools answer no_store without reading anything', async () => {
    const { tools, touched, store } = toolsWith({ 'GET /entry': () => ({ status: 503 }) });
    expect(
      parse(await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work')).state,
    ).toBe('no_store');
    touched.length = 0;
    for (const name of ALL) {
      expect(
        parse(await tools.call(name, { account: '1234567_SB2', user: 'a@b.c' }, 'work')).state,
      ).toBe('no_store');
    }
    expect(touched).toEqual([]);
    expect(store.calls).toHaveLength(1);
  });

  test('status lists metadata and drops anything value-shaped', async () => {
    const { tools } = toolsWith({
      'GET /list': () => ({
        status: 200,
        body: {
          ok: true,
          entries: [
            { account: '1234567_SB2', fp: 'abcd1234', cookies: [cookie('JSESSIONID', SECRET)] },
          ],
        },
      }),
    });
    const out = parse(
      await tools.call('netsuite_session_status', { account: '1234567-sb2' }, null),
    );
    expect(out).toEqual({
      state: 'ok',
      account: '1234567_SB2',
      entries: [{ account: '1234567_SB2', fp: 'abcd1234' }],
      // The only connected profile, and the users it expects (none yet).
      profile: 'work',
      expected_users: {},
    });
  });

  test('several profiles connected and none named: ProfileRequired, nothing imported', async () => {
    const { tools, browser } = toolsWith(
      { 'GET /entry': () => ({ status: 200, body: entryBody() }) },
      {},
      { profiles: ['personal', 'work'] },
    );
    const out = await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, null);
    expect(out.isError).toBe(true);
    expect(parse(out).error.code).toBe('ProfileRequired');
    expect(browser.written).toEqual([]);
    expect(
      parse(await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work')).state,
    ).toBe('imported');
  });

  test('ensure imports the live session; already_live only when the local session is logged in', async () => {
    const { tools, browser, users, store } = toolsWith({
      'GET /entry': () => ({ status: 200, body: entryBody() }),
      'POST /dead': () => ({ status: 200, body: { ok: true, matched: true } }),
    });
    const result = await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work');
    const out = parse(result);
    expect(out).toMatchObject({
      state: 'imported',
      fp: fingerprint(SECRET),
      cookies_set: 2,
      user: 'support_user@example.com',
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(OTHER);
    expect(users.get('work', '1234567_SB2')).toBe('support_user@example.com');

    expect(
      parse(await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work')).state,
    ).toBe('already_live');
    browser.probe = 'unknown';
    const unsure = parse(
      await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work'),
    );
    expect(unsure.state).toBe('already_live_unverified');
    expect(store.calls.some((c) => c.route === '/dead')).toBe(false);
    browser.probe = 'dead';
    const dead = parse(
      await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work'),
    );
    expect(dead.state).toBe('none');
    expect(store.calls.find((c) => c.route === '/dead')?.body).toMatchObject({
      fp: fingerprint(SECRET),
      reason: 'login_redirect',
    });
    expect(browser.written).toHaveLength(1);
  });

  test('a partial import is partial_import and the user is not remembered', async () => {
    const { tools, users } = toolsWith(
      { 'GET /entry': () => ({ status: 200, body: entryBody() }) },
      {},
      { partialWrite: true },
    );
    const out = parse(
      await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work'),
    );
    expect(out).toMatchObject({ state: 'partial_import', cookies_set: 1, cookies_total: 2 });
    expect(users.get('work', '1234567_SB2')).toBeNull();
  });

  test('a vault user is read only for an item of this account, and never echoed', async () => {
    const asked: Array<string | null> = [];
    const { tools, touched } = toolsWith({
      'GET /entry': (_b, q) => {
        asked.push(q.get('user'));
        return { status: 200, body: entryBody() };
      },
    });
    const result = await tools.call(
      'netsuite_session_ensure',
      { account: '1234567_SB2', vault_item: ITEM },
      'work',
    );
    const out = parse(result);
    expect(asked).toEqual(['support_user@example.com']);
    expect(out.user_source).toBe('vault');
    expect(out.user).toBeUndefined();
    expect(JSON.stringify(result).toLowerCase()).not.toContain('support_user');

    const other = toolsWith({}, {}, { vaultUris: ['https://mail.example.com'] });
    const refused = await other.tools.call(
      'netsuite_session_lock',
      { account: '1234567_SB2', vault_item: ITEM },
      'work',
    );
    expect(parse(refused).error.code).toBe('VaultItemMismatch');
    expect(other.touched).toEqual(['vaultUris']);
    expect(touched).toContain('vaultUris');
  });

  test('ensure: locked_by another machine; wait_for_lock polls every 3 s with an epoch-ms until', async () => {
    let polls = 0;
    const lockUntil = Date.parse('2026-11-26T15:00:00Z') + 9_000;
    const { tools, sleeps, touched } = toolsWith({
      'GET /entry': () =>
        polls++ < 3
          ? { status: 404, body: { ok: false, code: 'none' } }
          : { status: 200, body: entryBody() },
      'GET /list': () => ({
        status: 200,
        body: {
          ok: true,
          entries: [
            {
              account: '1234567_SB2',
              user: 'support_user@example.com',
              lock: { holder: { machine: 'server-2', profile: 'other' }, until: lockUntil },
            },
          ],
        },
      }),
    });
    const first = parse(
      await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work'),
    );
    expect(first).toMatchObject({
      state: 'locked_by',
      holder: { machine: 'server-2' },
      until: lockUntil,
    });
    touched.length = 0;
    const waited = parse(
      await tools.call(
        'netsuite_session_ensure',
        { account: '1234567_SB2', vault_item: ITEM, wait_for_lock: true },
        'work',
      ),
    );
    expect(waited.state).toBe('imported');
    expect(sleeps).toEqual([3_000, 3_000]);
    // The vault is read once per call, not once per poll.
    expect(touched.filter((t) => t === 'vaultUsername')).toHaveLength(1);
  });

  test('ensure: two live users, the most recently active one is taken and remembered', async () => {
    const { tools, users } = toolsWith({
      'GET /entry': (_b, q) =>
        q.get('user')
          ? { status: 200, body: entryBody({ user: q.get('user') }) }
          : {
              status: 409,
              body: {
                ok: false,
                code: 'ambiguous_user',
                users: [
                  { user: 'old@example.com', last_activity: 1000 },
                  { user: 'new@example.com', last_activity: 5000 },
                ],
              },
            },
    });
    const out = parse(await tools.call('netsuite_session_ensure', { account: '9089979' }, 'work'));
    expect(out).toMatchObject({ state: 'imported', user: 'new@example.com' });
    expect(out.note).toMatch(/most recently active/);
    expect(users.get('work', '9089979')).toBe('new@example.com');
  });

  test('publish: no session, a logged-out session (nothing sent), published, unchanged, dead, full', async () => {
    const answers = [
      { status: 200, body: { ok: true, stored: true, generation: 5 } },
      { status: 200, body: { ok: true, stored: false, generation: 5 } },
      { status: 409, body: { ok: false, code: 'dead_fp' } },
      { status: 409, body: { ok: false, code: 'store_full' } },
    ];
    const { tools, store, browser } = toolsWith({ 'POST /entry': () => answers.shift()! });
    expect(
      parse(await tools.call('netsuite_session_publish', { account: '1234567_SB2' }, 'work')).state,
    ).toBe('no_session');
    browser.cookies = [
      { ...cookie('JSESSIONID', SECRET), hostOnly: true },
      cookie('NS_ROUTING', OTHER, '.' + HOST),
    ];
    browser.probe = 'dead';
    expect(
      parse(await tools.call('netsuite_session_publish', { account: '1234567_SB2' }, 'work')).state,
    ).toBe('no_session');
    browser.probe = 'unknown';
    expect(
      parse(await tools.call('netsuite_session_publish', { account: '1234567_SB2' }, 'work')).state,
    ).toBe('probe_unknown');
    expect(store.calls).toEqual([]);
    browser.probe = 'alive';
    browser.identity = { user: 'Tab.User@example.com', role: '3', role_id: 'administrator' };
    const published = await tools.call(
      'netsuite_session_publish',
      { account: '1234567_SB2', login_at: true },
      'work',
    );
    expect(parse(published)).toMatchObject({
      state: 'published',
      user: 'tab.user@example.com',
      user_source: 'tab',
      fp: fingerprint(SECRET),
      generation: 5,
    });
    expect(JSON.stringify(published)).not.toContain(SECRET);
    const sent = store.calls[0].body;
    expect(sent).toMatchObject({
      account: '1234567_SB2',
      host: HOST,
      origin: { machine: 'laptop', profile: 'work' },
    });
    expect(sent.cookies.every((c: any) => !('hostOnly' in c))).toBe(true);
    expect(store.calls[0].headers['X-NS-Store-Client']).toBe('mokutab/9.9.9 laptop/work');
    // The tab's user and the vault item's user must agree.
    const mismatch = await tools.call(
      'netsuite_session_publish',
      { account: '1234567_SB2', vault_item: ITEM },
      'work',
    );
    expect(parse(mismatch).error.code).toBe('UserMismatch');
    expect(JSON.stringify(mismatch).toLowerCase()).not.toContain('support_user');
    // No tab open: the publish is keyed by the vault user, as ensure and lock are.
    browser.identity = null;
    const viaVault = parse(
      await tools.call(
        'netsuite_session_publish',
        { account: '1234567_SB2', vault_item: ITEM },
        'work',
      ),
    );
    expect(viaVault).toMatchObject({ state: 'unchanged', user_source: 'vault' });
    expect(store.calls[1].body.user).toBe('support_user@example.com');
    expect(
      parse(await tools.call('netsuite_session_publish', { account: '1234567_SB2' }, 'work')).state,
    ).toBe('dead_session');
    expect(
      parse(await tools.call('netsuite_session_publish', { account: '1234567_SB2' }, 'work')).state,
    ).toBe('no_store');
  });

  test('a cookie value equal to a state word never rewrites the state', async () => {
    const { tools } = toolsWith({
      'GET /entry': () => ({
        status: 200,
        body: entryBody({ cookies: [cookie('JSESSIONID', 'imported'), cookie('X', 'none')] }),
      }),
    });
    const out = parse(
      await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work'),
    );
    expect(out.state).toBe('imported');
  });

  test('lock and unlock carry the holder; a held lock is locked_by', async () => {
    const answers = [
      { status: 200, body: { ok: true, lock_id: 'L1', until: 'T1' } },
      {
        status: 409,
        body: {
          ok: false,
          code: 'locked',
          holder: { machine: 'server-2', profile: 'other' },
          until: 'T2',
        },
      },
      { status: 200, body: { ok: true, lock_id: 'L3', until: 'T3' } },
    ];
    const { tools, store } = toolsWith({
      'POST /lock': () => answers.shift()!,
      'POST /unlock': () => ({ status: 204 }),
    });
    const locked = parse(
      await tools.call(
        'netsuite_session_lock',
        { account: '1234567_SB2', vault_item: ITEM, run_id: 'R1', ttl_s: 500 },
        'work',
      ),
    );
    expect(locked).toEqual({
      state: 'locked',
      account: '1234567_SB2',
      user_source: 'vault',
      until: 'T1',
    });
    expect(store.calls[0].body).toEqual({
      account: '1234567_SB2',
      user: 'support_user@example.com',
      holder: { machine: 'laptop', profile: 'work', run_id: 'R1' },
      ttl_s: 120,
    });
    // The unlock sends back the lock_id the lock got, and the holder.
    await tools.call(
      'netsuite_session_unlock',
      { account: '1234567_SB2', vault_item: ITEM, run_id: 'R1' },
      'work',
    );
    expect(store.calls[1].body).toEqual({
      account: '1234567_SB2',
      user: 'support_user@example.com',
      lock_id: 'L1',
      holder: { machine: 'laptop', profile: 'work', run_id: 'R1' },
    });
    expect(
      parse(
        await tools.call(
          'netsuite_session_lock',
          { account: '1234567_SB2', user: 'a@b.c' },
          'work',
        ),
      ),
    ).toMatchObject({ state: 'locked_by', until: 'T2' });
    expect(
      parse(
        await tools.call(
          'netsuite_session_unlock',
          { account: '1234567_SB2', user: 'a@b.c' },
          'work',
        ),
      ).state,
    ).toBe('unlocked');
    // A lock without a run_id gets one (the store needs it in every holder),
    // and the unlock sends the same one back.
    const before = store.calls.length;
    await tools.call('netsuite_session_lock', { account: '1234567_SB2', user: 'c@d.e' }, 'work');
    await tools.call('netsuite_session_unlock', { account: '1234567_SB2', user: 'c@d.e' }, 'work');
    const autoLock = store.calls[before].body.holder;
    expect(autoLock.run_id).toMatch(/^auto-/);
    expect(store.calls[before + 1].body.holder).toEqual(autoLock);
    const noUser = await tools.call('netsuite_session_lock', { account: '1234567' }, 'work');
    expect(parse(noUser).error.code).toBe('UserRequired');
  });

  test('a bad account is refused; no cookie value reaches an error or a log line', async () => {
    const { tools, logs } = toolsWith(
      { 'GET /entry': () => ({ status: 200, body: entryBody() }) },
      {},
      { failWrite: true },
    );
    expect(
      parse(await tools.call('netsuite_session_ensure', { account: 'system' }, null)).error.code,
    ).toBe('InvalidAccount');
    const failed = await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work');
    expect(failed.isError).toBe(true);
    const text = JSON.stringify(failed);
    expect(text).toContain('chrome refused');
    expect(text).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain(SECRET);
  });
});

describe('vault checks', () => {
  test('an item counts only with a URI on the account host or system.netsuite.com', () => {
    const u = (uri: string, match: number | null = null) => [{ uri, match }];
    expect(vaultItemIsFor(u('https://system.netsuite.com'), HOST)).toBe(true);
    expect(vaultItemIsFor(u(`https://${HOST}/app/login`), HOST)).toBe(true);
    expect(vaultItemIsFor(u('https://7654321.app.netsuite.com'), HOST)).toBe(false);
    expect(vaultItemIsFor(u('netsuite.com'), HOST)).toBe(false);
    expect(vaultItemIsFor(u('https://system.netsuite.com', 4), HOST)).toBe(false);
    expect(vaultItemIsFor(u('androidapp://system.netsuite.com'), HOST)).toBe(false);
  });

  test('the checked vault user is read once per item and host for 10 minutes', async () => {
    const { tools, touched } = toolsWith({
      'POST /lock': () => ({ status: 200, body: { ok: true, until: 1 } }),
      'POST /unlock': () => ({ status: 204 }),
    });
    await tools.call('netsuite_session_lock', { account: '1234567_SB2', vault_item: ITEM }, 'work');
    await tools.call(
      'netsuite_session_unlock',
      { account: '1234567_SB2', vault_item: ITEM },
      'work',
    );
    expect(touched.filter((x) => x === 'vaultUsername')).toHaveLength(1);
    expect(touched.filter((x) => x === 'vaultUris')).toHaveLength(1);

    const other = toolsWith({}, {}, { vaultUris: ['https://7654321.app.netsuite.com'] });
    const refused = await other.tools.call(
      'netsuite_session_lock',
      { account: '1234567_SB2', vault_item: ITEM },
      'work',
    );
    expect(parse(refused).error.code).toBe('VaultItemMismatch');
    expect(other.touched).not.toContain('vaultUsername');
  });
});

describe('until and Test Drive ids', () => {
  test('untilMs takes epoch ms, numeric strings and ISO dates', () => {
    expect(untilMs(1795700000000)).toBe(1795700000000);
    expect(untilMs('1795700000000')).toBe(1795700000000);
    expect(untilMs('2026-11-26T15:00:09.000Z')).toBe(Date.parse('2026-11-26T15:00:09.000Z'));
    expect(untilMs(undefined)).toBeNaN();
  });

  test('tstdrv accounts', () => {
    expect(normalizeAccount('TSTDRV1234567')).toEqual({
      account: 'TSTDRV1234567',
      host: 'tstdrv1234567.app.netsuite.com',
    });
    expect(accountFromHost('tstdrv1234567.app.netsuite.com')?.account).toBe('TSTDRV1234567');
  });
});

describe('transparent mode (bridge)', () => {
  const NEW = 'JSESS-NEWER-SESSION-5555aaaa';
  const LOGIN_COOKIE = 'LOGIN-PAGE-COOKIE-111';
  const USER = 'support_user@example.com';

  /** A store that keeps one entry per account and applies /dead (dead_fp on a republish). */
  function statefulStore() {
    const s = {
      entry: null as null | {
        user: string | null;
        value: string;
        generation: number;
        origin: any;
        live: boolean;
      },
      dead: new Set<string>(),
      entries: [] as any[],
    };
    const routes: Parameters<typeof fakeStore>[0] = {
      'GET /entry': (_body, query) =>
        s.entry && s.entry.live && (!query.get('user') || query.get('user') === s.entry.user)
          ? {
              status: 200,
              body: entryBody({
                user: s.entry.user,
                generation: s.entry.generation,
                cookies: [cookie('JSESSIONID', s.entry.value)],
              }),
            }
          : { status: 404, body: { ok: false, code: 'none' } },
      'POST /dead': (body) => {
        const matched = !!s.entry && s.entry.live && fingerprint(s.entry.value) === body.fp;
        if (matched) {
          s.entry!.live = false;
          s.dead.add(body.fp);
        }
        return { status: 200, body: { ok: true, matched } };
      },
      'POST /entry': (body) => {
        if (s.dead.has(body.fp)) return { status: 409, body: { ok: false, code: 'dead_fp' } };
        const value = body.cookies.find((c: any) => c.name === 'JSESSIONID').value;
        const same = s.entry?.live && fingerprint(s.entry.value) === body.fp;
        s.entry = {
          user: body.user,
          value,
          generation: (s.entry?.generation ?? 0) + (same ? 0 : 1),
          origin: body.origin,
          live: true,
        };
        return { status: 200, body: { ok: true, stored: !same, generation: s.entry.generation } };
      },
      'POST /touch': (body) => ({
        status: 200,
        body: { ok: true, matched: !!s.entry?.live && fingerprint(s.entry.value) === body.fp },
      }),
      'GET /list': () => ({
        status: 200,
        body: {
          ok: true,
          entries: s.entry?.live
            ? [
                {
                  account: '1234567_SB2',
                  user: s.entry.user,
                  state: 'live',
                  origin: s.entry.origin,
                  fp: fingerprint(s.entry.value),
                },
              ]
            : [],
        },
      }),
    };
    return { s, routes };
  }

  function setup(
    browser: Partial<FakeBrowser> = {},
    opts: { off?: boolean; tokenMissing?: boolean; remembered?: string | null } = {},
  ) {
    const { s, routes } = statefulStore();
    const t = toolsWith(routes, browser, { tokenMissing: opts.tokenMissing });
    /** What another machine asking for this user would get. */
    const byUser = (user: string) =>
      routes['GET /entry'](undefined, new URLSearchParams({ account: '1234567_SB2', user })).status;
    if (opts.remembered !== null) t.users.set('work', '1234567_SB2', opts.remembered ?? USER);
    let now = Date.parse('2026-11-26T15:00:00Z');
    const tr = new NsTransparent(t.tools, { isOn: () => !opts.off, now: () => now });
    // Another machine's live session in the store.
    const remote = (value = SECRET, user: string | null = USER) => {
      s.entry = {
        user,
        value,
        generation: (s.entry?.generation ?? 0) + 1,
        origin: { machine: 'server-2', profile: 'other' },
        live: true,
      };
    };
    return { ...t, tr, s, remote, byUser, advance: (ms: number) => (now += ms) };
  }
  const leak = (values: unknown[]) => {
    const text = JSON.stringify(values);
    for (const v of [SECRET, OTHER, NEW, LOGIN_COOKIE]) expect(text).not.toContain(v);
  };
  const routesOf = (calls: Array<{ method: string; route: string }>) =>
    calls.map((c) => `${c.method} ${c.route}`);

  test('targetUrl keeps a plain path and refuses login pages and other hosts', () => {
    expect(targetUrl(HOST, '/app/crm/support/supportcase.nl?id=5')).toBe(
      `https://${HOST}/app/crm/support/supportcase.nl?id=5`,
    );
    for (const bad of [
      undefined,
      '',
      '//evil.example/x',
      'https://evil.example',
      '/app/login/secure/enterpriselogin.nl',
    ]) {
      expect(targetUrl(HOST, bad)).toBe(`https://${HOST}/app/center/card.nl`);
    }
  });

  test('a profile that never took the account imports nothing on its own', async () => {
    const t = setup({ cookies: [] }, { remembered: null });
    t.remote();
    expect(await t.tr.onLanding({ host: HOST, kind: 'tab' }, 'work')).toEqual({
      action: 'none',
      reason: 'no_expected_user',
    });
    expect(t.browser.written).toEqual([]);
    expect(t.store.calls).toEqual([]);
  });

  test('a dead or missing local session: a tab imports and goes to its target, a fetch only imports', async () => {
    const t = setup({ cookies: [cookie('JSESSIONID', LOGIN_COOKIE)], probe: 'dead' });
    t.remote();
    const tab = await t.tr.onLanding(
      { host: HOST, kind: 'tab', target: '/app/center/card.nl?x=1' },
      'work',
    );
    expect(tab).toEqual({
      action: 'navigate',
      url: `https://${HOST}/app/center/card.nl?x=1`,
      fp: fingerprint(SECRET),
    });
    expect(t.browser.written).toHaveLength(1);
    const f = setup({ cookies: [] });
    f.remote();
    expect(await f.tr.onLanding({ host: HOST, kind: 'fetch' }, 'work')).toEqual({
      action: 'imported',
      fp: fingerprint(SECRET),
    });
    leak([tab, t.store.calls.map((c) => c.route)]);
  });

  test('a landing after a good import (second tab, stale page): probe alive, no dead report, the tab goes on', async () => {
    const t = setup({ cookies: [], probe: 'alive' });
    t.remote();
    await t.tr.onLanding({ host: HOST, kind: 'tab' }, 'work');
    const second = await t.tr.onLanding(
      { host: HOST, kind: 'tab', target: '/app/center/card.nl' },
      'work',
    );
    expect(second).toEqual({
      action: 'navigate',
      url: `https://${HOST}/app/center/card.nl`,
      reason: 'already_live',
    });
    expect(routesOf(t.store.calls)).not.toContain('POST /dead');
    expect(t.s.entry?.live).toBe(true);
    expect(t.browser.written).toHaveLength(1);
  });

  test('a live local session is never overwritten; an unknown one is left alone', async () => {
    const live = setup({ cookies: [cookie('JSESSIONID', LOGIN_COOKIE)], probe: 'alive' });
    live.remote();
    expect((await live.tr.onLanding({ host: HOST, kind: 'tab' }, 'work')).reason).toBe(
      'already_live',
    );
    expect(await live.tr.onLanding({ host: HOST, kind: 'fetch' }, 'work')).toEqual({
      action: 'none',
      reason: 'already_live',
    });
    expect(live.browser.written).toEqual([]);
    const unknown = setup({ cookies: [cookie('JSESSIONID', LOGIN_COOKIE)], probe: 'unknown' });
    unknown.remote();
    expect(await unknown.tr.onLanding({ host: HOST, kind: 'tab' }, 'work')).toEqual({
      action: 'none',
      reason: 'probe_unknown',
    });
    expect(unknown.browser.written).toEqual([]);
    expect(routesOf(unknown.store.calls)).not.toContain('POST /dead');
  });

  test('a real bounce (probe dead) reports import_bounced once and takes a newer session if there is one', async () => {
    const t = setup({ cookies: [], probe: 'alive' });
    t.remote();
    await t.tr.onLanding({ host: HOST, kind: 'tab' }, 'work');
    // The imported session is dead after all; another machine logged in meanwhile.
    t.browser.probe = 'dead';
    const dead = await t.tr.onLanding({ host: HOST, kind: 'tab' }, 'work');
    const report = t.store.calls.find((c) => c.route === '/dead');
    expect(report?.body).toMatchObject({ fp: fingerprint(SECRET), reason: 'import_bounced' });
    expect(t.s.dead.has(fingerprint(SECRET))).toBe(true);
    expect(dead).toEqual({ action: 'none', reason: 'none' });

    const n = setup({ cookies: [], probe: 'alive' });
    n.remote();
    await n.tr.onLanding({ host: HOST, kind: 'tab' }, 'work');
    n.browser.probe = 'dead';
    // A newer session from another machine is in the store once the old one is reported.
    n.remote(NEW);
    n.s.entry!.value = NEW;
    // the browser still has the imported (old) cookie
    n.browser.cookies = [cookie('JSESSIONID', SECRET)];
    const again = await n.tr.onLanding({ host: HOST, kind: 'tab' }, 'work');
    expect(again).toMatchObject({ action: 'navigate', fp: fingerprint(NEW) });
    n.browser.probe = 'dead';
    expect(await n.tr.onLanding({ host: HOST, kind: 'tab' }, 'work')).toEqual({
      action: 'none',
      reason: 'loop_guard',
    });
    leak([report, again]);
  });

  test('module off, no store or not an account host: nothing is read or sent', async () => {
    const off = setup({}, { off: true });
    expect(await off.tr.onLanding({ host: HOST, kind: 'tab' }, 'work')).toEqual({
      action: 'none',
      reason: 'module_off',
    });
    const none = setup({}, { tokenMissing: true });
    expect(await none.tr.onChanged({ host: HOST }, 'work')).toEqual({
      state: 'skipped',
      reason: 'no_store',
    });
    expect(await none.tr.onActivity({ host: 'system.netsuite.com' }, 'work')).toEqual({
      state: 'skipped',
      reason: 'not_an_account_host',
    });
    expect(off.touched).toEqual([]);
    expect(none.touched).toEqual([]);
    expect(off.store.calls).toEqual([]);
  });

  test('a changed session: user from the tab only (null after 30 s without one, never the remembered user); login_at only after a login', async () => {
    const t = setup(
      { cookies: [cookie('JSESSIONID', SECRET)], identity: null },
      { remembered: 'someone.else@example.com' },
    );
    expect(await t.tr.onChanged({ host: HOST }, 'work')).toEqual({ state: 'published' });
    // It waited for a tab: 10 polls of 3 s.
    expect(t.sleeps).toEqual(Array(10).fill(3_000));
    const first = t.store.calls.find((c) => c.route === '/entry')!;
    expect(first.body.user).toBeNull();
    expect(first.body.login_at).toBeNull();
    t.browser.identity = { user: 'Tab.User@example.com', role: '3', role_id: 'x' };
    t.browser.cookies = [cookie('JSESSIONID', NEW)];
    await t.tr.onChanged({ host: HOST, after_login: true }, 'work');
    const second = t.store.calls.filter((c) => c.route === '/entry')[1];
    expect(second.body.user).toBe('tab.user@example.com');
    expect(typeof second.body.login_at).toBe('number');
  });

  test('a tab that tells the user while the publish waits: the session is stored with it', async () => {
    const t = setup({ cookies: [cookie('JSESSIONID', SECRET)], identity: null });
    let polls = 0;
    const real = (t.tools as any).deps.tabIdentity;
    (t.tools as any).deps.tabIdentity = async (...a: any[]) =>
      ++polls >= 3 ? { user: USER, role: '3', role_id: 'x' } : real(...a);
    await t.tr.onChanged({ host: HOST }, 'work');
    expect(t.sleeps).toEqual([3_000, 3_000]);
    expect(t.s.entry?.user).toBe(USER);
  });

  test('a session stored without its user is completed on activity once a tab tells who', async () => {
    const t = setup(
      { cookies: [cookie('JSESSIONID', SECRET)], identity: null },
      { remembered: null },
    );
    await t.tr.onChanged({ host: HOST }, 'work');
    expect(t.s.entry?.user).toBeNull();
    // Another machine asking for this user finds nothing yet.
    expect(t.byUser(USER)).toBe(404);
    t.browser.identity = { user: USER, role: '3', role_id: 'x' };
    expect(await t.tr.onActivity({ host: HOST }, 'work')).toEqual({
      state: 'touched',
      completed_user: true,
    });
    expect(t.s.entry?.user).toBe(USER);
    expect(t.byUser(USER)).toBe(200);
    expect(t.users.get('work', '1234567_SB2')).toBe(USER);
    // Done once: the next touch does not publish again.
    t.advance(TOUCH_EVERY_MS + 1);
    const before = t.store.calls.filter((c) => c.route === '/entry').length;
    expect(await t.tr.onActivity({ host: HOST }, 'work')).toEqual({ state: 'touched' });
    expect(t.store.calls.filter((c) => c.route === '/entry')).toHaveLength(before);
  });

  test('already_live sends a tab on once a minute; a second time is the loop guard, another tab still goes', async () => {
    const t = setup({ cookies: [cookie('JSESSIONID', SECRET)], probe: 'alive' });
    t.remote();
    const first = await t.tr.onLanding({ host: HOST, kind: 'tab', tab_id: 7 }, 'work');
    expect(first.action).toBe('navigate');
    expect(await t.tr.onLanding({ host: HOST, kind: 'tab', tab_id: 7 }, 'work')).toEqual({
      action: 'none',
      reason: 'loop_guard',
    });
    expect((await t.tr.onLanding({ host: HOST, kind: 'tab', tab_id: 8 }, 'work')).action).toBe(
      'navigate',
    );
    t.advance(IMPORT_GUARD_MS + 1);
    expect((await t.tr.onLanding({ host: HOST, kind: 'tab', tab_id: 7 }, 'work')).action).toBe(
      'navigate',
    );
  });

  test('activity: one touch per 2 minutes; a miss publishes only when no other machine has a live entry', async () => {
    const t = setup({
      cookies: [cookie('JSESSIONID', SECRET)],
      identity: { user: USER, role: '3', role_id: 'x' },
    });
    t.remote(SECRET);
    expect(await t.tr.onActivity({ host: HOST }, 'work')).toEqual({ state: 'touched' });
    expect(await t.tr.onActivity({ host: HOST }, 'work')).toEqual({ state: 'throttled' });
    t.advance(TOUCH_EVERY_MS + 1);
    // Another machine holds a different live session for the same user: no ping-pong.
    t.remote(NEW);
    expect(await t.tr.onActivity({ host: HOST }, 'work')).toEqual({
      state: 'skipped',
      reason: 'live_elsewhere',
    });
    expect(routesOf(t.store.calls)).not.toContain('POST /entry');
    // Nobody else has one: publish.
    const alone = setup({
      cookies: [cookie('JSESSIONID', SECRET)],
      identity: { user: USER, role: '3', role_id: 'x' },
    });
    expect(await alone.tr.onActivity({ host: HOST }, 'work')).toEqual({
      state: 'published',
      publish: 'published',
    });
  });

  test('a role or account switch leaves the live session alone; a logout reports it dead', async () => {
    const t = setup({ cookies: [cookie('JSESSIONID', SECRET)] });
    t.remote(SECRET);
    expect(await t.tr.onEnding({ host: HOST, reason: 'switch' }, 'work')).toEqual({
      state: 'ignored',
      reason: 'switch',
    });
    expect(t.store.calls).toEqual([]);
    expect(t.s.entry?.live).toBe(true);
    expect(await t.tr.onEnding({ host: HOST, reason: 'logout' }, 'work')).toEqual({
      state: 'reported',
      reason: 'logout',
    });
    expect(t.s.entry?.live).toBe(false);
    // The store refuses to take that session back.
    t.browser.identity = { user: USER, role: '3', role_id: 'x' };
    expect((await t.tr.onChanged({ host: HOST }, 'work')).state).toBe('dead_session');
    const empty = setup({ cookies: [] });
    expect(await empty.tr.onEnding({ host: HOST, reason: 'logout' }, 'work')).toEqual({
      state: 'no_session',
    });
  });

  test('status names the users this profile expects', async () => {
    const t = setup({}, { remembered: 'a@b.c' });
    const out = parse(await t.tools.call('netsuite_session_status', {}, 'work'));
    expect(out).toMatchObject({ profile: 'work', expected_users: { '1234567_SB2': 'a@b.c' } });
  });
});

describe('popup sessions section', () => {
  const row = (over: any = {}) => ({
    account: '1234567_SB2',
    user: 'support_user@example.com',
    role: '3',
    state: 'live',
    fp: 'aaaaaaaa',
    abs_expiry: 5,
    idle_expiry: 6,
    last_activity: 7,
    last_where: { machine: 'server-2', profile: 'other' },
    ...over,
  });
  const listed =
    (
      entries: any[] = [
        row({ cookies: [cookie('JSESSIONID', SECRET)] }),
        { account: '7654321', user: 'old@example.com', role: '3', state: 'dead', fp: 'bbbbbbbb' },
        row({
          account: '2345678',
          user: 'x@example.com',
          state: 'dying',
          fp: 'cccccccc',
          abs_expiry: '1970-01-01T00:00:00.009Z',
          idle_expiry: null,
          last_activity: 8,
          last_where: { machine: 'm', profile: 'p', token: 'nope' },
        }),
      ],
    ) =>
    () => ({ status: 200, body: { ok: true, entries } });
  const URL_OK = `https://${HOST}/app/center/card.nl`;
  const sameTab = { user: 'support_user@example.com', role: '3', role_id: 'customrole3' };
  const liveLocal = (over: any = {}) => ({
    cookies: [cookie('JSESSIONID', OTHER)],
    probe: 'alive' as const,
    ...over,
  });

  test('list: live and dying entries as metadata only; times are numbers, last_where two fields', async () => {
    const { tools } = toolsWith({ 'GET /list': listed() });
    const out = await tools.popupList();
    expect(out).toEqual({
      ok: true,
      entries: [
        {
          account: '1234567_SB2',
          user: 'support_user@example.com',
          role: '3',
          state: 'live',
          abs_expiry: 5,
          idle_expiry: 6,
          last_activity: 7,
          last_where: { machine: 'server-2', profile: 'other' },
        },
        {
          account: '2345678',
          user: 'x@example.com',
          role: '3',
          state: 'dying',
          abs_expiry: 9,
          idle_expiry: null,
          last_activity: 8,
          last_where: { machine: 'm', profile: 'p' },
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test('list: no store and no token answer store_unreachable', async () => {
    const down = toolsWith({ 'GET /list': () => ({ status: 503 }) });
    expect(await down.tools.popupList()).toEqual({ ok: false, code: 'store_unreachable' });
    const none = toolsWith({}, {}, { tokenMissing: true });
    expect(await none.tools.popupList()).toEqual({ ok: false, code: 'store_unreachable' });
  });

  test('open: imports the live user into a profile that remembers nobody, and remembers it', async () => {
    const { tools, browser, users } = toolsWith({
      'GET /list': listed(),
      'GET /entry': () => ({ status: 200, body: entryBody() }),
    });
    expect(users.get('work', '1234567_SB2')).toBeNull();
    const out = await tools.popupOpen({ account: '1234567_SB2' }, 'work');
    expect(out).toEqual({ ok: true, url: URL_OK, action: 'imported' });
    expect(browser.written).toHaveLength(1);
    expect(users.get('work', '1234567_SB2')).toBe('support_user@example.com');
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test('open: a live local session of the same user is only opened, never replaced', async () => {
    const { tools, browser, store } = toolsWith(
      { 'GET /list': listed(), 'GET /entry': () => ({ status: 200, body: entryBody() }) },
      liveLocal({ identity: sameTab }),
    );
    expect(await tools.popupOpen({ account: '1234567_SB2' }, 'work')).toEqual({
      ok: true,
      url: URL_OK,
      action: 'opened',
    });
    expect(browser.written).toHaveLength(0);
    expect(store.calls.some((c) => c.route === '/entry')).toBe(false);
  });

  test('open: alive with no tab uses the remembered user; unknown or other user changes nothing', async () => {
    const same = toolsWith({ 'GET /list': listed() }, liveLocal());
    same.users.set('work', '1234567_SB2', 'support_user@example.com');
    expect(await same.tools.popupOpen({ account: '1234567_SB2' }, 'work')).toMatchObject({
      ok: true,
      action: 'opened',
    });
    const other = toolsWith({ 'GET /list': listed() }, liveLocal());
    other.users.set('work', '1234567_SB2', 'someone.else@example.com');
    expect(await other.tools.popupOpen({ account: '1234567_SB2' }, 'work')).toEqual({
      ok: false,
      code: 'other_user',
    });
    const unknown = toolsWith({ 'GET /list': listed() }, liveLocal());
    expect(await unknown.tools.popupOpen({ account: '1234567_SB2' }, 'work')).toEqual({
      ok: false,
      code: 'could_not_check',
    });
    for (const h of [same, other, unknown]) expect(h.browser.written).toHaveLength(0);
  });

  test('open: a live local session of another user (tab) is refused', async () => {
    const { tools, browser } = toolsWith(
      { 'GET /list': listed() },
      liveLocal({ identity: { user: 'someone.else@example.com', role: '3', role_id: 'r' } }),
    );
    expect(await tools.popupOpen({ account: '1234567_SB2' }, 'work')).toEqual({
      ok: false,
      code: 'other_user',
    });
    expect(browser.written).toHaveLength(0);
  });

  test('open: a probe that cannot tell changes nothing', async () => {
    const unknown = toolsWith(
      { 'GET /list': listed(), 'GET /entry': () => ({ status: 200, body: entryBody() }) },
      liveLocal({ probe: 'unknown' }),
    );
    expect(await unknown.tools.popupOpen({ account: '1234567_SB2' }, 'work')).toEqual({
      ok: false,
      code: 'could_not_check',
    });
    expect(unknown.browser.written).toHaveLength(0);
  });

  test('open: a dead local session is replaced by the store copy', async () => {
    const { tools, browser } = toolsWith(
      { 'GET /list': listed(), 'GET /entry': () => ({ status: 200, body: entryBody() }) },
      liveLocal({ probe: 'dead' }),
    );
    expect(await tools.popupOpen({ account: '1234567_SB2' }, 'work')).toMatchObject({
      ok: true,
      action: 'imported',
    });
    expect(browser.written).toHaveLength(1);
  });

  test('open: two live users on one account, the user named in the click is taken', async () => {
    const entries = [
      row({ user: 'first@example.com', last_activity: 9 }),
      row({ user: 'support_user@example.com', last_activity: 1 }),
    ];
    const asked: Array<string | null> = [];
    const { tools } = toolsWith({
      'GET /list': listed(entries),
      'GET /entry': (_body, query) => {
        asked.push(query.get('user'));
        return { status: 200, body: entryBody() };
      },
    });
    await tools.popupOpen({ account: '1234567_SB2', user: 'Support_User@example.com' }, 'work');
    expect(asked).toEqual(['support_user@example.com']);
    const missing = toolsWith({ 'GET /list': listed(entries) });
    expect(
      await missing.tools.popupOpen({ account: '1234567_SB2', user: 'nobody@example.com' }, 'work'),
    ).toEqual({ ok: false, code: 'open_failed' });
  });

  test('open: no live entry, a bad account and a failed write answer open_failed without values', async () => {
    const empty = toolsWith({ 'GET /list': listed([]) });
    expect(await empty.tools.popupOpen({ account: '1234567_SB2' }, 'work')).toEqual({
      ok: false,
      code: 'open_failed',
    });
    expect(await empty.tools.popupOpen({ account: 'system' }, 'work')).toEqual({
      ok: false,
      code: 'open_failed',
    });
    const failing = toolsWith(
      { 'GET /list': listed(), 'GET /entry': () => ({ status: 200, body: entryBody() }) },
      {},
      { failWrite: true },
    );
    const out = await failing.tools.popupOpen({ account: '1234567_SB2' }, 'work');
    expect(out).toEqual({ ok: false, code: 'open_failed' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe('auto_renew on publish', () => {
  const live = { cookies: [cookie('JSESSIONID', SECRET)], probe: 'alive' as const };

  test('an explicit publish with a checked vault item sends whether it has a TOTP', async () => {
    for (const totp of [true, false]) {
      const { tools, store } = toolsWith(
        { 'POST /entry': () => ({ status: 200, body: { ok: true, stored: true, generation: 1 } }) },
        live,
        { totp },
      );
      await tools.call(
        'netsuite_session_publish',
        { account: '1234567_SB2', vault_item: ITEM },
        'work',
      );
      const sent = store.calls.find((c) => c.route === '/entry')!.body;
      expect(sent.auto_renew).toBe(totp);
    }
  });

  test('left out without a vault item, on a transparent publish, or when bw fails', async () => {
    const ok = () => ({ status: 200, body: { ok: true, stored: true, generation: 1 } });
    const plain = toolsWith({ 'POST /entry': ok }, live, { totp: true });
    await plain.tools.call(
      'netsuite_session_publish',
      { account: '1234567_SB2', user: 'a@b.c' },
      'work',
    );
    expect('auto_renew' in plain.store.calls.find((c) => c.route === '/entry')!.body).toBe(false);
    expect(plain.touched).not.toContain('vaultHasTotp');

    const failing = toolsWith({ 'POST /entry': ok }, live, { totp: 'throw' });
    await failing.tools.call(
      'netsuite_session_publish',
      { account: '1234567_SB2', vault_item: ITEM },
      'work',
    );
    expect('auto_renew' in failing.store.calls.find((c) => c.route === '/entry')!.body).toBe(false);

    const transparent = toolsWith(
      { 'POST /entry': ok },
      {
        ...live,
        identity: { user: 'a@b.c', role: '3', role_id: 'customrole3' },
      },
      { totp: true },
    );
    await transparent.tools.publishChanged(normalizeAccount('1234567_SB2')!, 'work', false);
    expect('auto_renew' in transparent.store.calls.find((c) => c.route === '/entry')!.body).toBe(
      false,
    );
    expect(transparent.touched).not.toContain('vaultHasTotp');
  });
});
