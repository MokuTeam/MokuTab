/**
 * Tab leases, strict targeting, the cross-profile pin rule and cancellation,
 * exercised through the real router with the extension transport mocked.
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { NativeMessageType, TOOL_SCHEMAS } from '@mokuhub/mokutab-shared';
import { createToolRouter, raceAbort } from './register-tools';
import { profileRegistry } from '../server/profile-registry';
import { bridgeLeases, withLeaseToolSchemas } from './tab-leases';

const parse = (result: any): any => JSON.parse((result.content[0] as any).text);

function mockExtension(tabIdFor: Record<string, number> = { centium: 77, personal: 88 }) {
  jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['personal', 'centium']);
  jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('personal');
  return jest
    .spyOn(profileRegistry, 'sendRequest')
    .mockImplementation(async (profile: string, payload: any, type?: string) => {
      if (type === NativeMessageType.AGENT_TAB_OPEN) {
        return { status: 'success', data: { tabId: tabIdFor[profile], windowId: 5 } };
      }
      if (type === NativeMessageType.AGENT_TAB_CLOSE) return { status: 'success', data: {} };
      if (payload?.name === 'workato_session_context') {
        return {
          status: 'success',
          data: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ tab_id: 5, host: 'app.workato.com', workspace_id: 1 }),
              },
            ],
          },
        };
      }
      return { status: 'success', data: { content: [{ type: 'text', text: 'ok' }] } };
    });
}

function toolCalls(sendRequest: any) {
  return sendRequest.mock.calls.filter((c: any[]) => c[2] === NativeMessageType.CALL_TOOL);
}

describe('tab leases', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    // The table is the bridge's, shared by every router: start each test empty.
    bridgeLeases.clear();
  });

  test('a lease routes to its profile and tab without activating it', async () => {
    const sendRequest = mockExtension();
    const router = createToolRouter();

    const lease = parse(await router.handleToolCall('chrome_lease_tab', { profile: 'centium' }));
    expect(lease).toMatchObject({ tabId: 77, profile: 'centium' });

    const result = await router.handleToolCall('chrome_get_web_content', { lease: lease.lease });
    expect(result.isError).toBeFalsy();
    const [call] = toolCalls(sendRequest);
    expect(call[0]).toBe('centium');
    // The call carries the profile's leased tabs for the extension to stay off.
    expect(call[1]).toEqual({
      name: 'chrome_get_web_content',
      args: { tabId: 77, background: true },
      leasedTabs: [77],
    });
  });

  test('while a lease is held, a call that names no tab is refused', async () => {
    const sendRequest = mockExtension();
    const router = createToolRouter();
    const lease = parse(await router.handleToolCall('chrome_lease_tab', {}));

    const refused = await router.handleToolCall('chrome_read_page', {});
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as any).text).toContain('StrictTabs');
    expect(toolCalls(sendRequest)).toHaveLength(0);

    // Tools that target no tab, and explicit tabIds, still go through.
    await router.handleToolCall('chrome_read_page', { tabId: 12 });
    expect(toolCalls(sendRequest)).toHaveLength(1);

    const released = parse(
      await router.handleToolCall('chrome_release_tab', { lease: lease.lease }),
    );
    expect(released.tab_closed).toBe(true);
    const closes = sendRequest.mock.calls.filter(
      (c: any[]) => c[2] === NativeMessageType.AGENT_TAB_CLOSE,
    );
    expect(closes).toHaveLength(1);

    // No lease left: the old default behaviour is back.
    const free = await router.handleToolCall('chrome_read_page', {});
    expect(free.isError).toBeFalsy();
  });

  test('a lease and a conflicting profile or tabId are refused', async () => {
    mockExtension();
    const router = createToolRouter();
    const lease = parse(await router.handleToolCall('chrome_lease_tab', { profile: 'centium' }));

    const wrongProfile = await router.handleToolCall('chrome_read_page', {
      lease: lease.lease,
      profile: 'personal',
    });
    expect(wrongProfile.isError).toBe(true);
    const wrongTab = await router.handleToolCall('chrome_read_page', {
      lease: lease.lease,
      tabId: 1,
    });
    expect(wrongTab.isError).toBe(true);
    const unknown = await router.handleToolCall('chrome_read_page', { lease: 'Lnope' });
    expect(parse(unknown).error.code).toBe('UnknownLease');
  });

  test('the session pin is not injected into a call routed to another profile', async () => {
    const sendRequest = mockExtension();
    const router = createToolRouter();
    await router.handleToolCall('chrome_switch_profile', { profile: 'personal', tabId: 5 });

    await router.handleToolCall('workato_recipe_status', { recipe_id: 1, profile: 'centium' });
    await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });

    const statusCalls = toolCalls(sendRequest).filter(
      (c: any[]) => c[1].name === 'workato_recipe_status',
    );
    expect(statusCalls[0][0]).toBe('centium');
    expect(statusCalls[0][1].args.tabId).toBeUndefined();
    expect(statusCalls[1][0]).toBe('personal');
    expect(statusCalls[1][1].args.tabId).toBe(5);
  });

  test('lease is advertised on tools that take a tabId only', () => {
    const tools = withLeaseToolSchemas(TOOL_SCHEMAS);
    const props = (name: string) =>
      (tools.find((t) => t.name === name)!.inputSchema as any).properties;
    expect(props('chrome_read_page').lease).toBeDefined();
    expect(props('get_windows_and_tabs').lease).toBeUndefined();
    expect(props('chrome_lease_tab').lease).toBeUndefined();
  });

  test('adopt_tab_id leases an existing tab once, and only a tab the profile has', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['personal', 'centium']);
    jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('personal');
    const sendRequest = jest
      .spyOn(profileRegistry, 'sendRequest')
      .mockImplementation(async (_profile: string, payload: any) => {
        if (payload?.name === 'get_windows_and_tabs') {
          const windows = [{ windowId: 9, tabs: [{ tabId: 55, url: 'https://x' }] }];
          return {
            status: 'success',
            data: { content: [{ type: 'text', text: JSON.stringify({ windows }) }] },
          };
        }
        return { status: 'success', data: { content: [{ type: 'text', text: 'ok' }] } };
      });
    const router = createToolRouter();

    const adopted = parse(
      await router.handleToolCall('chrome_lease_tab', { profile: 'centium', adopt_tab_id: 55 }),
    );
    expect(adopted).toMatchObject({ tabId: 55, windowId: 9, profile: 'centium', adopted: true });
    expect(
      sendRequest.mock.calls.some((c: any[]) => c[2] === NativeMessageType.AGENT_TAB_OPEN),
    ).toBe(false);

    const again = await router.handleToolCall('chrome_lease_tab', {
      profile: 'centium',
      adopt_tab_id: 55,
    });
    expect(again.isError).toBe(true);
    expect((again.content[0] as any).text).toContain(`already leased as ${adopted.lease}`);

    const missing = await router.handleToolCall('chrome_lease_tab', {
      profile: 'centium',
      adopt_tab_id: 56,
    });
    expect(missing.isError).toBe(true);
    expect(JSON.parse((missing.content[0] as any).text).error.message).toContain(
      'tab 56 is not open in profile "centium"',
    );
  });

  test('a tab leased in one session is off limits to another session', async () => {
    const sendRequest = mockExtension();
    const holder = createToolRouter();
    const other = createToolRouter();
    const lease = parse(await holder.handleToolCall('chrome_lease_tab', { profile: 'centium' }));

    // The other session sees the tab to stay away from, never the token.
    const listed = parse(await other.handleToolCall('chrome_list_profiles', {}));
    expect(listed.leases).toHaveLength(1);
    expect(listed.leases[0]).toMatchObject({ other_session: true, profile: 'centium', tabId: 77 });
    expect(listed.leases[0].lease).toBeUndefined();
    expect(parse(await holder.handleToolCall('chrome_list_profiles', {})).leases[0].lease).toBe(
      lease.lease,
    );

    // Naming the tab without its lease is refused, and nothing is sent.
    const sentBefore = toolCalls(sendRequest).length;
    const refused = await other.handleToolCall('chrome_get_web_content', {
      profile: 'centium',
      tabId: 77,
    });
    expect(refused.isError).toBe(true);
    expect(parse(refused).error.code).toBe('TabLeased');
    const pinned = await other.handleToolCall('chrome_switch_profile', {
      profile: 'centium',
      tabId: 77,
    });
    expect(parse(pinned).error.code).toBe('TabLeased');
    const adopted = await other.handleToolCall('chrome_lease_tab', {
      profile: 'centium',
      adopt_tab_id: 77,
    });
    expect(parse(adopted).error.code).toBe('TabLeased');
    const closed = await other.handleToolCall('chrome_close_tabs', {
      profile: 'centium',
      tabIds: [77],
    });
    expect(closed.isError).toBe(true);
    expect(toolCalls(sendRequest).length).toBe(sentBefore);

    // The other session holds no lease, so it is not in strict mode: a call
    // that names no tab goes out, with the leased tabs for the extension to skip.
    const free = await other.handleToolCall('chrome_get_web_content', { profile: 'centium' });
    expect(free.isError).toBeFalsy();
    const sent = toolCalls(sendRequest).at(-1);
    expect(sent[1].leasedTabs).toEqual([77]);
    expect(sent[1].args.tabId).toBeUndefined();
    // A profile with no leased tab gets no list at all.
    await other.handleToolCall('chrome_get_web_content', { profile: 'personal' });
    expect(toolCalls(sendRequest).at(-1)[1].leasedTabs).toBeUndefined();

    // The token is the capability: whoever passes it uses the tab.
    const viaToken = await other.handleToolCall('chrome_get_web_content', { lease: lease.lease });
    expect(viaToken.isError).toBeFalsy();
    expect(toolCalls(sendRequest).at(-1)[1].args.tabId).toBe(77);
  });

  test('a watch cannot name a tab another session leased', async () => {
    mockExtension();
    const holder = createToolRouter();
    const other = createToolRouter();
    await holder.handleToolCall('chrome_lease_tab', { profile: 'centium' });

    const refused = await other.handleToolCall('chrome_watch_start', {
      profile: 'centium',
      tabIds: [77],
      script: 'return 1',
    });
    expect(refused.isError).toBe(true);
    expect(parse(refused).error.code).toBe('TabLeased');
  });

  test('the calls the bridge makes on its own carry the leased tabs too', async () => {
    const sendRequest = mockExtension();
    const router = createToolRouter();
    await router.handleToolCall('chrome_lease_tab', { profile: 'centium' });
    // adopt_tab_id lists the profile's tabs first: that call must not read as "no leases".
    await router.handleToolCall('chrome_lease_tab', { profile: 'centium', adopt_tab_id: 55 });
    const listing = toolCalls(sendRequest).find(
      (c: any[]) => c[1]?.name === 'get_windows_and_tabs',
    );
    expect(listing[1].leasedTabs).toEqual([77]);
  });

  test('a session pin does not satisfy strict mode while leases are held', async () => {
    const sendRequest = mockExtension();
    const router = createToolRouter();
    await router.handleToolCall('chrome_switch_profile', { profile: 'personal', tabId: 5 });
    parse(await router.handleToolCall('chrome_lease_tab', { profile: 'personal' }));

    const refused = await router.handleToolCall('workato_recipe_status', { recipe_id: 1 });
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as any).text).toContain('StrictTabs');
    expect(
      toolCalls(sendRequest).filter((c: any[]) => c[1].name === 'workato_recipe_status'),
    ).toHaveLength(0);
  });

  test('releasing an adopted tab keeps it open unless keep_tab:false', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['personal', 'centium']);
    jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('personal');
    const sendRequest = jest
      .spyOn(profileRegistry, 'sendRequest')
      .mockImplementation(async (_profile: string, payload: any, type?: string) => {
        if (payload?.name === 'get_windows_and_tabs') {
          const windows = [{ windowId: 9, tabs: [{ tabId: 55 }, { tabId: 56 }] }];
          return {
            status: 'success',
            data: { content: [{ type: 'text', text: JSON.stringify({ windows }) }] },
          };
        }
        if (type === NativeMessageType.AGENT_TAB_CLOSE) return { status: 'success', data: {} };
        return { status: 'success', data: { content: [{ type: 'text', text: 'ok' }] } };
      });
    const router = createToolRouter();
    const closes = () =>
      sendRequest.mock.calls.filter((c: any[]) => c[2] === NativeMessageType.AGENT_TAB_CLOSE);

    const a = parse(await router.handleToolCall('chrome_lease_tab', { adopt_tab_id: 55 }));
    expect(a.note).toContain('leaves it open');
    const releasedA = parse(await router.handleToolCall('chrome_release_tab', { lease: a.lease }));
    expect(releasedA.tab_closed).toBe(false);
    expect(closes()).toHaveLength(0);

    const b = parse(await router.handleToolCall('chrome_lease_tab', { adopt_tab_id: 56 }));
    const releasedB = parse(
      await router.handleToolCall('chrome_release_tab', { lease: b.lease, keep_tab: false }),
    );
    expect(releasedB.tab_closed).toBe(true);
    expect(closes()).toHaveLength(1);
  });

  test('chrome_close_tabs never closes a tab leased in this session', async () => {
    const sendRequest = mockExtension();
    const router = createToolRouter();
    const lease = parse(await router.handleToolCall('chrome_lease_tab', { profile: 'personal' }));

    const byId = await router.handleToolCall('chrome_close_tabs', { tabIds: [lease.tabId] });
    expect(byId.isError).toBe(true);
    expect((byId.content[0] as any).text).toContain('chrome_release_tab');

    const byUrl = await router.handleToolCall('chrome_close_tabs', { url: 'https://example.com' });
    expect(byUrl.isError).toBe(true);
    expect(
      toolCalls(sendRequest).filter((c: any[]) => c[1].name === 'chrome_close_tabs'),
    ).toHaveLength(0);
  });

  test('a cancelled chrome_lease_tab keeps no lease and closes its tab', async () => {
    const sendRequest = mockExtension();
    const router = createToolRouter();
    const controller = new AbortController();
    controller.abort();

    await router.handleToolCall('chrome_lease_tab', { profile: 'personal' }, controller.signal);
    // The handler keeps running after the cancelled reply; let it finish.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // No lease, so no strict mode: a tabless call goes through.
    const listed = parse(await router.handleToolCall('chrome_list_profiles', {}));
    expect(listed.leases).toEqual([]);
    expect(
      sendRequest.mock.calls.some((c: any[]) => c[2] === NativeMessageType.AGENT_TAB_CLOSE),
    ).toBe(true);
  });

  test('a cancelled call stops waiting', async () => {
    const controller = new AbortController();
    const never = new Promise<any>(() => {});
    const pending = raceAbort(never, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('cancelled by the MCP client');
  });
});
