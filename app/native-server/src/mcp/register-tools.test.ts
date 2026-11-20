import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { NativeMessageType } from '@mokuhub/mokutab-shared';
import {
  createToolRouter,
  PROFILE_ROUTING_ARG,
  withProfileRoutingToolSchemas,
} from './register-tools';
import { profileRegistry } from '../server/profile-registry';
import nativeMessagingHostInstance from '../native-messaging-host';

/** A workato_session_context response, as the extension returns it. */
const sessionContextReply = (tabId: number, overrides: Record<string, unknown> = {}) => ({
  status: 'success',
  data: {
    content: [
      {
        type: 'text',
        text:
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
      },
    ],
    isError: false,
  },
});

describe('register-tools profile routing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('keeps chrome_switch_profile scoped to each MCP router instance', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium', 'bluBanyan']);
    const sendRequest = jest.spyOn(profileRegistry, 'sendRequest').mockResolvedValue({
      status: 'success',
      data: { content: [{ type: 'text', text: 'ok' }] },
    });
    const firstRouter = createToolRouter();
    const secondRouter = createToolRouter();

    await firstRouter.handleToolCall('chrome_switch_profile', { profile: 'centium' });
    await secondRouter.handleToolCall('chrome_switch_profile', { profile: 'bluBanyan' });

    await firstRouter.handleToolCall('get_windows_and_tabs', {});
    await secondRouter.handleToolCall('get_windows_and_tabs', {});

    expect(sendRequest.mock.calls.map((call) => call[0])).toEqual(['centium', 'bluBanyan']);
  });

  test('routes a single tool call to args.profile without mutating session profile or forwarded args', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium', 'bluBanyan']);
    const sendRequest = jest.spyOn(profileRegistry, 'sendRequest').mockResolvedValue({
      status: 'success',
      data: { content: [{ type: 'text', text: 'ok' }] },
    });
    const router = createToolRouter();

    await router.handleToolCall('chrome_switch_profile', { profile: 'bluBanyan' });
    await router.handleToolCall('get_windows_and_tabs', { profile: 'centium' });
    await router.handleToolCall('get_windows_and_tabs', {});

    expect(sendRequest.mock.calls.map((call) => call[0])).toEqual(['centium', 'bluBanyan']);
    expect(sendRequest.mock.calls[0]).toEqual([
      'centium',
      { name: 'get_windows_and_tabs', args: {} },
      NativeMessageType.CALL_TOOL,
      120000,
    ]);
  });

  test('pins a session tab id for subsequent Workato tool calls only', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium']);
    const sendRequest = jest.spyOn(profileRegistry, 'sendRequest').mockResolvedValue({
      status: 'success',
      data: { content: [{ type: 'text', text: 'ok' }] },
    });
    const router = createToolRouter();

    await router.handleToolCall('chrome_switch_profile', { profile: 'centium', tabId: 42 });
    sendRequest.mockClear();
    await router.handleToolCall('workato_whoami', {});
    await router.handleToolCall('get_windows_and_tabs', {});

    expect(sendRequest.mock.calls[0]).toEqual([
      'centium',
      { name: 'workato_whoami', args: { tabId: 42 } },
      NativeMessageType.CALL_TOOL,
      120000,
    ]);
    expect(sendRequest.mock.calls[1]).toEqual([
      'centium',
      { name: 'get_windows_and_tabs', args: {} },
      NativeMessageType.CALL_TOOL,
      120000,
    ]);
  });

  test('pins the tab workspace by probing workato_session_context on switch', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium']);
    jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('centium');
    const sendRequest = jest
      .spyOn(profileRegistry, 'sendRequest')
      .mockImplementation(async (_profile: any, payload: any) => {
        if (payload?.name === 'workato_session_context') {
          return sessionContextReply(payload.args.tabId) as any;
        }
        return { status: 'success', data: { content: [{ type: 'text', text: 'ok' }] } } as any;
      });
    const router = createToolRouter();

    const switched = await router.handleToolCall('chrome_switch_profile', {
      profile: 'centium',
      tabId: 42,
    });

    expect((sendRequest.mock.calls[0][1] as any).name).toBe('workato_session_context');
    expect((switched.content?.[0] as any).text).toContain('workspace 5150');

    const listed = await router.handleToolCall('chrome_list_profiles', {});
    const payload = JSON.parse((listed.content?.[0] as any).text);
    expect(payload.session_context).toMatchObject({
      profile: 'centium',
      tab_id: 42,
      host: 'app.workato.com',
      workspace_id: 5150,
      environment: 'production',
    });

    // Every later Workato call carries the pinned tab AND the pinned workspace.
    sendRequest.mockClear();
    await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    expect((sendRequest.mock.calls[0][1] as any).args).toEqual({
      recipe_id: 1,
      tabId: 42,
      expected_context: {
        host: 'app.workato.com',
        workspace_id: 5150,
        environment: 'production',
      },
    });
  });

  test('never falls back to another transport when a profile is pinned', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium', 'bluBanyan']);
    jest.spyOn(profileRegistry, 'sendRequest').mockImplementation(async (_p: any, payload: any) => {
      if (payload?.name === 'workato_session_context') throw new Error('socket closed');
      throw new Error('socket closed');
    });
    const nativeHost = jest
      .spyOn(nativeMessagingHostInstance, 'sendRequestToExtensionAndWait')
      .mockResolvedValue({ status: 'success', data: { content: [] } } as any);
    const router = createToolRouter();

    await router.handleToolCall('chrome_switch_profile', { profile: 'centium' });
    const result = await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });

    expect(result.isError).toBe(true);
    const error = JSON.parse((result.content?.[0] as any).text).error;
    expect(error.code).toBe('ProfileCallFailed');
    expect(error.message).toContain('pinned profile "centium"');
    expect(error.message).toContain('bluBanyan');
    expect(nativeHost).not.toHaveBeenCalled();
  });

  test('does not use the native host while any profile is connected', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium']);
    jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('centium');
    jest.spyOn(profileRegistry, 'sendRequest').mockRejectedValue(new Error('ws down') as never);
    const nativeHost = jest
      .spyOn(nativeMessagingHostInstance, 'sendRequestToExtensionAndWait')
      .mockResolvedValue({ status: 'success', data: { content: [] } } as any);
    const router = createToolRouter();

    const result = await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });

    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content?.[0] as any).text).error.message).toContain(
      'bridge default profile "centium"',
    );
    expect(nativeHost).not.toHaveBeenCalled();
  });

  test('folds the extension context block, stamped with the routed profile, into the result', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium']);
    jest.spyOn(profileRegistry, 'sendRequest').mockResolvedValue({
      status: 'success',
      data: {
        content: [
          { type: 'text', text: '{"recipe_id":1}' },
          {
            type: 'text',
            text: '{"context":{"tab_id":42,"host":"app.workato.com","workspace_id":5150}}',
          },
        ],
        isError: false,
      },
    } as never);
    const router = createToolRouter();

    await router.handleToolCall('chrome_switch_profile', { profile: 'centium' });
    const result = await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });

    // One block, one object: the payload's own keys, then the context.
    const blocks = result.content as any[];
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0].text)).toEqual({
      recipe_id: 1,
      context: {
        tab_id: 42,
        host: 'app.workato.com',
        workspace_id: 5150,
        profile: 'centium',
      },
    });
  });

  test('lets explicit tab or window targets override a pinned session tab id', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium']);
    const sendRequest = jest.spyOn(profileRegistry, 'sendRequest').mockResolvedValue({
      status: 'success',
      data: { content: [{ type: 'text', text: 'ok' }] },
    });
    const router = createToolRouter();

    await router.handleToolCall('chrome_switch_profile', { profile: 'centium', tabId: 42 });
    sendRequest.mockClear();
    await router.handleToolCall('workato_whoami', { tabId: 7 });
    await router.handleToolCall('workato_ui_list_steps', { windowId: 3 });

    expect(sendRequest.mock.calls[0]).toEqual([
      'centium',
      { name: 'workato_whoami', args: { tabId: 7 } },
      NativeMessageType.CALL_TOOL,
      120000,
    ]);
    expect(sendRequest.mock.calls[1]).toEqual([
      'centium',
      { name: 'workato_ui_list_steps', args: { windowId: 3 } },
      NativeMessageType.CALL_TOOL,
      120000,
    ]);
  });

  test('reports the session tab id in the profile listing', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium']);
    jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('default');
    const router = createToolRouter();

    await router.handleToolCall('chrome_switch_profile', { profile: 'centium', tabId: 42 });
    const result = await router.handleToolCall('chrome_list_profiles', {});
    const first = result.content[0];
    expect(first.type).toBe('text');
    if (first.type !== 'text') throw new Error('expected text result');
    const payload = JSON.parse(first.text);

    expect(payload).toMatchObject({
      active_profile: 'centium',
      session_profile: 'centium',
      session_tab_id: 42,
    });
  });

  test('adds optional profile routing argument to proxied tool schemas only', () => {
    const schemas = withProfileRoutingToolSchemas([
      {
        name: 'get_windows_and_tabs',
        description: 'Get tabs',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'chrome_switch_profile',
        description: 'Switch profile',
        inputSchema: {
          type: 'object',
          properties: { profile: { type: 'string' } },
          required: ['profile'],
        },
      },
    ]);

    expect((schemas[0].inputSchema as any).properties[PROFILE_ROUTING_ARG]).toMatchObject({
      type: 'string',
    });
    expect((schemas[0].inputSchema as any).required).toEqual([]);
    expect((schemas[1].inputSchema as any).required).toEqual(['profile']);
  });
});

describe('register-tools native orchestrator routing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Answer every extension call with a plausible success payload. */
  function stubExtension() {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['centium']);
    return jest
      .spyOn(profileRegistry, 'sendRequest')
      .mockImplementation(async (_profile: any, payload: any) => {
        const name = payload?.name;
        const args = payload?.args ?? {};
        const text = (body: unknown) => ({
          status: 'success',
          data: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false },
        });
        if (name === 'workato_pull_recipe') {
          return text({
            recipe_id: args.recipe_id,
            code: {
              number: 0,
              keyword: 'trigger',
              provider: 'workato_recipe_function',
              name: 'execute',
              as: 'a1b2c3d4',
              input: {},
              block: [
                {
                  number: 1,
                  keyword: 'action',
                  provider: 'workato_recipe_function',
                  name: 'return_result',
                  as: 'tjreturn',
                  input: {},
                },
              ],
            },
            version: { version_no: 4, config: '[]' },
          }) as any;
        }
        if (name === 'workato_ui_save_recipe_code') {
          return text({ recipe_id: args.recipe_id, version_no: 5, code_errors: [] }) as any;
        }
        if (name === 'workato_recipe_status') {
          return text({ recipe_id: args.recipe_id, running: false, name: 'r' }) as any;
        }
        if (name === 'workato_session_context') {
          return sessionContextReply(args.tabId) as any;
        }
        return text({ ok: true }) as any;
      });
  }

  test('workato_datapill is answered locally, with no extension round trip', async () => {
    const sendRequest = stubExtension();
    const router = createToolRouter();

    await router.handleToolCall('chrome_switch_profile', { profile: 'centium' });
    sendRequest.mockClear();

    const result = await router.handleToolCall('workato_datapill', {
      widget_id: 'df1984ea',
    });

    expect(result.isError).toBe(false);
    expect((result.content?.[0] as any).text).toContain('"source":"widget"');
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test('workato_callable_schema_set drives pull then save through the extension', async () => {
    const sendRequest = stubExtension();
    const router = createToolRouter();
    await router.handleToolCall('chrome_switch_profile', { profile: 'centium' });
    sendRequest.mockClear();

    const result = await router.handleToolCall('workato_callable_schema_set', {
      recipe_id: 76902508,
      results: [{ name: 'je_count', type: 'integer' }],
    });

    expect(result.isError).toBe(false);
    const called = sendRequest.mock.calls.map((call: any) => call[1].name);
    expect(called).toEqual(['workato_pull_recipe', 'workato_ui_save_recipe_code']);
    const saveArgs = sendRequest.mock.calls[1][1] as any;
    expect(saveArgs.args.code.input.result_schema_json).toContain('je_count');
    expect(saveArgs.args.comment).toBe('schema refresh');
  });

  test('injects the pinned tab and workspace into every nested orchestrator call', async () => {
    const sendRequest = stubExtension();
    const router = createToolRouter();
    await router.handleToolCall('chrome_switch_profile', { profile: 'centium', tabId: 42 });
    sendRequest.mockClear();

    await router.handleToolCall('workato_callable_schema_set', {
      recipe_id: 76902508,
      results: [{ name: 'je_count', type: 'integer' }],
    });

    const nested = sendRequest.mock.calls.map((call: any) => call[1]);
    expect(nested.map((call: any) => call.name)).toEqual([
      'workato_pull_recipe',
      'workato_ui_save_recipe_code',
    ]);
    for (const call of nested) {
      expect(call.args.tabId).toBe(42);
      expect(call.args.expected_context).toEqual({
        host: 'app.workato.com',
        workspace_id: 5150,
        environment: 'production',
      });
    }
  });

  test('workato_recipe_save_with_dependents refuses rather than guessing dependents', async () => {
    const sendRequest = stubExtension();
    const router = createToolRouter();

    await router.handleToolCall('chrome_switch_profile', { profile: 'centium' });
    sendRequest.mockClear();

    const result = await router.handleToolCall('workato_recipe_save_with_dependents', {
      recipe_id: 76902508,
      code: { keyword: 'trigger' },
    });

    expect(result.isError).toBe(true);
    expect((result.content?.[0] as any).text).toMatch(/no way to determine which recipes call/);
    // Critically: it did NOT save.
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test('workato_recipe_save_with_dependents restores a stopped dependent after saving', async () => {
    const sendRequest = stubExtension();
    const router = createToolRouter();
    await router.handleToolCall('chrome_switch_profile', { profile: 'centium' });
    sendRequest.mockClear();

    const result = await router.handleToolCall('workato_recipe_save_with_dependents', {
      recipe_id: 76902508,
      code: { keyword: 'trigger' },
      dependent_recipe_ids: [76887741],
    });

    expect(result.isError).toBe(false);
    const called = sendRequest.mock.calls.map((call: any) => call[1].name);
    expect(called).toContain('workato_recipe_status');
    expect(called).toContain('workato_ui_save_recipe_code');
  });
});
