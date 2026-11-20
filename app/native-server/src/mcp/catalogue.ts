/**
 * The tool catalogue as core sees it: the core schemas plus what the
 * installed modules bring, through the module registry. Core code uses this
 * instead of the shared aggregate TOOL_SCHEMAS (the boundary test refuses
 * that import), so every list of tools in core is the list the router serves.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CORE_DESTRUCTIVE_TOOL_NAMES,
  CORE_READ_ONLY_TOOL_NAMES,
  CORE_TOOL_SCHEMAS,
  aliasDescription,
} from '@mokuhub/mokutab-shared';
import { INSTALLED_MODULES } from '../modules';
import type { BridgeModule } from './module-api';

type ListedModule = Pick<BridgeModule, 'tools' | 'readOnlyTools' | 'destructiveTools'>;

/**
 * MCP annotations from the kind lists of core and the modules. A read-only
 * tool is also idempotent: a client may run it beside other reads and repeat
 * it after a dropped connection. Everything else says readOnlyHint:false. The
 * tools that only remove also say destructiveHint:true; the other writes leave
 * it unset, which a client reads as "may be destructive" (the MCP default):
 * true of the ones that run caller-chosen code or requests, and the safe side
 * for the rest.
 */
function withKindAnnotations(tools: Tool[], modules: readonly ListedModule[]): Tool[] {
  const readOnly = new Set<string>(CORE_READ_ONLY_TOOL_NAMES);
  const destructive = new Set<string>(CORE_DESTRUCTIVE_TOOL_NAMES);
  for (const module of modules) {
    for (const name of module.readOnlyTools ?? []) readOnly.add(name);
    for (const name of module.destructiveTools ?? []) destructive.add(name);
  }
  return tools.map((tool) => ({
    ...tool,
    annotations: {
      ...tool.annotations,
      ...(readOnly.has(tool.name)
        ? { readOnlyHint: true, idempotentHint: true }
        : destructive.has(tool.name)
          ? { readOnlyHint: false, destructiveHint: true }
          : { readOnlyHint: false }),
    },
  }));
}

/** The tools listed with these modules on: core first, then each module's. */
export function listedToolSchemas(modules: readonly ListedModule[]): Tool[] {
  return withKindAnnotations(
    [...CORE_TOOL_SCHEMAS, ...modules.flatMap((module) => module.tools)],
    modules,
  );
}

/** Every tool this bridge has: core plus every installed module, on or off. */
export function installedToolSchemas(): Tool[] {
  return listedToolSchemas(INSTALLED_MODULES);
}

/**
 * `tools` followed by the aliases of these (enabled) modules. Applied last,
 * to the served list: an alias is a copy of its target as served (routing,
 * file and lease params included), so the two can never take different
 * arguments; only the name and a pointer for a description differ.
 */
export function withAliasToolSchemas(
  tools: Tool[],
  modules: readonly Pick<BridgeModule, 'aliases'>[],
): Tool[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const aliases: Tool[] = [];
  for (const module of modules) {
    for (const [alias, target] of Object.entries(module.aliases ?? {})) {
      const tool = byName.get(target);
      if (tool) aliases.push({ ...tool, name: alias, description: aliasDescription(target) });
    }
  }
  return aliases.length > 0 ? [...tools, ...aliases] : tools;
}
