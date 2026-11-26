import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  FN_LIST_TOOL,
  FN_RUN_TOOL,
  FN_RUNS_TOOL,
  FN_SAVE_TOOL,
  handleFnToolCall,
  resetFnRuntime,
  type FnDeps,
} from './browser-functions';
import { FnRegistry, execGit, toYaml } from './fn-registry';
import { FnRunsLog } from './fn-runs-log';
import type { FnVault } from './fn-vault';
import type { FnDefinition } from './fn-definition';
import type { FnDriver, TabInfo } from './fn-runner';

// Every save here commits to a real git registry. Each git call spawns a
// process, and under the parallel suite on a busy machine a test can take
// longer than jest's 5 s default.
jest.setTimeout(30_000);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * A browser whose pages are plain objects: step code really runs (in Node),
 * with `location` and `page` (the tab's state, e.g. page.sent) in scope.
 */
function fakeBrowser() {
  const tabs = new Map<number, { url: string; page: Record<string, any> }>();
  const closed: number[] = [];
  const calls: string[] = [];
  let nextTab = 100;
  // Real time as the start: the run log files are named by the current month.
  let clock = Date.now();
  const info = (tabId: number): TabInfo => {
    const tab = tabs.get(tabId);
    return tab
      ? { exists: true, tabId, url: tab.url, status: 'complete' }
      : { exists: false, tabId };
  };
  const driver: FnDriver = {
    async openTab(url) {
      const tabId = nextTab++;
      tabs.set(tabId, { url, page: {} });
      return { tabId, windowId: 1 };
    },
    async closeTab(tabId) {
      closed.push(tabId);
      return tabs.delete(tabId);
    },
    async tabInfo(tabId) {
      return info(tabId);
    },
    async navigate(tabId, url) {
      const tab = tabs.get(tabId);
      if (tab) tab.url = url;
      return info(tabId);
    },
    async callTool(name, args): Promise<CallToolResult> {
      calls.push(name);
      const tab = tabs.get(args.tabId as number);
      if (!tab) return { content: [{ type: 'text', text: 'Tab not found' }], isError: true };
      if (name === 'chrome_javascript') {
        try {
          const run = new AsyncFunction(
            'location',
            'page',
            `return (async () => {\n${args.code}\n})()`,
          );
          const value = await run({ href: tab.url }, tab.page);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, result: JSON.stringify(value) }),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: { kind: 'runtime_error', message: err.message },
                }),
              },
            ],
            isError: true,
          };
        }
      }
      if (name === 'chrome_find_elements') {
        const total = (tab.page.selectors ?? []).includes(args.selector) ? 1 : 0;
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, total, items: [] }) }],
        };
      }
      // Echo the value like a careless tool would: the reply must still not carry it.
      tab.page.filled = [...(tab.page.filled ?? []), args.value];
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: true, tool: name, echoed: args.value }) },
        ],
      };
    },
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
  };
  return { driver, tabs, closed, calls };
}

let dir: string;
let deps: FnDeps;
let browser: ReturnType<typeof fakeBrowser>;
const ctx = { callProfile: null, sessionProfile: null };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-tools-'));
  browser = fakeBrowser();
  deps = {
    registry: new FnRegistry(path.join(dir, 'registry')),
    log: new FnRunsLog(path.join(dir, 'runs')),
    driverFor: () => browser.driver,
    connectedProfiles: () => ['work'],
    activeProfile: () => 'work',
    now: () => browser.driver.now(),
  };
});

afterEach(() => {
  resetFnRuntime();
  fs.rmSync(dir, { recursive: true, force: true });
});

function body(result: CallToolResult): any {
  const text = (result.content[0] as any).text as string;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function call(name: string, args: Record<string, any>) {
  return handleFnToolCall(name, args, ctx, deps);
}

async function save(def: FnDefinition) {
  const result = await call(FN_SAVE_TOOL, { name: def.name, definition: def, changelog: 'test' });
  expect(result.isError).toBeFalsy();
}

const readFn: FnDefinition = {
  name: 'acme.page.title',
  description: 'Read the page title',
  kind: 'read',
  params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  target: { url: 'https://acme.example.com/rec?id={id}' },
  steps: [{ id: 'read', type: 'js', code: 'return { url: location.href, id: args.id };' }],
};

const sendFn: FnDefinition = {
  name: 'acme.case.send',
  description: 'Send a message on a case',
  kind: 'send',
  params: {
    type: 'object',
    properties: { id: { type: 'integer' }, text: { type: 'string' } },
    required: ['id', 'text'],
  },
  target: { url: 'https://acme.example.com/msg?id={id}', host: 'acme.example.com' },
  steps: [
    {
      id: 'fill',
      type: 'js',
      code: 'page.body = args.text; return { to: "a@b.c", body: page.body };',
    },
    {
      id: 'submit',
      type: 'js',
      commit: true,
      code: 'page.sent = (page.sent || 0) + 1; return { sent: page.sent };',
    },
  ],
  preview: 'fill',
  dedupe_key: '{id}|{text}',
  verify_hint: 'check message rows of case {id}',
};

describe('chrome_fn_run', () => {
  test('a read runs in its own window, returns the value and closes the window', async () => {
    await save(readFn);
    const result = await call(FN_RUN_TOOL, {
      name: 'acme.page.title',
      params: { id: 7 },
      caller: 'me',
    });
    const out = body(result);
    expect(out.status).toBe('ok');
    expect(out.result).toEqual({ url: 'https://acme.example.com/rec?id=7', id: 7 });
    expect(browser.closed).toEqual([100]);
    expect(browser.tabs.size).toBe(0);
    const runs = body(await call(FN_RUNS_TOOL, {})).runs;
    expect(runs[0]).toMatchObject({
      fn: 'acme.page.title',
      status: 'ok',
      caller: 'me',
      phase: 'full',
    });
    expect(JSON.stringify(runs[0])).not.toContain('"id":7');
  });

  test('bad params never open a window', async () => {
    await save(readFn);
    const out = await call(FN_RUN_TOOL, { name: 'acme.page.title', params: { id: '7' } });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatch(/id: expected integer/);
    expect(browser.tabs.size).toBe(0);
  });

  test('a send previews first and commits exactly that in the same window', async () => {
    await save(sendFn);
    const refused = await call(FN_RUN_TOOL, {
      name: 'acme.case.send',
      params: { id: 1, text: 'hi' },
      confirm: true,
    });
    expect(body(refused)).toMatch(/a send runs in two calls/);
    expect(browser.tabs.size).toBe(0);

    const preview = body(
      await call(FN_RUN_TOOL, { name: 'acme.case.send', params: { id: 1, text: 'hi' } }),
    );
    expect(preview.status).toBe('preview');
    expect(preview.preview).toEqual({ to: 'a@b.c', body: 'hi' });
    const tab = browser.tabs.get(preview.window.tabId);
    expect(tab?.page.sent).toBeUndefined();

    const notConfirmed = await call(FN_RUN_TOOL, { run_id: preview.run_id });
    expect(body(notConfirmed)).toMatch(/Pass confirm:true/);

    const done = body(await call(FN_RUN_TOOL, { run_id: preview.run_id, confirm: true }));
    expect(done.status).toBe('ok');
    expect(done.result).toEqual({ sent: 1 });
    expect(browser.closed).toEqual([preview.window.tabId]);

    // The same message again is refused before a window opens.
    const again = body(
      await call(FN_RUN_TOOL, { name: 'acme.case.send', params: { id: 1, text: 'hi' } }),
    );
    const againConfirm = await call(FN_RUN_TOOL, { run_id: again.run_id, confirm: true });
    expect(body(againConfirm)).toMatch(/already committed/);
    const forced = body(
      await call(FN_RUN_TOOL, { run_id: again.run_id, confirm: true, allow_duplicate: true }),
    );
    expect(forced.status).toBe('ok');
  });

  test('a write may commit in one call, and reports its preview with the result', async () => {
    await save({ ...sendFn, name: 'acme.case.note', kind: 'write', dedupe_key: undefined });
    const out = body(
      await call(FN_RUN_TOOL, {
        name: 'acme.case.note',
        params: { id: 1, text: 'x' },
        confirm: true,
      }),
    );
    expect(out).toMatchObject({
      status: 'ok',
      result: { sent: 1 },
      preview: { to: 'a@b.c', body: 'x' },
    });
  });

  test('a failure before the commit says nothing changed; at the commit it is unknown', async () => {
    await save({
      ...sendFn,
      name: 'acme.case.broken',
      steps: [
        { id: 'fill', type: 'js', code: 'return { ok: true };' },
        { id: 'submit', type: 'js', commit: true, code: 'throw new Error("button gone");' },
      ],
    });
    const preview = body(
      await call(FN_RUN_TOOL, { name: 'acme.case.broken', params: { id: 2, text: 'y' } }),
    );
    const out = body(await call(FN_RUN_TOOL, { run_id: preview.run_id, confirm: true }));
    expect(out.status).toBe('unknown');
    expect(out.error).toMatchObject({ step: 'submit' });
    expect(out.error.message).toMatch(/button gone/);
    expect(out.verify_hint).toBe('check message rows of case 2');

    await save({
      ...sendFn,
      name: 'acme.case.early',
      steps: [
        { id: 'check', type: 'verify', code: 'return "recipient is wrong";' },
        { id: 'submit', type: 'js', commit: true, code: 'page.sent = 1; return 1;' },
      ],
      preview: undefined,
    });
    const early = body(
      await call(FN_RUN_TOOL, { name: 'acme.case.early', params: { id: 3, text: 'z' } }),
    );
    expect(early.status).toBe('failed');
    expect(early.error.message).toBe('verify failed: recipient is wrong');
    expect(early.refused).toBe(true);
    expect(early.note).toBe('A check of the function stopped the run. Nothing was committed.');
  });

  test('a page on the wrong host stops before the commit as failed, not unknown', async () => {
    await save({
      ...sendFn,
      name: 'acme.case.redirect',
      kind: 'write',
      steps: [
        { id: 'away', type: 'navigate', url: 'https://login.example.com/' },
        { id: 'submit', type: 'js', commit: true, code: 'page.sent = 1; return 1;' },
      ],
      preview: undefined,
      dedupe_key: undefined,
    });
    const out = body(
      await call(FN_RUN_TOOL, {
        name: 'acme.case.redirect',
        params: { id: 1, text: 'a' },
        confirm: true,
      }),
    );
    expect(out.status).toBe('failed');
    expect(out.error.message).toMatch(/page is on login.example.com, expected acme.example.com/);
  });

  test('pause, when and wait_for any drive a branching flow', async () => {
    await save({
      name: 'acme.login',
      description: 'Log in',
      kind: 'read',
      params: { type: 'object', properties: { code: { type: 'string' } } },
      target: { url: 'https://acme.example.com/start' },
      steps: [
        {
          id: 'where',
          type: 'wait_for',
          any: [
            { name: 'home', url: '/home' },
            { name: 'challenge', exists: '#code' },
          ],
        },
        {
          id: 'done',
          type: 'finish',
          when: { step: 'where', equals: 'home' },
          value: { state: 'already_logged_in' },
        },
        { id: 'ask', type: 'pause', needs: ['code'], message: 'enter the code' },
        {
          id: 'fill',
          type: 'tool',
          tool: 'chrome_computer',
          args: { action: 'fill', selector: '#code', value: '{code}' },
        },
        { id: 'result', type: 'finish', value: { state: 'logged_in' } },
      ],
    });
    browser.driver.openTab = async (url) => {
      browser.tabs.set(200, { url, page: { selectors: ['#code'] } });
      return { tabId: 200, windowId: 1 };
    };
    const paused = body(await call(FN_RUN_TOOL, { name: 'acme.login' }));
    expect(paused).toMatchObject({ status: 'paused', needs: ['code'], message: 'enter the code' });
    expect(paused.trace.find((t: any) => t.step === 'done').status).toBe('skipped');
    const bad = await call(FN_RUN_TOOL, { run_id: paused.run_id, params: { other: 1 } });
    expect(body(bad)).toMatch(/only paused params/);
    const done = body(
      await call(FN_RUN_TOOL, { run_id: paused.run_id, params: { code: '123456' } }),
    );
    expect(done).toMatchObject({ status: 'ok', result: { state: 'logged_in' } });
    expect(browser.calls).toContain('chrome_computer');
  });

  test('wait_for times out with the last error and closes the window', async () => {
    await save({
      ...readFn,
      name: 'acme.page.slow',
      steps: [{ id: 'ready', type: 'wait_for', until: 'page.ready === true', timeout_ms: 2000 }],
    });
    const out = body(await call(FN_RUN_TOOL, { name: 'acme.page.slow', params: { id: 1 } }));
    expect(out.status).toBe('failed');
    expect(out.error.message).toMatch(/still not ready after 2000 ms/);
    expect(browser.tabs.size).toBe(0);
  });

  test('session-ending pages are never loaded', async () => {
    await save({
      ...readFn,
      name: 'acme.page.logout',
      steps: [
        {
          id: 'bye',
          type: 'navigate',
          url: 'https://acme.example.com/app/login/secure/changerole.nl',
        },
      ],
    });
    const out = body(await call(FN_RUN_TOOL, { name: 'acme.page.logout', params: { id: 1 } }));
    expect(out.error.message).toMatch(/refused to load a session-ending page/);
  });

  test('results are redacted like chrome_javascript output', async () => {
    await save({
      ...readFn,
      name: 'acme.page.secret',
      steps: [
        { id: 'read', type: 'js', code: 'return { subsidiary: "Parent", sessionId: "abc" };' },
      ],
    });
    const out = body(await call(FN_RUN_TOOL, { name: 'acme.page.secret', params: { id: 1 } }));
    expect(out.result).toEqual({ subsidiary: 'Parent', sessionId: '<redacted>' });
  });
});

describe('chrome_fn_list', () => {
  test('hides functions that never ran successfully, then shows them as draft or proven', async () => {
    await save(readFn);
    await save(sendFn);
    expect(body(await call(FN_LIST_TOOL, {}))).toMatchObject({ functions: [], hidden_drafts: 2 });

    await call(FN_RUN_TOOL, { name: 'acme.page.title', params: { id: 1 } });
    await call(FN_RUN_TOOL, { name: 'acme.case.send', params: { id: 1, text: 'hi' } });
    const listed = body(await call(FN_LIST_TOOL, {})).functions;
    expect(listed.map((f: any) => [f.name, f.draft])).toEqual([
      ['acme.case.send', true],
      ['acme.page.title', false],
    ]);
    expect(body(await call(FN_LIST_TOOL, { query: 'title' })).functions).toHaveLength(1);
  });
});

describe('vault values', () => {
  const loginFn: FnDefinition = {
    name: 'acme.login',
    description: 'Log in',
    kind: 'read',
    params: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
    target: { url: 'https://acme.example.com/login' },
    vault: { password: { item: '{item}', field: 'password' } },
    steps: [
      {
        id: 'pw',
        type: 'tool',
        tool: 'chrome_computer',
        args: { action: 'fill', selector: '#password', value: '{vault.password}' },
      },
      { id: 'done', type: 'finish', value: { state: 'logged_in', echo: '{prev.pw.echoed}' } },
    ],
  };
  let reads: string[];

  beforeEach(() => {
    reads = [];
    const vault: FnVault = {
      async uris() {
        return [{ uri: 'https://example.com', match: null }];
      },
      async get(item, field) {
        reads.push(`${item}:${field}`);
        return 's3cr3t-pass';
      },
    };
    deps.vault = vault;
  });

  async function commitByHand(def: FnDefinition) {
    await save(readFn); // creates the repository
    const file = deps.registry.fileFor(def.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, toYaml({ ...def, version: 1 }));
    const repo = deps.registry.dir;
    await execGit(['add', '--', path.relative(repo, file)], repo);
    await execGit(
      ['-c', 'user.name=Person', '-c', 'user.email=p@example.com', 'commit', '-q', '-m', 'login'],
      repo,
    );
    return file;
  }

  test('chrome_fn_save never saves a definition that reads the vault', async () => {
    const out = await call(FN_SAVE_TOOL, {
      name: loginFn.name,
      definition: loginFn,
      changelog: 'x',
    });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatch(/never saved by chrome_fn_save/);
  });

  test('a person-committed function fills the value; the reply and the log never carry it', async () => {
    await commitByHand(loginFn);
    const out = body(await call(FN_RUN_TOOL, { name: 'acme.login', params: { item: 'item-1' } }));
    expect(out.status).toBe('ok');
    expect(out.result).toEqual({ state: 'logged_in', echo: '<vault value>' });
    expect(reads).toEqual(['item-1:password']);
    expect(JSON.stringify(out)).not.toContain('s3cr3t-pass');
    const runs = body(await call(FN_RUNS_TOOL, { name: 'acme.login' })).runs;
    expect(runs[0].vault_items).toEqual(['item-1']);
    expect(
      fs.readFileSync(
        path.join(
          dir,
          'runs',
          fs.readdirSync(path.join(dir, 'runs')).find((f) => f.endsWith('.jsonl'))!,
        ),
        'utf8',
      ),
    ).not.toContain('s3cr3t');
  });

  test('an uncommitted edit or a page off the item sites stops it before anything is typed', async () => {
    const file = await commitByHand(loginFn);
    fs.appendFileSync(file, '# edited\n');
    const dirty = await call(FN_RUN_TOOL, { name: 'acme.login', params: { item: 'item-1' } });
    expect(body(dirty)).toMatch(/runs only exactly as a person committed it/);
    expect(browser.tabs.size).toBe(0);

    await execGit(['checkout', '--', path.relative(deps.registry.dir, file)], deps.registry.dir);
    deps.vault = {
      async uris() {
        return [{ uri: 'https://other.example.org', match: null }];
      },
      async get() {
        throw new Error('must not be read');
      },
    };
    const off = body(await call(FN_RUN_TOOL, { name: 'acme.login', params: { item: 'item-1' } }));
    expect(off.status).toBe('failed');
    expect(off.error.message).toMatch(/is not a website of vault item item-1. Nothing was typed/);
  });

  test('keep_open never leaves a vault window open, and chrome_fn_save does not replace one', async () => {
    await commitByHand(loginFn);
    const out = body(
      await call(FN_RUN_TOOL, { name: 'acme.login', params: { item: 'item-1' }, keep_open: true }),
    );
    expect(out.status).toBe('ok');
    expect(out.window).toBeUndefined();
    expect(browser.tabs.size).toBe(0);
    const { vault: _vault, ...plain } = loginFn;
    const replace = await call(FN_SAVE_TOOL, {
      name: loginFn.name,
      definition: { ...plain, steps: [{ id: 'x', type: 'js', code: 'return 1;' }] },
      base_version: 1,
      changelog: 'take it over',
    });
    expect(body(replace)).toMatch(/maintained by hand/);
  });

  test('a vault function loads no helpers and has no pause', async () => {
    const errors = (
      await call(FN_SAVE_TOOL, {
        name: loginFn.name,
        definition: {
          ...loginFn,
          helpers: ['netsuite'],
          steps: [{ id: 'wait', type: 'pause', needs: ['item'] }, ...loginFn.steps],
        },
        changelog: 'x',
      })
    ).content[0] as any;
    expect(errors.text).toMatch(/loads no helpers/);
    expect(errors.text).toMatch(/has no pause step/);
  });

  test('a vault value may only be the whole value of a fill', async () => {
    const bad = {
      ...loginFn,
      steps: [{ id: 'leak', type: 'js', code: 'return 1;' }, ...loginFn.steps],
      target: { url: 'https://acme.example.com/login?p={vault.password}' },
    };
    const out = await call(FN_SAVE_TOOL, { name: bad.name, definition: bad, changelog: 'x' });
    expect(body(out)).toMatch(/\{vault\.password\} can only be the whole value of a fill/);
  });
});

describe('review fixes', () => {
  test('a send that pauses still needs its preview before a confirm', async () => {
    await save({
      ...sendFn,
      name: 'acme.case.code_send',
      params: {
        type: 'object',
        properties: { id: { type: 'integer' }, text: { type: 'string' }, code: { type: 'string' } },
        required: ['id', 'text'],
      },
      steps: [
        { id: 'fill', type: 'js', code: 'return { body: args.text };' },
        { id: 'ask', type: 'pause', needs: ['code'] },
        { id: 'submit', type: 'js', commit: true, code: 'page.sent = 1; return { sent: 1 };' },
      ],
    });
    const paused = body(
      await call(FN_RUN_TOOL, { name: 'acme.case.code_send', params: { id: 1, text: 'a' } }),
    );
    expect(paused.status).toBe('paused');
    const sneaky = await call(FN_RUN_TOOL, {
      run_id: paused.run_id,
      params: { code: '1' },
      confirm: true,
    });
    expect(body(sneaky)).toMatch(/a send commits only from its preview/);
    expect(browser.tabs.get(paused.window.tabId)?.page.sent).toBeUndefined();
    const preview = body(await call(FN_RUN_TOOL, { run_id: paused.run_id, params: { code: '1' } }));
    expect(preview.status).toBe('preview');
    const done = body(await call(FN_RUN_TOOL, { run_id: preview.run_id, confirm: true }));
    expect(done.status).toBe('ok');
  });

  test('a run log that cannot be written is a warning, not a lost outcome', async () => {
    await save({ ...sendFn, name: 'acme.case.note2', kind: 'write', dedupe_key: undefined });
    const original = deps.log.append.bind(deps.log);
    deps.log.append = (record) => {
      if (record.phase !== 'commit_start') throw new Error('EBUSY: resource busy');
      return original(record);
    };
    const out = body(
      await call(FN_RUN_TOOL, {
        name: 'acme.case.note2',
        params: { id: 1, text: 'x' },
        confirm: true,
      }),
    );
    expect(out.status).toBe('ok');
    expect(out.log_warning).toMatch(/EBUSY/);
  });

  test('a bridge that died mid-commit still blocks the duplicate', async () => {
    await save(sendFn);
    const preview = body(
      await call(FN_RUN_TOOL, { name: 'acme.case.send', params: { id: 9, text: 'x' } }),
    );
    // Only the commit_start line reaches the log, as if the bridge died during the submit.
    const original = deps.log.append.bind(deps.log);
    deps.log.append = (record) => (record.phase === 'commit_start' ? original(record) : null);
    await call(FN_RUN_TOOL, { run_id: preview.run_id, confirm: true });
    deps.log.append = original;
    const again = body(
      await call(FN_RUN_TOOL, { name: 'acme.case.send', params: { id: 9, text: 'x' } }),
    );
    const refused = await call(FN_RUN_TOOL, { run_id: again.run_id, confirm: true });
    expect(body(refused)).toMatch(/already committed .* unknown/);
  });

  test('a typo in a key or a write without target.host does not save', async () => {
    const typo = await call(FN_SAVE_TOOL, {
      name: 'acme.case.typo',
      definition: {
        ...sendFn,
        name: 'acme.case.typo',
        dedup_key: '{id}',
        target: { url: 'https://acme.example.com/', hots: 'acme.example.com' },
        steps: [{ id: 'go', type: 'js', comit: true, code: 'return 1;' }],
      },
      changelog: 'x',
    });
    const text = body(typo);
    expect(text).toMatch(/dedup_key: unknown key/);
    expect(text).toMatch(/target\.hots: unknown key/);
    expect(text).toMatch(/comit: unknown key/);
    expect(text).toMatch(/target\.host: required for kind send/);
  });

  test('a cancelled preview reports whether its window really closed', async () => {
    await save(sendFn);
    const preview = body(
      await call(FN_RUN_TOOL, { name: 'acme.case.send', params: { id: 2, text: 'y' } }),
    );
    browser.driver.closeTab = async () => false;
    const cancelled = body(await call(FN_RUN_TOOL, { run_id: preview.run_id, cancel: true }));
    expect(cancelled).toMatchObject({ cancelled: true, window_closed: false });
    expect(cancelled.note).toMatch(/still open/);
  });
});

describe('refusals', () => {
  test('a verify that says no is a refusal, not a fault', async () => {
    await save({
      ...readFn,
      name: 'acme.page.guarded',
      steps: [{ id: 'guard', type: 'verify', code: 'return "wrong record";' }],
    });
    const out = body(await call(FN_RUN_TOOL, { name: 'acme.page.guarded', params: { id: 1 } }));
    expect(out).toMatchObject({ status: 'failed', refused: true });
    expect(deps.log.state()['acme.page.guarded'].failures).toBe(0);
    expect(body(await call(FN_RUNS_TOOL, { name: 'acme.page.guarded' })).runs[0].refused).toBe(
      true,
    );
  });
});

describe('chrome_fn_save', () => {
  test('rollback saves an old version as the newest', async () => {
    await save(readFn);
    await call(FN_SAVE_TOOL, {
      name: readFn.name,
      definition: { ...readFn, description: 'changed' },
      base_version: 1,
      changelog: 'v2',
    });
    const rolled = body(
      await call(FN_SAVE_TOOL, {
        name: readFn.name,
        from_version: 1,
        base_version: 2,
        changelog: 'v2 broke it',
      }),
    );
    expect(rolled).toMatchObject({ version: 3, previous_version: 2 });
    expect((deps.registry.get(readFn.name)?.definition as FnDefinition).description).toBe(
      'Read the page title',
    );
  });
});

describe('bridge tools in tool steps', () => {
  const storeFn: FnDefinition = {
    name: 'acme.login.store',
    description: 'Take a shared session first',
    kind: 'read',
    params: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
    target: { url: 'https://acme.example.com/home' },
    steps: [
      {
        id: 'store',
        type: 'tool',
        tool: 'netsuite_session_ensure',
        args: { account: '{account}', wait_for_lock: true },
        optional: true,
      },
      {
        id: 'from_store',
        type: 'finish',
        when: { step: 'store.state', equals: 'imported' },
        value: { state: 'logged_in', source: 'store', fp: '{prev.store.fp}' },
      },
      { id: 'login', type: 'js', code: 'return { state: "logged_in", source: "form" };' },
    ],
  };

  test('runs in the bridge with the run profile and no tab; a field of its value steers when', async () => {
    const seen: Array<{ name: string; args: any; profile: string }> = [];
    deps.callBridgeTool = async (name, args, profile) => {
      seen.push({ name, args, profile });
      return {
        content: [{ type: 'text', text: JSON.stringify({ state: 'imported', fp: 'ab12cd34' }) }],
      };
    };
    await save(storeFn);
    const out = body(
      await call(FN_RUN_TOOL, { name: storeFn.name, params: { account: '1234567' } }),
    );
    expect(out.status).toBe('ok');
    expect(out.result).toEqual({ state: 'logged_in', source: 'store', fp: 'ab12cd34' });
    expect(seen).toEqual([
      {
        name: 'netsuite_session_ensure',
        args: { account: '1234567', wait_for_lock: true },
        profile: 'work',
      },
    ]);
    expect(browser.calls).not.toContain('netsuite_session_ensure');
  });

  test('an optional step that fails becomes {state: error} and the run goes on', async () => {
    deps.callBridgeTool = async () => ({
      content: [
        {
          type: 'text',
          text: 'Error: netsuite_session_ensure belongs to the NetSuite module, which is switched off',
        },
      ],
      isError: true,
    });
    await save(storeFn);
    const out = body(
      await call(FN_RUN_TOOL, { name: storeFn.name, params: { account: '1234567' } }),
    );
    expect(out.status).toBe('ok');
    expect(out.result).toEqual({ state: 'logged_in', source: 'form' });
  });

  test('without bridge tools an optional step is an error value, a required one fails the run', async () => {
    await save(storeFn);
    const optional = body(
      await call(FN_RUN_TOOL, { name: storeFn.name, params: { account: '1234567' } }),
    );
    expect(optional.result).toEqual({ state: 'logged_in', source: 'form' });

    const required = {
      ...storeFn,
      name: 'acme.login.required',
      steps: storeFn.steps.map(({ optional: _optional, ...s }) => s),
    };
    await save(required as FnDefinition);
    const failed = body(
      await call(FN_RUN_TOOL, { name: required.name, params: { account: '1234567' } }),
    );
    expect(failed.status).toBe('failed');
    expect(JSON.stringify(failed)).toMatch(/cannot run bridge tools/);
  });

  test('a bridge tool that never answers stops at the step timeout', async () => {
    deps.callBridgeTool = () => new Promise<CallToolResult>(() => {});
    const slow: FnDefinition = {
      ...storeFn,
      name: 'acme.login.slow',
      steps: storeFn.steps.map((s) => (s.id === 'store' ? { ...s, timeout_ms: 50 } : s)),
    };
    await save(slow);
    const out = body(await call(FN_RUN_TOOL, { name: slow.name, params: { account: '1234567' } }));
    expect(out.status).toBe('ok');
    expect(out.result).toEqual({ state: 'logged_in', source: 'form' });
  });

  test('an optional navigate that fails is an error value and the run goes on', async () => {
    const nav: FnDefinition = {
      name: 'acme.nav.optional',
      description: 'x',
      kind: 'read',
      params: { type: 'object', properties: {} },
      target: { url: 'https://acme.example.com/home' },
      steps: [
        { id: 'go', type: 'navigate', url: 'https://acme.example.com/logout', optional: true },
        {
          id: 'done',
          type: 'finish',
          when: { step: 'go.state', equals: 'error' },
          value: 'fell through',
        },
      ],
    };
    await save(nav);
    const out = body(await call(FN_RUN_TOOL, { name: nav.name, params: {} }));
    expect(out.status).toBe('ok');
    expect(out.result).toBe('fell through');
  });
});
