import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  CORE_TOOL_SCHEMAS,
  NETSUITE_TOOL_SCHEMAS,
  TOOL_SCHEMAS,
  WORKATO_TOOL_ALIASES,
} from '@mokuhub/mokutab-shared';
import {
  createMcpServer,
  liveMcpServerCount,
  notifyToolListChanged,
  wireToolListChanged,
} from './mcp-server';
import { ModuleSwitch } from './module-switch';

let dir: string;
let switches: ModuleSwitch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-changed-'));
  // A machine upgraded from 1.x: Workato on.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ modules: { workato: true } }));
  switches = new ModuleSwitch(
    () => path.join(dir, 'config.json'),
    () => {},
  );
  wireToolListChanged(switches);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One MCP session over an in-memory pair, counting list_changed notifications. */
async function openSession() {
  const server = createMcpServer({ switch: switches });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'list-changed-test', version: '0.0.0' }, { capabilities: {} });
  const seen: number[] = [];
  let wake: () => void = () => {};
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    seen.push(Date.now());
    wake();
  });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  // The server registers on the client's initialized notification.
  await new Promise((resolve) => setImmediate(resolve));
  const nextNotification = () =>
    new Promise<void>((resolve) => {
      if (seen.length > 0) return resolve();
      wake = resolve;
    });
  return { server, client, seen, nextNotification };
}

describe('a module switch reaches every open MCP session', () => {
  test('the server declares tools.listChanged', async () => {
    const { client } = await openSession();
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    await client.close();
  });

  test('both sessions get list_changed, and their next tools/list is the new catalogue', async () => {
    const first = await openSession();
    const second = await openSession();
    // Every tool but the NetSuite ones (off: config.json does not name the
    // module) plus the Workato aliases of the four profile/bridge tools.
    expect((await first.client.listTools()).tools).toHaveLength(
      TOOL_SCHEMAS.length - NETSUITE_TOOL_SCHEMAS.length + Object.keys(WORKATO_TOOL_ALIASES).length,
    );

    switches.set('workato', false);
    await Promise.all([first.nextNotification(), second.nextNotification()]);

    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(1);
    expect((await first.client.listTools()).tools).toHaveLength(CORE_TOOL_SCHEMAS.length);
    expect((await second.client.listTools()).tools).toHaveLength(CORE_TOOL_SCHEMAS.length);

    await first.client.close();
    await second.client.close();
  });

  test('a new session after the change starts with the switched-off line', async () => {
    switches.set('workato', false);
    const { client } = await openSession();
    expect(client.getInstructions()).toMatch(/Switched off on this machine: Workato/);
    expect(client.getInstructions()).not.toMatch(/workato_recipe_apply/);
    await client.close();
  });

  test('a closed session is dropped from the registry', async () => {
    const before = liveMcpServerCount();
    const { client } = await openSession();
    expect(liveMcpServerCount()).toBe(before + 1);
    await client.close();
    expect(liveMcpServerCount()).toBe(before);
  });

  test('a server is registered only once its client has initialized', async () => {
    const before = liveMcpServerCount();
    const server = createMcpServer({ switch: switches });
    expect(liveMcpServerCount()).toBe(before);
    const [, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    // Connected, but no client ever initialized: nothing to notify.
    expect(liveMcpServerCount()).toBe(before);
    await server.close();
  });

  test('the count is the sends that went through, not the sessions tried', async () => {
    const first = await openSession();
    const second = await openSession();
    second.server.sendToolListChanged = () => Promise.reject(new Error('transport gone'));
    const before = liveMcpServerCount();
    expect(before).toBeGreaterThanOrEqual(2);
    expect(await notifyToolListChanged()).toBe(before - 1);
    await first.client.close();
    await second.client.close();
  });
});
