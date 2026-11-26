/**
 * Installed modules, and the full catalogue assembled from core plus every
 * module.
 *
 * This is the one place outside a module folder that knows the modules. The
 * bridge and the extension list and switch them through MODULES; TOOL_NAMES
 * and TOOL_SCHEMAS keep their pre-module contents (every tool, whatever is
 * switched on) for the consumers that want the whole catalogue.
 */
import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolModule } from '../module';
import { CORE_TOOL_NAMES, CORE_TOOL_SCHEMAS } from '../tools';
import { WORKATO_MODULE, WORKATO_TOOL_NAMES } from './workato';
import { NETSUITE_MODULE, NETSUITE_TOOL_NAMES } from './netsuite';

export {
  WORKATO_MODULE,
  WORKATO_MODULE_ID,
  WORKATO_MODULE_TITLE,
  WORKATO_TOOL_NAMES,
  WORKATO_TOOL_SCHEMAS,
  WORKATO_INSTRUCTIONS,
  WORKATO_TOOL_ALIASES,
  WORKATO_DESTRUCTIVE_TOOL_NAMES,
  WORKATO_READ_ONLY_TOOL_NAMES,
  WORKATO_TAB_SHARED_TOOL_NAMES,
} from './workato';

export {
  NETSUITE_MODULE,
  NETSUITE_MODULE_ID,
  NETSUITE_MODULE_TITLE,
  NETSUITE_TOOL_NAMES,
  NETSUITE_TOOL_SCHEMAS,
  NETSUITE_INSTRUCTIONS,
  NETSUITE_READ_ONLY_TOOL_NAMES,
  NETSUITE_DESTRUCTIVE_TOOL_NAMES,
  NETSUITE_FN_TOOL_NAMES,
} from './netsuite';

/** Every installed module, in listing order. */
export const MODULES: readonly ToolModule[] = [WORKATO_MODULE, NETSUITE_MODULE];

/**
 * Every tool name, grouped as before the module split, plus BRIDGE: the four
 * core profile/bridge tools, which sat in WORKATO while they carried the
 * workato_ prefix.
 */
export const TOOL_NAMES = {
  BROWSER: CORE_TOOL_NAMES.BROWSER,
  BRIDGE: CORE_TOOL_NAMES.BRIDGE,
  WORKATO: WORKATO_TOOL_NAMES.WORKATO,
  WORKATO_UI: WORKATO_TOOL_NAMES.WORKATO_UI,
  WORKATO_RECIPE: WORKATO_TOOL_NAMES.WORKATO_RECIPE,
  WORKATO_LCAP: WORKATO_TOOL_NAMES.WORKATO_LCAP,
  WORKATO_LOOKUP: WORKATO_TOOL_NAMES.WORKATO_LOOKUP,
  WORKATO_DATA_TABLE: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE,
  WORKATO_SESSION: WORKATO_TOOL_NAMES.WORKATO_SESSION,
  NETSUITE_SESSION: NETSUITE_TOOL_NAMES.NETSUITE_SESSION,
};

/**
 * Every tool schema: core first, then each module's.
 *
 * Top-level code here must stay side-effect free for the bundler: a bare
 * spread or loop over the schemas keeps all of them in every bundle that
 * imports anything from this package (the extension popup and service worker
 * need names only). Hence the pure call and the lazy owner map.
 */
export const TOOL_SCHEMAS: Tool[] = /* @__PURE__ */ allToolSchemas();

function allToolSchemas(): Tool[] {
  return [...CORE_TOOL_SCHEMAS, ...MODULES.flatMap((m) => m.tools)];
}

let owners: Map<string, ToolModule> | undefined;

/** The installed module a tool belongs to, or undefined for a core (or unknown) tool. */
export function moduleOfTool(name: string): ToolModule | undefined {
  if (!owners) {
    owners = new Map();
    for (const module of MODULES) {
      for (const tool of module.tools) owners.set(tool.name, module);
    }
  }
  return owners.get(name);
}
