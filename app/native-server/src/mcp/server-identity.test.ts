import { describe, expect, test } from '@jest/globals';
import { CORE_TOOL_SCHEMAS, MODULES, TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { INSTALLED_MODULES } from '../modules';
import {
  buildServerInstructions,
  CORE_INSTRUCTIONS,
  SERVER_NAME,
  serverVersion,
} from './server-identity';

/**
 * Tools the instructions name that this wave is still adding in a parallel
 * package. They are deliberately advertised ahead of their schemas so the
 * guidance ships whole; when their packages merge, they leave this list and
 * the assertion below starts covering them.
 */
const PENDING_TOOL_NAMES: string[] = [];

function toolNamesIn(text: string): string[] {
  return [...new Set(text.match(/\b(?:workato|chrome)_[a-z0-9_]+/g) ?? [])];
}

function allToolNames(): Set<string> {
  const names = new Set<string>();
  for (const family of Object.values(TOOL_NAMES)) {
    for (const name of Object.values(family as Record<string, string>)) names.add(name);
  }
  return names;
}

/** Every on/off combination of the installed modules, as an enabled-id set. */
function combinations(): Set<string>[] {
  const ids = INSTALLED_MODULES.map((module) => module.id);
  const out: Set<string>[] = [];
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    out.push(new Set(ids.filter((_, index) => (mask & (1 << index)) !== 0)));
  }
  return out;
}

const instructionsFor = (on: Set<string>) =>
  buildServerInstructions(INSTALLED_MODULES, (id) => on.has(id));

describe('server identity', () => {
  test('the handshake names the product, not the upstream project', () => {
    expect(SERVER_NAME).toBe('MokuTab');
  });

  test('the version is the real bridge version, never the old hardcoded 1.0.0', () => {
    const version = serverVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version).not.toBe('1.0.0');
  });
});

describe('server instructions', () => {
  test('the bridge installs exactly the shared modules', () => {
    expect(INSTALLED_MODULES.map((module) => module.id)).toEqual(MODULES.map((m) => m.id));
  });

  test('every on/off combination stays under the 1800-byte budget', () => {
    for (const on of combinations()) {
      const size = Buffer.byteLength(instructionsFor(on), 'utf8');
      expect(size).toBeGreaterThan(200);
      expect(size).toBeLessThan(1800);
    }
  });

  test('a module that is on adds its snippet; one that is off is named in one line', () => {
    const all = new Set(INSTALLED_MODULES.map((module) => module.id));
    const allOn = instructionsFor(all);
    const allOff = instructionsFor(new Set());
    expect(allOn.startsWith(CORE_INSTRUCTIONS)).toBe(true);
    expect(allOff.startsWith(CORE_INSTRUCTIONS)).toBe(true);
    for (const module of INSTALLED_MODULES) {
      expect(allOn).toContain(module.instructions);
      expect(allOff).not.toContain(module.instructions);
      expect(allOff).toContain(module.title);
    }
    expect(allOn).not.toMatch(/Switched off/);
    expect(allOff).toMatch(/Switched off on this machine: .*MokuTab popup/);
  });

  test('every tool they name is served in that combination', () => {
    for (const on of combinations()) {
      const served = new Set([
        ...CORE_TOOL_SCHEMAS.map((tool) => tool.name),
        ...INSTALLED_MODULES.filter((module) => on.has(module.id)).flatMap((module) =>
          module.tools.map((tool) => tool.name),
        ),
      ]);
      const missing = toolNamesIn(instructionsFor(on)).filter(
        (name) => !served.has(name) && !PENDING_TOOL_NAMES.includes(name),
      );
      expect(missing).toEqual([]);
    }
  });

  test('a pending tool that has landed must be removed from the pending list', () => {
    const known = allToolNames();
    const landed = PENDING_TOOL_NAMES.filter((name) => known.has(name));
    // A name listed here that now exists must be dropped from PENDING_TOOL_NAMES.
    expect(landed).toEqual([]);
  });

  /**
   * Every tool the instructions named before the module split (the routing
   * table of 1.13). Rewording the snippets must never drop a route: a tool
   * that leaves this list leaves it on purpose, here. workato_bridge_info
   * became chrome_bridge_info in 2.0 (the old name is a Workato alias, which
   * the instructions do not advertise).
   */
  const ROUTES_BEFORE_THE_SPLIT = [
    'workato_apps_list',
    'workato_adapter_meta',
    'workato_step_schema',
    'workato_recipe_set_input_path',
    'workato_recipe_apply',
    'workato_recipe_grep',
    'workato_job_trace',
    'workato_list_jobs',
    'workato_recipe_callers',
    'workato_recipe_connections',
    'workato_recipe_validate',
    'workato_recipe_save_with_dependents',
    'workato_operation_status',
    'workato_test_recipe',
    'workato_session_context',
    'chrome_bridge_info',
    'workato_switch_environment',
    'workato_deploy_plan',
    'workato_deploy_run',
    'chrome_lease_tab',
    'chrome_watch_start',
  ];

  test('still name every route the instructions had before the split', () => {
    const allOn = instructionsFor(new Set(INSTALLED_MODULES.map((module) => module.id)));
    expect(toolNamesIn(allOn).sort()).toEqual([...ROUTES_BEFORE_THE_SPLIT].sort());
    for (const word of ['auto_file', 'out_file', 'wait_command']) expect(allOn).toContain(word);
  });

  test('with a module off, its routes are gone and every core route stays', () => {
    const allOff = instructionsFor(new Set());
    for (const name of ['chrome_bridge_info', 'chrome_lease_tab', 'chrome_watch_start']) {
      expect(allOff).toContain(name);
    }
    // The core snippet names no workato_* tool since the profile/bridge tools are chrome_*.
    expect(toolNamesIn(allOff).filter((name) => name.startsWith('workato_'))).toEqual([]);
  });

  test('the core snippet names core tools only', () => {
    const core = new Set(CORE_TOOL_SCHEMAS.map((tool) => tool.name));
    expect(toolNamesIn(CORE_INSTRUCTIONS).filter((name) => !core.has(name))).toEqual([]);
  });

  test('carry no em-dash or en-dash', () => {
    for (const on of combinations()) expect(instructionsFor(on)).not.toMatch(/[–—]/);
  });
});
