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
      return 'Support_BGC@example.com';
    },
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
  user: 'support_bgc@example.com',
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
      user: 'support_bgc@example.com',
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(OTHER);
    expect(users.get('work', '1234567_SB2')).toBe('support_bgc@example.com');

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
    expect(asked).toEqual(['support_bgc@example.com']);
    expect(out.user_source).toBe('vault');
    expect(out.user).toBeUndefined();
    expect(JSON.stringify(result).toLowerCase()).not.toContain('support_bgc');

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
              user: 'support_bgc@example.com',
              lock: { holder: { machine: 'server-2', profile: 'bsd' }, until: lockUntil },
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
    expect(JSON.stringify(mismatch).toLowerCase()).not.toContain('support_bgc');
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
    expect(store.calls[1].body.user).toBe('support_bgc@example.com');
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
          holder: { machine: 'server-2', profile: 'bsd' },
          until: 'T2',
        },
      },
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
      user: 'support_bgc@example.com',
      holder: { machine: 'laptop', profile: 'work', run_id: 'R1' },
      ttl_s: 120,
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
