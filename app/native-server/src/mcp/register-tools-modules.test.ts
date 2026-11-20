import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { CORE_TOOL_SCHEMAS, TOOL_SCHEMAS, WORKATO_TOOL_ALIASES } from '@mokuhub/mokutab-shared';
import { INSTALLED_MODULES } from '../modules';
import { profileRegistry } from '../server/profile-registry';
import { createToolRouter } from './register-tools';

/** A module switch held in memory: everything on unless listed. */
function memorySwitch(off: string[] = []) {
  const disabled = new Set(off);
  return {
    isEnabled: (id: string) => !disabled.has(id),
    turn: (id: string, on: boolean) => (on ? disabled.delete(id) : disabled.add(id)),
  };
}

const text = (result: any) => (result.content?.[0]?.text ?? '') as string;

const ALIASES = Object.entries(WORKATO_TOOL_ALIASES);
const ALIAS_NAMES = ALIASES.map(([alias]) => alias);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('tools/list follows the module switch', () => {
  test('Workato on: core plus every Workato tool, then its aliases', async () => {
    const { tools } = await createToolRouter({ switch: memorySwitch() }).listTools();
    const workato = INSTALLED_MODULES.find((module) => module.id === 'workato')!;
    expect(tools).toHaveLength(CORE_TOOL_SCHEMAS.length + workato.tools.length + ALIASES.length);
    expect(tools).toHaveLength(TOOL_SCHEMAS.length + ALIASES.length);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set([...TOOL_SCHEMAS.map((tool) => tool.name), ...ALIAS_NAMES]),
    );
    expect(tools.slice(-ALIASES.length).map((tool) => tool.name)).toEqual(ALIAS_NAMES);
  });

  test('Workato off: the core tools only, no aliases', async () => {
    const { tools } = await createToolRouter({ switch: memorySwitch(['workato']) }).listTools();
    expect(tools).toHaveLength(CORE_TOOL_SCHEMAS.length);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      CORE_TOOL_SCHEMAS.map((tool) => tool.name).sort(),
    );
    // The four profile/bridge tools are core and stay.
    for (const name of [
      'chrome_list_profiles',
      'chrome_switch_profile',
      'chrome_bridge_info',
      'chrome_reload_extension',
    ]) {
      expect(tools.some((tool) => tool.name === name)).toBe(true);
    }
    for (const name of ALIAS_NAMES) expect(tools.some((tool) => tool.name === name)).toBe(false);
  });

  test('a switch flipped mid-session changes the next listing', async () => {
    const switches = memorySwitch();
    const router = createToolRouter({ switch: switches });
    const on = TOOL_SCHEMAS.length + ALIASES.length;
    expect((await router.listTools()).tools).toHaveLength(on);
    switches.turn('workato', false);
    expect((await router.listTools()).tools).toHaveLength(CORE_TOOL_SCHEMAS.length);
    switches.turn('workato', true);
    expect((await router.listTools()).tools).toHaveLength(on);
  });
});

describe('the 1.x names of the profile/bridge tools', () => {
  test('are exactly the four old names, each naming a core tool', () => {
    expect(ALIASES.sort()).toEqual([
      ['workato_bridge_info', 'chrome_bridge_info'],
      ['workato_list_profiles', 'chrome_list_profiles'],
      ['workato_reload_extension', 'chrome_reload_extension'],
      ['workato_switch_profile', 'chrome_switch_profile'],
    ]);
    const core = new Set(CORE_TOOL_SCHEMAS.map((tool) => tool.name));
    for (const [, target] of ALIASES) expect(core.has(target)).toBe(true);
  });

  test('are listed with the served schema of the tool they name and a pointer to it', async () => {
    const { tools } = await createToolRouter({ switch: memorySwitch() }).listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const [alias, target] of ALIASES) {
      const listed = byName.get(alias)!;
      expect(listed.inputSchema).toEqual(byName.get(target)!.inputSchema);
      expect(listed.description).toBe(`Old name of ${target}, kept until 3.0.`);
    }
  });

  test('run the tool they name: a pin made through one is the same pin', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['personal']);
    const sendRequest = jest.spyOn(profileRegistry, 'sendRequest');
    const router = createToolRouter({ switch: memorySwitch(['workato']) });
    const viaNew = await router.handleToolCall('chrome_switch_profile', { profile: 'personal' });

    const aliased = createToolRouter({ switch: memorySwitch() });
    const viaOld = await aliased.handleToolCall('workato_switch_profile', { profile: 'personal' });
    expect(JSON.parse(text(viaOld)).headline).toBe(JSON.parse(text(viaNew)).headline);
    const listedOld = JSON.parse(text(await aliased.handleToolCall('workato_list_profiles', {})));
    const listedNew = JSON.parse(text(await aliased.handleToolCall('chrome_list_profiles', {})));
    expect(listedOld.session_profile).toBe('personal');
    expect(listedOld).toEqual(listedNew);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test('workato_bridge_info answers like chrome_bridge_info', async () => {
    const router = createToolRouter({ switch: memorySwitch() });
    const viaOld = JSON.parse(text(await router.handleToolCall('workato_bridge_info', {})));
    const viaNew = JSON.parse(text(await router.handleToolCall('chrome_bridge_info', {})));
    expect(viaOld.schema_revision).toBe(viaNew.schema_revision);
    expect(viaOld.tool_count).toBe(TOOL_SCHEMAS.length + ALIASES.length);
  });

  test('with Workato off, an old name is refused with the new one, and nothing is sent', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['personal']);
    jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('personal');
    const sendRequest = jest.spyOn(profileRegistry, 'sendRequest');
    const router = createToolRouter({ switch: memorySwitch(['workato']) });

    for (const [alias, target] of ALIASES) {
      const result = await router.handleToolCall(alias, { profile: 'personal' });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(`${alias} is the old name of ${target}`);
      expect(text(result)).toContain(`Call ${target} instead`);
      expect(text(result)).not.toMatch(/not found/i);
    }
    expect(sendRequest).not.toHaveBeenCalled();
    // The tool itself still works.
    const listed = await router.handleToolCall('chrome_list_profiles', {});
    expect(listed.isError).toBeFalsy();
  });
});

describe('a switched-off module refuses its tools', () => {
  test('names the module and the popup, never "Tool not found", and sends nothing', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['personal']);
    jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('personal');
    const sendRequest = jest.spyOn(profileRegistry, 'sendRequest');
    const router = createToolRouter({ switch: memorySwitch(['workato']) });

    for (const name of ['workato_pull_recipe', 'workato_datapill', 'workato_recipe_apply']) {
      const result = await router.handleToolCall(name, { recipe_id: 1 });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(name);
      expect(text(result)).toContain('Workato module');
      expect(text(result)).toContain('MokuTab popup (Modules)');
      expect(text(result)).not.toMatch(/not found/i);
    }
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test('core tools keep working while Workato is off', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['personal']);
    jest.spyOn(profileRegistry, 'getActiveProfile').mockReturnValue('personal');
    const sendRequest = jest.spyOn(profileRegistry, 'sendRequest').mockResolvedValue({
      status: 'success',
      data: { content: [{ type: 'text', text: 'ok' }] },
    });
    const router = createToolRouter({ switch: memorySwitch(['workato']) });

    const result = await router.handleToolCall('get_windows_and_tabs', {});
    expect(result.isError).toBeFalsy();
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  test('a pin made while Workato is off is profile + tab only, with no workspace probe', async () => {
    jest.spyOn(profileRegistry, 'getConnectedProfiles').mockReturnValue(['personal']);
    const sendRequest = jest.spyOn(profileRegistry, 'sendRequest');
    const router = createToolRouter({ switch: memorySwitch(['workato']) });

    const result = await router.handleToolCall('chrome_switch_profile', {
      profile: 'personal',
      tabId: 5,
    });
    expect(sendRequest).not.toHaveBeenCalled();
    const switched = JSON.parse(text(result));
    expect(switched.headline).toContain('profile context: "personal" and tab ID: 5');
    const summary = switched.session_context;
    expect(Object.keys(summary)).toEqual(['profile', 'tab_id', 'pinned_at']);
  });

  test('chrome_bridge_info counts the catalogue that is actually served', async () => {
    const off = await createToolRouter({ switch: memorySwitch(['workato']) }).handleToolCall(
      'chrome_bridge_info',
      {},
    );
    const on = await createToolRouter({ switch: memorySwitch() }).handleToolCall(
      'chrome_bridge_info',
      {},
    );
    const offInfo = JSON.parse(text(off));
    const onInfo = JSON.parse(text(on));
    expect(offInfo.tool_count).toBe(CORE_TOOL_SCHEMAS.length);
    expect(onInfo.tool_count).toBe(TOOL_SCHEMAS.length + ALIASES.length);
    expect(offInfo.schema_revision).not.toBe(onInfo.schema_revision);
  });
});
