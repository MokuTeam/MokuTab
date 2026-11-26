import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BridgeModule } from './module-api';
import { profileRegistry } from '../server/profile-registry';
import { callModuleToolForFunction, createToolRouter } from './register-tools';

function memorySwitch(off: string[] = []) {
  const disabled = new Set(off);
  return { isEnabled: (id: string) => !disabled.has(id) };
}

const text = (result: CallToolResult) => (result.content?.[0] as any)?.text ?? '';

function fakeModule(seen: Array<{ name: string; profile: string | null }>): BridgeModule {
  return {
    id: 'netsuite',
    title: 'NetSuite',
    tools: [],
    instructions: '',
    owns: (name) => name.startsWith('netsuite_session_'),
    handle: (name, _args, ctx) => {
      seen.push({ name, profile: ctx.profile });
      return Promise.resolve({ content: [{ type: 'text', text: '{"state":"none"}' }] });
    },
  };
}

describe('callModuleToolForFunction', () => {
  test('runs an allowlisted tool in the owning module with the run profile', async () => {
    const seen: Array<{ name: string; profile: string | null }> = [];
    const result = await callModuleToolForFunction(
      'netsuite_session_ensure',
      { account: '1' },
      'work',
      1000,
      {
        modules: [fakeModule(seen)],
        switch: memorySwitch(),
      },
    );
    expect(text(result)).toBe('{"state":"none"}');
    expect(seen).toEqual([{ name: 'netsuite_session_ensure', profile: 'work' }]);
  });

  test('refuses a tool off the allowlist and a module that is off, without calling it', async () => {
    const seen: Array<{ name: string; profile: string | null }> = [];
    const offList = await callModuleToolForFunction(
      'netsuite_session_status',
      {},
      'work',
      1000,
      {
        modules: [fakeModule(seen)],
        switch: memorySwitch(),
      },
    );
    expect(offList.isError).toBe(true);
    expect(text(offList)).toMatch(/may not be called from a browser function/);
    const off = await callModuleToolForFunction('netsuite_session_publish', {}, 'work', 1000, {
      modules: [fakeModule(seen)],
      switch: memorySwitch(['netsuite']),
    });
    expect(off.isError).toBe(true);
    expect(text(off)).toMatch(/NetSuite module, which is switched off/);
    expect(seen).toEqual([]);
  });
});

describe('netsuite_session_* through the router', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-router-'));
    saved = process.env.MOKUTAB_UPDATE_STATE_DIR;
    // No ns-store-token here: the store is unconfigured, whatever this machine has.
    process.env.MOKUTAB_UPDATE_STATE_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MOKUTAB_UPDATE_STATE_DIR;
    else process.env.MOKUTAB_UPDATE_STATE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('module on: answered in the bridge, never sent to the extension', async () => {
    const send = jest.spyOn(profileRegistry, 'sendRequest');
    const router = createToolRouter({ switch: memorySwitch() });
    const result = await router.handleToolCall('netsuite_session_status', {});
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('store_unconfigured');
    const ensure = await router.handleToolCall('netsuite_session_ensure', {
      account: '1234567_SB2',
    });
    expect(text(ensure)).toContain('store_unconfigured');
    expect(send).not.toHaveBeenCalled();
  });

  test('module off: refused, nothing sent', async () => {
    const send = jest.spyOn(profileRegistry, 'sendRequest');
    const router = createToolRouter({ switch: memorySwitch(['netsuite']) });
    const result = await router.handleToolCall('netsuite_session_ensure', {
      account: '1234567_SB2',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/NetSuite module, which is switched off/);
    expect(send).not.toHaveBeenCalled();
  });
});
