import { describe, expect, test } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { accountFromHost, fingerprint, normalizeAccount } from './account';
import { ExpectedUsers } from './expected-users';
import { NsSessionTools, type NsCookie, type NsDeps } from './session-tools';
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
  const client = new NsStoreClient(() => '/state/ns-store-token', io, 'mokutab test');
  return { client, logs, advance: (ms: number) => (clock += ms) };
}

describe('store client', () => {
  test('token file: line 1 token, optional line 2 base URL', () => {
    expect(parseTokenFile('abc\n')).toEqual({ token: 'abc' });
    expect(parseTokenFile('abc\r\nhttp://10.0.0.2:12422/api/ns-sessions/\n')).toEqual({
      token: 'abc',
      base: 'http://10.0.0.2:12422/api/ns-sessions',
    });
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
    expect(calls[0].headers['X-NS-Store-Client']).toBe('mokutab test');
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
}

function toolsWith(
  routes: Parameters<typeof fakeStore>[0],
  browser: Partial<FakeBrowser> = {},
  opts: { tokenMissing?: boolean; usersFile?: string; failWrite?: boolean } = {},
) {
  const store = fakeStore(routes);
  const { client, logs } = clientWith(
    store.fetchFn,
    opts.tokenMissing ? { mtime: () => null } : {},
  );
  const b: FakeBrowser = { cookies: [], written: [], identity: null, ...browser };
  const usersFile =
    opts.usersFile ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-users-')), 'u.json');
  let clock = Date.parse('2026-11-26T15:00:00Z');
  const sleeps: number[] = [];
  const deps: NsDeps = {
    store: client,
    users: new ExpectedUsers(
      () => usersFile,
      () => clock,
    ),
    readCookies: async () => b.cookies,
    writeCookies: async (_p, _h, cookies) => {
      if (opts.failWrite) throw new Error(`chrome refused ${cookies[0]?.value}`);
      b.written.push(cookies);
      b.cookies = cookies;
      return cookies.length;
    },
    tabIdentity: async () => b.identity,
    vaultUsername: async () => 'Support_BGC@example.com',
    resolveProfile: (p) => p ?? 'work',
    machine: 'laptop',
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { tools: new NsSessionTools(deps), store, browser: b, logs, sleeps, users: deps.users };
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

describe('netsuite_session_* tools', () => {
  test('without a token every tool says store_unconfigured', async () => {
    const { tools } = toolsWith({}, {}, { tokenMissing: true });
    for (const name of [
      'netsuite_session_status',
      'netsuite_session_ensure',
      'netsuite_session_publish',
      'netsuite_session_lock',
      'netsuite_session_unlock',
    ]) {
      const out = parse(await tools.call(name, { account: '1234567_SB2', user: 'a@b.c' }, null));
      expect(
        name === 'netsuite_session_publish'
          ? ['store_unconfigured', 'no_session']
          : ['store_unconfigured'],
      ).toContain(out.state);
    }
  });

  test('status lists metadata and drops anything value-shaped', async () => {
    const { tools, store } = toolsWith({
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
    expect(store.calls[0].route).toBe('/list');
  });

  test('ensure imports the live session and remembers the user', async () => {
    const { tools, browser, users } = toolsWith({
      'GET /entry': () => ({ status: 200, body: entryBody() }),
    });
    const result = await tools.call(
      'netsuite_session_ensure',
      { account: '1234567_SB2' },
      'work',
    );
    const out = parse(result);
    expect(out.state).toBe('imported');
    expect(out.fp).toBe(fingerprint(SECRET));
    expect(out.cookies_set).toBe(2);
    expect(browser.written).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(OTHER);
    expect(users.get('work', '1234567_SB2')).toBe('support_bgc@example.com');

    const again = parse(
      await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'work'),
    );
    expect(again.state).toBe('already_live');
    expect(browser.written).toHaveLength(1);
  });

  test('ensure asks for the vault user, or the remembered one', async () => {
    const asked: Array<string | null> = [];
    const { tools, users } = toolsWith({
      'GET /entry': (_b, q) => {
        asked.push(q.get('user'));
        return { status: 200, body: entryBody() };
      },
    });
    await tools.call(
      'netsuite_session_ensure',
      { account: '1234567_SB2', vault_item: '081555dc-d350-485b-99ae-b4ed017046b4' },
      'work',
    );
    users.set('bb', '1234567_SB2', 'other@example.com');
    await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, 'bb');
    expect(asked).toEqual(['support_bgc@example.com', 'other@example.com']);
  });

  test('ensure: none, or locked_by another machine; wait_for_lock polls every 3 s', async () => {
    let polls = 0;
    const lockUntil = new Date(Date.parse('2026-11-26T15:00:00Z') + 9_000).toISOString();
    const { tools, sleeps } = toolsWith({
      'GET /entry': () =>
        polls++ < 2
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
    const waited = parse(
      await tools.call(
        'netsuite_session_ensure',
        { account: '1234567_SB2', wait_for_lock: true },
        'work',
      ),
    );
    expect(waited.state).toBe('imported');
    expect(sleeps).toEqual([3_000]);

    const { tools: empty } = toolsWith({
      'GET /list': () => ({ status: 200, body: { ok: true, entries: [] } }),
    });
    expect(
      parse(await empty.call('netsuite_session_ensure', { account: '1234567_SB2' }, null)).state,
    ).toBe('none');
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
    const out = parse(
      await tools.call('netsuite_session_ensure', { account: '9089979' }, 'work'),
    );
    expect(out.state).toBe('imported');
    expect(out.user).toBe('new@example.com');
    expect(out.note).toMatch(/most recently active/);
    expect(users.get('work', '9089979')).toBe('new@example.com');
  });

  test('publish: no_session, published, unchanged, dead_session, store_full', async () => {
    const answers = [
      { status: 200, body: { ok: true, stored: true, generation: 5 } },
      { status: 200, body: { ok: true, stored: false, generation: 5 } },
      { status: 409, body: { ok: false, code: 'dead_fp' } },
      { status: 409, body: { ok: false, code: 'store_full' } },
    ];
    const { tools, store, browser } = toolsWith({ 'POST /entry': () => answers.shift()! });
    expect(
      parse(await tools.call('netsuite_session_publish', { account: '1234567_SB2' }, null)).state,
    ).toBe('no_session');
    browser.cookies = [cookie('JSESSIONID', SECRET), cookie('NS_ROUTING', OTHER, '.' + HOST)];
    browser.identity = { user: 'Support_BGC@example.com', role: '3', role_id: 'administrator' };
    const published = await tools.call(
      'netsuite_session_publish',
      { account: '1234567_SB2', login_at: true },
      'work',
    );
    expect(parse(published)).toMatchObject({
      state: 'published',
      user: 'support_bgc@example.com',
      fp: fingerprint(SECRET),
      generation: 5,
    });
    expect(JSON.stringify(published)).not.toContain(SECRET);
    const sent = store.calls[0].body;
    expect(sent).toMatchObject({
      account: '1234567_SB2',
      host: HOST,
      fp: fingerprint(SECRET),
      origin: { machine: 'laptop', profile: 'work' },
    });
    expect(typeof sent.login_at).toBe('number');
    expect(
      parse(await tools.call('netsuite_session_publish', { account: '1234567_SB2' }, null)).state,
    ).toBe('unchanged');
    expect(
      parse(await tools.call('netsuite_session_publish', { account: '1234567_SB2' }, null)).state,
    ).toBe('dead_session');
    expect(
      parse(await tools.call('netsuite_session_publish', { account: '1234567_SB2' }, null)).state,
    ).toBe('no_store');
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
        {
          account: '1234567_SB2',
          vault_item: '081555dc-d350-485b-99ae-b4ed017046b4',
          run_id: 'R1',
          ttl_s: 500,
        },
        'work',
      ),
    );
    expect(locked).toEqual({
      state: 'locked',
      account: '1234567_SB2',
      user: 'support_bgc@example.com',
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
    expect(noUser.isError).toBe(true);
    expect(parse(noUser).error.code).toBe('UserRequired');
  });

  test('a bad account is refused; no cookie value reaches an error or a log line', async () => {
    const { tools, logs } = toolsWith(
      { 'GET /entry': () => ({ status: 200, body: entryBody() }) },
      {},
      { failWrite: true },
    );
    const bad = await tools.call('netsuite_session_ensure', { account: 'system' }, null);
    expect(parse(bad).error.code).toBe('InvalidAccount');
    const failed = await tools.call('netsuite_session_ensure', { account: '1234567_SB2' }, null);
    expect(failed.isError).toBe(true);
    const text = JSON.stringify(failed);
    expect(text).toContain('chrome refused');
    expect(text).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain(SECRET);
  });
});
