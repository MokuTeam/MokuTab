import { describe, expect, test } from '@jest/globals';
import {
  CORE_DESTRUCTIVE_TOOL_NAMES,
  CORE_READ_ONLY_TOOL_NAMES,
  CORE_TOOL_SCHEMAS,
  WORKATO_DESTRUCTIVE_TOOL_NAMES,
  WORKATO_MODULE,
  WORKATO_READ_ONLY_TOOL_NAMES,
  WORKATO_TAB_SHARED_TOOL_NAMES,
} from '@mokuhub/mokutab-shared';
import { INSTALLED_MODULES } from '../modules';
import { listedToolSchemas } from './catalogue';

describe('tool kinds', () => {
  test('every name in a kind list is a tool of the catalogue it belongs to', () => {
    const core = new Set(CORE_TOOL_SCHEMAS.map((tool) => tool.name));
    const workato = new Set(WORKATO_MODULE.tools.map((tool) => tool.name));
    for (const name of [...CORE_READ_ONLY_TOOL_NAMES, ...CORE_DESTRUCTIVE_TOOL_NAMES]) {
      expect([name, core.has(name)]).toEqual([name, true]);
    }
    for (const name of [...WORKATO_READ_ONLY_TOOL_NAMES, ...WORKATO_DESTRUCTIVE_TOOL_NAMES]) {
      expect([name, workato.has(name)]).toEqual([name, true]);
    }
  });

  test('no tool is both read-only and destructive, and no name is listed twice', () => {
    const readOnly = [...CORE_READ_ONLY_TOOL_NAMES, ...WORKATO_READ_ONLY_TOOL_NAMES];
    const destructive = [...CORE_DESTRUCTIVE_TOOL_NAMES, ...WORKATO_DESTRUCTIVE_TOOL_NAMES];
    expect(new Set(readOnly).size).toBe(readOnly.length);
    expect(new Set(destructive).size).toBe(destructive.length);
    expect(readOnly.filter((name) => destructive.includes(name))).toEqual([]);
  });

  test('the tools that may overlap on a tab are read-only, and none of them reads the DOM', () => {
    for (const name of WORKATO_TAB_SHARED_TOOL_NAMES) {
      expect(WORKATO_READ_ONLY_TOOL_NAMES).toContain(name);
      expect(name.startsWith('workato_ui_')).toBe(false);
    }
    expect(WORKATO_TAB_SHARED_TOOL_NAMES).toContain('workato_pull_recipe');
  });

  test('a tool that can write is never listed as read-only', () => {
    const readOnly = new Set([...CORE_READ_ONLY_TOOL_NAMES, ...WORKATO_READ_ONLY_TOOL_NAMES]);
    for (const name of [
      'chrome_javascript',
      'chrome_navigate',
      'chrome_get_web_content',
      'chrome_screenshot',
      'workato_api_request',
      'workato_call_action',
      'workato_run_query',
      'workato_properties',
      'workato_step_schema',
      'workato_deploy_plan',
      'workato_operation_status',
      'workato_lcap_page_validate',
    ]) {
      expect([name, readOnly.has(name)]).toEqual([name, false]);
    }
  });
});

describe('listedToolSchemas annotations', () => {
  const byName = new Map(listedToolSchemas(INSTALLED_MODULES).map((tool) => [tool.name, tool]));

  test('every tool says whether it is read-only', () => {
    for (const tool of byName.values()) {
      expect([tool.name, typeof tool.annotations?.readOnlyHint]).toEqual([tool.name, 'boolean']);
    }
  });

  test('a read is read-only and repeatable, a delete says destructive, another write leaves it to the default', () => {
    expect(byName.get('chrome_snapshot')!.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(byName.get('workato_pull_recipe')!.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(byName.get('workato_delete_recipe')!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.get('workato_recipe_apply')!.annotations).toEqual({ readOnlyHint: false });
  });

  test('a module that is not listed adds no kinds', () => {
    const coreOnly = listedToolSchemas([]);
    expect(coreOnly.every((tool) => !tool.name.startsWith('workato_'))).toBe(true);
    expect(coreOnly.find((tool) => tool.name === 'chrome_close_tabs')!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});
