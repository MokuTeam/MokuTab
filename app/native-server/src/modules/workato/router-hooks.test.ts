/**
 * The Workato hooks as the router runs them: the workspace re-check after a
 * profile reconnects, following a switch_environment, and the recipe and LCAP
 * file params through prepare/finish, top-level and in a nested orchestrator
 * call. Everything goes through createToolRouter; only the extension is faked.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createToolRouter } from '../../mcp/register-tools';
import { profileRegistry } from '../../server/profile-registry';

type Reply = { status: string; data?: any; error?: string };
type Handler = (name: string, args: any) => Reply | Promise<Reply> | undefined;

const PINNED = { host: 'app.workato.com', workspace_id: 5150, environment: 'production' };

const text = (result: any) => (result?.content?.[0]?.text ?? '') as string;

const ok = (body: unknown): Reply => ({
  status: 'success',
  data: {
    content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
    isError: false,
  },
});

/** A workato_session_context answer, as the extension gives it. */
const context = (tabId: number, overrides: Record<string, unknown> = {}): Reply =>
  ok(
    'tab context\n' +
      JSON.stringify({
        tab_id: tabId,
        host: 'app.workato.com',
        workspace_id: 5150,
        workspace_name: 'Acme prod',
        environment: 'production',
        user_id: 7,
        ...overrides,
      }),
  );

const RECIPE_CODE = {
  number: 0,
  keyword: 'trigger',
  provider: 'workato_recipe_function',
  name: 'execute',
  as: 'a1b2c3d4',
  input: {},
  block: [],
};

let generation = 1;
let calls: { name: string; args: any }[] = [];
let tmp: string;

/** Fake the extension: every request is recorded, `handler` answers (default ok). */
function fakeExtension(handler: Handler) {
  jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium']);
  jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('centium');
  jest.spyOn(profileRegistry, 'getGeneration').mockImplementation(() => generation);
  jest
    .spyOn(profileRegistry, 'sendRequest')
    .mockImplementation(async (_profile: any, payload: any) => {
      calls.push({ name: payload?.name, args: payload?.args ?? {} });
      return ((await handler(payload?.name, payload?.args ?? {})) ?? ok({ ok: true })) as any;
    });
}

/** The tool names sent since the last call, and forget them. */
const sent = () => calls.splice(0).map((call) => call.name);

async function pinnedRouter(tabId = 42) {
  const router = createToolRouter();
  await router.handleToolCall('chrome_switch_profile', { profile: 'centium', tabId });
  calls.length = 0;
  return router;
}

async function sessionContext(router: ReturnType<typeof createToolRouter>) {
  const listed = await router.handleToolCall('chrome_list_profiles', {});
  return JSON.parse(text(listed)).session_context;
}

beforeEach(() => {
  generation = 1;
  calls = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'router-hooks-'));
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the workspace re-check after a profile reconnects', () => {
  test('a workspace that moved refuses the call and sends nothing else', async () => {
    let workspace = 5150;
    fakeExtension((name, args) =>
      name === 'workato_session_context'
        ? context(args.tabId, { workspace_id: workspace })
        : undefined,
    );
    const router = await pinnedRouter();

    generation = 2;
    workspace = 9999;
    const refused = await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(text(refused)).error).toEqual({
      code: 'ContextChanged',
      message:
        'profile "centium" reconnected and tab 42 is now workspace 9999, ' +
        'environment production, but this session is pinned to workspace 5150, environment ' +
        'production. Nothing was sent. Check workato_session_context, then re-pin with ' +
        'chrome_switch_profile(profile, tabId).',
    });
    expect(sent()).toEqual(['workato_session_context']);

    // The refusal did not adopt the generation: the next call checks again.
    workspace = 5150;
    await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    expect(sent()).toEqual(['workato_session_context', 'workato_recipe_status']);
  });

  test('an unchanged workspace is checked once per generation and refreshes the pin', async () => {
    let name = 'Acme prod';
    fakeExtension((tool, args) =>
      tool === 'workato_session_context'
        ? context(args.tabId, { workspace_name: name })
        : undefined,
    );
    const router = await pinnedRouter();

    generation = 2;
    name = 'Acme production';
    await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    expect(sent()).toEqual(['workato_session_context', 'workato_recipe_status']);
    await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    expect(sent()).toEqual(['workato_recipe_status']);
    expect((await sessionContext(router)).workspace_name).toBe('Acme production');

    generation = 3;
    await router.handleToolCall('workato_recipe_status', { recipe_id: 2 });
    expect(sent()).toEqual(['workato_session_context', 'workato_recipe_status']);
  });

  test('a failed probe lets the call through and checks again next time', async () => {
    let probeFails = true;
    fakeExtension((name, args) => {
      if (name !== 'workato_session_context') return undefined;
      return probeFails ? { status: 'error', error: 'tab busy' } : context(args.tabId);
    });
    probeFails = false;
    const router = await pinnedRouter();

    generation = 2;
    probeFails = true;
    const through = await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    expect(through.isError).toBeFalsy();
    expect(sent()).toEqual(['workato_session_context', 'workato_recipe_status']);
    probeFails = false;
    await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    expect(sent()).toEqual(['workato_session_context', 'workato_recipe_status']);
  });

  test('switch_environment is not re-checked; the next Workato call is, once', async () => {
    fakeExtension((name, args) =>
      name === 'workato_session_context' ? context(args.tabId) : undefined,
    );
    const router = await pinnedRouter();

    generation = 2;
    await router.handleToolCall('workato_switch_environment', { environment: 'development' });
    expect(sent()).toEqual(['workato_switch_environment']);
    await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    expect(sent()).toEqual([
      'workato_session_context',
      'workato_recipe_status',
      'workato_recipe_status',
    ]);
  });

  test('a re-check answer that lands after a re-pin does not touch the new pin', async () => {
    let releaseProbe: (reply: Reply) => void = () => {};
    let holdProbe = false;
    fakeExtension((name, args) => {
      if (name !== 'workato_session_context') return undefined;
      if (holdProbe && args.tabId === 42) {
        return new Promise<Reply>((resolve) => {
          releaseProbe = resolve;
        });
      }
      return context(args.tabId, args.tabId === 77 ? { workspace_name: 'Second tab' } : {});
    });
    const router = await pinnedRouter(42);

    generation = 2;
    holdProbe = true;
    const pending = router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    // The session moves to another tab while the re-check of tab 42 is out.
    await router.handleToolCall('chrome_switch_profile', { profile: 'centium', tabId: 77 });
    releaseProbe(context(42, { workspace_name: 'Stale name', host: 'stale.workato.com' }));
    await pending;

    const pinned = await sessionContext(router);
    expect(pinned).toMatchObject({
      tab_id: 77,
      host: 'app.workato.com',
      workspace_name: 'Second tab',
    });
  });
});

describe('a re-check that a re-pin overtakes', () => {
  test('its refusal is dropped: the call goes on under the new pin', async () => {
    let releaseProbe: (reply: Reply) => void = () => {};
    let holdProbe = false;
    fakeExtension((name, args) => {
      if (name !== 'workato_session_context') return undefined;
      if (holdProbe && args.tabId === 42) {
        return new Promise<Reply>((resolve) => {
          releaseProbe = resolve;
        });
      }
      return context(args.tabId);
    });
    const router = await pinnedRouter(42);

    generation = 2;
    holdProbe = true;
    const pending = router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    await router.handleToolCall('chrome_switch_profile', { profile: 'centium', tabId: 77 });
    calls.length = 0;
    // The old tab moved to another workspace; that is no longer this session's pin.
    releaseProbe(context(42, { workspace_id: 9999 }));
    const result = await pending;

    expect(result.isError).toBeFalsy();
    expect(text(result)).not.toMatch(/ContextChanged/);
    expect(calls).toEqual([
      {
        name: 'workato_recipe_status',
        args: { recipe_id: 1, tabId: 77, expected_context: PINNED },
      },
    ]);
  });
});

describe('following a workato_switch_environment', () => {
  const switched = () =>
    ok(
      'Switched.\n' +
        JSON.stringify({
          after: { workspace_id: 77, workspace_name: 'Other', environment: 'development' },
        }),
    );

  test('the pin adopts the verified new context, and the next call expects it', async () => {
    fakeExtension((name, args) => {
      if (name === 'workato_session_context') return context(args.tabId);
      if (name === 'workato_switch_environment') return switched();
      return undefined;
    });
    const router = await pinnedRouter();

    // A profile reconnected since the pin: the registry moved on. The switch
    // itself is not re-checked, and its follow adopts this generation.
    generation = 2;
    const result = await router.handleToolCall('workato_switch_environment', {
      environment: 'development',
    });
    expect(result.isError).toBeFalsy();
    // The switch itself carries no expected_context: it exists to leave it.
    expect(calls[0].args.expected_context).toBeUndefined();
    expect(calls[0].args.tabId).toBe(42);
    calls.length = 0;

    expect(await sessionContext(router)).toMatchObject({
      tab_id: 42,
      workspace_id: 77,
      workspace_name: 'Other',
      environment: 'development',
    });

    // The follow adopted generation 2, so the next call sends no probe (one
    // would also see the old workspace and refuse), and the new workspace is
    // what it is checked against.
    await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    expect(calls).toEqual([
      {
        name: 'workato_recipe_status',
        args: {
          recipe_id: 1,
          tabId: 42,
          expected_context: {
            host: 'app.workato.com',
            workspace_id: 77,
            environment: 'development',
          },
        },
      },
    ]);
  });

  test('a failed switch leaves the pin as it was', async () => {
    fakeExtension((name, args) => {
      if (name === 'workato_session_context') return context(args.tabId);
      if (name === 'workato_switch_environment') {
        return {
          status: 'success',
          data: { content: [{ type: 'text', text: 'no' }], isError: true },
        };
      }
      return undefined;
    });
    const router = await pinnedRouter();
    await router.handleToolCall('workato_switch_environment', { environment: 'development' });
    expect(await sessionContext(router)).toMatchObject(PINNED);
  });
});

describe('file params through prepare and finish', () => {
  function fakeWorkato() {
    fakeExtension((name, args) => {
      if (name === 'workato_session_context') return context(args.tabId);
      if (name === 'workato_pull_recipe') {
        return {
          status: 'success',
          data: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  recipe_id: args.recipe_id,
                  code: RECIPE_CODE,
                  version: { version_no: 4, config: '[]' },
                }),
              },
              {
                type: 'text',
                text:
                  '{"context":{"tab_id":42,"host":"app.workato.com","workspace_id":5150,' +
                  '"workspace_name":"Acme prod","environment":"production"}}',
              },
            ],
            isError: false,
          },
        };
      }
      if (name === 'workato_lcap_page_get') {
        return ok({ page_id: 3, name: 'Home', updated_at: 'u1', content: { layout: [] } });
      }
      if (name === 'workato_ui_save_recipe_code') {
        return ok({ recipe_id: args.recipe_id, version_no: 5, code_errors: [] });
      }
      if (name === 'workato_recipe_status') {
        return ok({ recipe_id: args.recipe_id, running: false, name: 'r' });
      }
      return undefined;
    });
  }

  test('pull_recipe(out_file): the extension never sees the path; the file gets an origin', async () => {
    fakeWorkato();
    const router = await pinnedRouter();
    const outFile = path.join(tmp, 'recipe.json');

    const result = await router.handleToolCall('workato_pull_recipe', {
      recipe_id: 11,
      out_file: outFile,
    });

    expect(calls).toHaveLength(1);
    // The file needs the whole tree, so the pull asks for the full view.
    expect(calls[0].args).toEqual({
      recipe_id: 11,
      view: 'full',
      tabId: 42,
      expected_context: PINNED,
    });
    const summary = JSON.parse(text(result));
    expect(summary.saved_to).toBe(path.resolve(outFile));
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(written.origin).toMatchObject({
      profile: 'centium',
      tab_id: 42,
      host: 'app.workato.com',
      workspace_id: 5150,
      workspace_name: 'Acme prod',
      environment: 'production',
    });
  });

  test('ui_save_recipe_code(code_path): the file becomes code before the extension call', async () => {
    fakeWorkato();
    const router = await pinnedRouter();
    const codePath = path.join(tmp, 'code.json');
    fs.writeFileSync(codePath, JSON.stringify(RECIPE_CODE));

    await router.handleToolCall('workato_ui_save_recipe_code', {
      recipe_id: 11,
      code_path: codePath,
      comment: 'c',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args.code).toEqual(RECIPE_CODE);
    expect(calls[0].args.code_path).toBeUndefined();
    expect(calls[0].args.expected_context).toEqual(PINNED);
  });

  test('lcap_page_get(out_file) writes the tree; lcap_page_save(content_path) reads it back', async () => {
    fakeWorkato();
    const router = await pinnedRouter();
    const pageFile = path.join(tmp, 'page.json');

    const got = await router.handleToolCall('workato_lcap_page_get', {
      page_id: 3,
      out_file: pageFile,
    });
    expect(calls[0].args).toEqual({
      page_id: 3,
      view: 'full',
      tabId: 42,
      expected_context: PINNED,
    });
    expect(JSON.parse(text(got)).saved_to).toBe(path.resolve(pageFile));
    expect(JSON.parse(fs.readFileSync(pageFile, 'utf8')).content).toEqual({ layout: [] });
    calls.length = 0;

    await router.handleToolCall('workato_lcap_page_save', {
      page_id: 3,
      content_path: pageFile,
      expected_updated_at: 'u1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args.content).toEqual({ layout: [] });
    expect(calls[0].args.content_path).toBeUndefined();
  });

  test('a nested orchestrator call gets the same file params and pin', async () => {
    fakeWorkato();
    const router = await pinnedRouter();
    const codePath = path.join(tmp, 'callee.json');
    fs.writeFileSync(codePath, JSON.stringify(RECIPE_CODE));

    const result = await router.handleToolCall('workato_recipe_save_with_dependents', {
      recipe_id: 76902508,
      code_path: codePath,
      dependent_recipe_ids: [76887741],
    });

    expect(result.isError).toBe(false);
    const saves = calls.filter((call) => call.name === 'workato_ui_save_recipe_code');
    expect(saves).toHaveLength(1);
    expect(saves[0].args.code).toEqual(RECIPE_CODE);
    expect(saves[0].args.code_path).toBeUndefined();
    for (const call of calls) {
      expect(call.args.tabId).toBe(42);
      expect(call.args.expected_context).toEqual(PINNED);
    }
  });
});
