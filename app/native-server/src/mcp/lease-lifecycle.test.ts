/**
 * What happens to a lease outside the calls that pass it: the session ending,
 * the bridge restarting, a script working the tab by tabId, the idle limit.
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeMessageType } from '@mokuhub/mokutab-shared';
import { createToolRouter } from './register-tools';
import { createMcpServer } from './mcp-server';
import { profileRegistry } from '../server/profile-registry';
import { installLeaseRecovery, mayCloseOrphan } from '../server/lease-recovery';
import {
  LEASE_IDLE_ENV,
  LEASE_IDLE_MS,
  LeaseRegistry,
  LeaseTable,
  leaseIdleMs,
  type SavedLease,
  type TabLease,
} from './tab-leases';

const parse = (result: any): any => JSON.parse((result.content[0] as any).text);

function mockExtension(browserSession: string | null = 'chrome-1') {
  let nextTab = 100;
  jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['personal']);
  jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('personal');
  jest.spyOn(profileRegistry, 'getBrowserSession').mockReturnValue(browserSession);
  return jest
    .spyOn(profileRegistry, 'sendRequest')
    .mockImplementation(async (_profile: string, payload: any, type?: string) => {
      if (type === NativeMessageType.AGENT_TAB_OPEN) {
        nextTab += 1;
        return { status: 'success', data: { tabId: nextTab, windowId: 5 } };
      }
      if (type === NativeMessageType.AGENT_TAB_CLOSE) return { status: 'success', data: {} };
      if (payload?.name === 'get_windows_and_tabs') {
        const windows = [{ windowId: 9, tabs: [{ tabId: 55 }] }];
        return {
          status: 'success',
          data: { content: [{ type: 'text', text: JSON.stringify({ windows }) }] },
        };
      }
      return { status: 'success', data: { content: [{ type: 'text', text: 'ok' }] } };
    });
}

const closedTabs = (sendRequest: any): number[] =>
  sendRequest.mock.calls
    .filter((c: any[]) => c[2] === NativeMessageType.AGENT_TAB_CLOSE)
    .map((c: any[]) => c[1].tabId);

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mokutab-leases-')), 'leases.json');
}

function lease(overrides: Partial<TabLease> = {}): TabLease {
  return {
    lease: 'L1',
    profile: 'personal',
    tabId: 101,
    windowId: 5,
    created_at: 1_000,
    last_used: 1_000,
    browser_session: 'chrome-1',
    ...overrides,
  };
}

/** A ProfileRegistry stand-in: register() fires the connect listeners. */
function fakeProfiles(browserSession: string | null) {
  const listeners: Array<(profile: string) => void> = [];
  const sendRequest = jest.fn(async (..._args: any[]): Promise<any> => ({ status: 'success' }));
  return {
    sendRequest,
    registry: {
      onRegister: (listener: (profile: string) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      getBrowserSession: () => browserSession,
      sendRequest,
    } as any,
    connect: (profile: string) => listeners.forEach((listener) => listener(profile)),
  };
}

describe('lease lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('the session ending', () => {
    test('closes the tabs its leases opened and keeps adopted ones', async () => {
      const sendRequest = mockExtension();
      const registry = new LeaseRegistry();
      const router = createToolRouter({ leaseRegistry: registry });
      const opened = parse(await router.handleToolCall('chrome_lease_tab', {}));
      const adopted = parse(await router.handleToolCall('chrome_lease_tab', { adopt_tab_id: 55 }));
      expect(adopted.adopted).toBe(true);

      await router.close();

      expect(closedTabs(sendRequest)).toEqual([opened.tabId]);
      // The leases are gone with the session: nothing is left to touch.
      expect(registry.touchTab('personal', opened.tabId, Date.now())).toBe(false);
      expect(registry.touchTab('personal', 55, Date.now())).toBe(false);
    });

    test('is wired to the MCP server closing', async () => {
      const sendRequest = mockExtension();
      const server = createMcpServer();
      const handler = (server as any)._requestHandlers.get('tools/call');
      const reply = await handler(
        {
          method: 'tools/call',
          params: { name: 'chrome_lease_tab', arguments: {} },
        },
        { signal: new AbortController().signal },
      );
      const { tabId } = parse(reply);

      server.onclose?.();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(closedTabs(sendRequest)).toEqual([tabId]);
    });
  });

  describe('a call by tabId', () => {
    test("refreshes the lease that holds that tab, even another session's", async () => {
      mockExtension();
      const registry = new LeaseRegistry();
      const leasing = createToolRouter({ leaseRegistry: registry });
      const working = createToolRouter({ leaseRegistry: registry });
      const start = 10_000_000;
      const now = jest.spyOn(Date, 'now').mockReturnValue(start);
      const { lease, tabId } = parse(await leasing.handleToolCall('chrome_lease_tab', {}));

      // 20 minutes on, a call names the tab without the lease.
      now.mockReturnValue(start + 20 * 60_000);
      await working.handleToolCall('chrome_get_web_content', { tabId });

      // 40 minutes after the lease, 20 after that call: not idle long enough.
      // (A call that passes the lease runs the idle sweep first.)
      now.mockReturnValue(start + 40 * 60_000);
      const still = await leasing.handleToolCall('chrome_get_web_content', { lease });
      expect(still.isError).toBeFalsy();
    });

    test('of another tab leaves the lease to expire', async () => {
      mockExtension();
      const registry = new LeaseRegistry();
      const router = createToolRouter({ leaseRegistry: registry });
      const start = 10_000_000;
      const now = jest.spyOn(Date, 'now').mockReturnValue(start);
      const { lease } = parse(await router.handleToolCall('chrome_lease_tab', {}));

      now.mockReturnValue(start + 20 * 60_000);
      await router.handleToolCall('chrome_get_web_content', { tabId: 999 });

      now.mockReturnValue(start + 40 * 60_000);
      const expired = await router.handleToolCall('chrome_get_web_content', { lease });
      expect(expired.isError).toBe(true);
      expect((expired.content[0] as any).text).toContain('expired lease');
    });
  });

  describe('a bridge restart', () => {
    test('keeps the leases as orphans, and their tab closes when the profile reconnects', () => {
      const file = tempFile();
      const before = new LeaseRegistry();
      before.enablePersistence(file, 1_000);
      new LeaseTable(before).add(lease());

      const after = new LeaseRegistry();
      after.enablePersistence(file, 2_000);
      expect(after.orphanCount).toBe(1);

      const profiles = fakeProfiles('chrome-1');
      installLeaseRecovery({ registry: profiles.registry, leases: after, log: () => undefined });
      profiles.connect('personal');

      expect(profiles.sendRequest).toHaveBeenCalledWith(
        'personal',
        { tabId: 101 },
        NativeMessageType.AGENT_TAB_CLOSE,
        expect.any(Number),
      );
      expect(after.orphanCount).toBe(0);
      // Dropped from the file too: a second restart closes nothing.
      const again = new LeaseRegistry();
      again.enablePersistence(file, 3_000);
      expect(again.orphanCount).toBe(0);
    });

    test('never closes a tab from another Chrome session, or an adopted one', () => {
      const file = tempFile();
      const before = new LeaseRegistry();
      before.enablePersistence(file, 1_000);
      const table = new LeaseTable(before);
      table.add(lease({ lease: 'L1', tabId: 101, browser_session: 'chrome-0' }));
      table.add(lease({ lease: 'L2', tabId: 102, adopted: true }));
      table.add(lease({ lease: 'L3', tabId: 103, browser_session: null }));

      const after = new LeaseRegistry();
      after.enablePersistence(file, 2_000);
      const profiles = fakeProfiles('chrome-1');
      installLeaseRecovery({ registry: profiles.registry, leases: after, log: () => undefined });
      profiles.connect('personal');

      expect(profiles.sendRequest).not.toHaveBeenCalled();
      expect(after.orphanCount).toBe(0);
    });

    test('keeps the orphans of a profile that has not reconnected', () => {
      const file = tempFile();
      const before = new LeaseRegistry();
      before.enablePersistence(file, 1_000);
      const table = new LeaseTable(before);
      table.add(lease({ lease: 'L1', profile: 'personal' }));
      table.add(lease({ lease: 'L2', profile: 'centium', tabId: 202 }));

      const after = new LeaseRegistry();
      after.enablePersistence(file, 2_000);
      const profiles = fakeProfiles('chrome-1');
      installLeaseRecovery({ registry: profiles.registry, leases: after, log: () => undefined });
      profiles.connect('personal');

      const third = new LeaseRegistry();
      third.enablePersistence(file, 3_000);
      expect(third.orphanCount).toBe(1);
      expect(third.takeOrphans('centium').map((o) => o.lease)).toEqual(['L2']);
    });

    test('forgets orphans older than a week, and ignores a damaged file', () => {
      const file = tempFile();
      const before = new LeaseRegistry();
      before.enablePersistence(file, 1_000);
      new LeaseTable(before).add(lease());

      const weekLater = new LeaseRegistry();
      weekLater.enablePersistence(file, 1_000 + 8 * 24 * 60 * 60 * 1000);
      expect(weekLater.orphanCount).toBe(0);

      fs.writeFileSync(file, '{not json');
      const damaged = new LeaseRegistry();
      damaged.enablePersistence(file, 2_000);
      expect(damaged.orphanCount).toBe(0);
    });

    test('mayCloseOrphan wants the same Chrome session and a tab the lease opened', () => {
      const saved: SavedLease = {
        lease: 'L1',
        profile: 'personal',
        tabId: 1,
        windowId: null,
        created_at: 0,
        adopted: false,
        browser_session: 'chrome-1',
      };
      expect(mayCloseOrphan(saved, 'chrome-1')).toBe(true);
      expect(mayCloseOrphan(saved, 'chrome-2')).toBe(false);
      expect(mayCloseOrphan(saved, null)).toBe(false);
      expect(mayCloseOrphan({ ...saved, adopted: true }, 'chrome-1')).toBe(false);
      expect(mayCloseOrphan({ ...saved, browser_session: null }, null)).toBe(false);
    });
  });

  test('the idle limit reads MOKUTAB_LEASE_IDLE_MINUTES', () => {
    expect(leaseIdleMs({})).toBe(LEASE_IDLE_MS);
    expect(leaseIdleMs({ [LEASE_IDLE_ENV]: '10' })).toBe(10 * 60_000);
    expect(leaseIdleMs({ [LEASE_IDLE_ENV]: ' 5 ' })).toBe(5 * 60_000);
    for (const bad of ['0', '-3', '2.5', 'soon']) {
      expect(leaseIdleMs({ [LEASE_IDLE_ENV]: bad })).toBe(LEASE_IDLE_MS);
    }
    const table = new LeaseTable(new LeaseRegistry());
    table.add(lease({ last_used: 0 }));
    expect(table.takeExpired(9 * 60_000, 10 * 60_000)).toEqual([]);
    expect(table.takeExpired(10 * 60_000, 10 * 60_000).map((l) => l.lease)).toEqual(['L1']);
  });
});
