/**
 * The Workato module, bridge side: its tools, its instructions, and the hooks
 * the router calls (file params, bridge-side tools, the workspace pin).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WORKATO_MODULE } from '@mokuhub/mokutab-shared';
import type { BridgeModule, JsonObject, PreparedModuleCall } from '../../mcp/module-api';
import { readContextBlock } from '../../mcp/tool-result';
import {
  isWorkatoFileTool,
  prepareWorkatoCall,
  writePulledRecipe,
  type RecipeFileOrigin,
} from './file-io';
import { isWorkatoLcapFileTool, prepareLcapCall, writeLcapOutFile } from './lcap-io';
import { handleWorkatoRecipeMutatorCall, isWorkatoRecipeMutatorTool } from './recipe-mutators';
import { handleWorkatoCallableCall, isWorkatoCallableTool } from './callable-schema';
import {
  handleWorkatoSaveWithDependentsCall,
  isWorkatoSaveWithDependentsTool,
} from './save-dependents';
import { handleWorkatoDatapillCall, isWorkatoDatapillTool } from './datapill';
import { handleWorkatoOperationCall, isWorkatoOperationTool } from './operation-status';
import { handleWorkatoStepSchemaApplyCall, isStepSchemaApplyCall } from './step-schema';
import { createWorkatoSessionHooks } from './session';

const OWNED = new Set(WORKATO_MODULE.tools.map((tool) => tool.name));

const TOOL_PREFIX = 'workato_';

/**
 * Read tools that spill to a file on their own once a result gets large.
 *
 * Tools with their own out_file hook (pull_recipe, lcap_page_get, api_request,
 * adapter_meta) are deliberately absent: they keep their existing behaviour.
 */
export const WORKATO_READ_TOOLS = new Set<string>([
  'workato_list_jobs',
  'workato_job_trace',
  'workato_search_recipes',
  'workato_recipe_step_search',
  'workato_recipe_callers',
  'workato_recipe_grep',
  'workato_recipe_connections',
  'workato_recipe_version_diff',
  'workato_recipe_status',
  'workato_apps_list',
  'workato_pick_list',
  'workato_step_schema',
  'workato_run_query',
  'workato_call_action',
  'workato_lookup_tables_list',
  'workato_lookup_table_get',
  'workato_lookup_table_row_search',
  'workato_data_tables_list',
  'workato_data_table_get',
  'workato_data_table_row_list',
  'workato_deployments_list',
  // Opens only a draft deployment; its step diffs can run to tens of KB.
  'workato_deploy_plan',
]);

/** Origin metadata for a recipe file, from the pull response and the routing. */
function buildPullOrigin(
  result: CallToolResult,
  profile: string | null,
  args: JsonObject,
): Partial<RecipeFileOrigin> {
  const context = readContextBlock(result);
  const origin: Partial<RecipeFileOrigin> = {};
  if (profile) origin.profile = profile;
  const tabId =
    typeof context?.tab_id === 'number'
      ? context.tab_id
      : typeof args?.tabId === 'number'
        ? args.tabId
        : undefined;
  if (tabId !== undefined) origin.tab_id = tabId;
  if (typeof context?.host === 'string') origin.host = context.host;
  if (typeof context?.workspace_id === 'number') origin.workspace_id = context.workspace_id;
  if (typeof context?.workspace_name === 'string') origin.workspace_name = context.workspace_name;
  if (context?.environment !== undefined && context.environment !== null) {
    origin.environment = String(context.environment);
  }
  return origin;
}

/**
 * workato_pull_recipe(out_file) / workato_ui_save_recipe_code(code_path), and
 * workato_lcap_page_get(out_file) / *_save(content_path) / api_request(out_file):
 * resolved here, in the bridge, because this process has the filesystem.
 */
function prepare(name: string, args: JsonObject): PreparedModuleCall {
  if (isWorkatoFileTool(name)) {
    const prepared = prepareWorkatoCall(name, args);
    const outFile = prepared.pullOutFile;
    if (!outFile) return { args: prepared.args };
    return {
      args: prepared.args,
      finish: (result, call) =>
        writePulledRecipe(outFile, result, buildPullOrigin(result, call.profile, call.args)),
    };
  }
  if (isWorkatoLcapFileTool(name)) {
    const prepared = prepareLcapCall(name, args);
    const outFile = prepared.outFile;
    if (!outFile) return { args: prepared.args };
    return { args: prepared.args, finish: (result) => writeLcapOutFile(outFile, result) };
  }
  return { args };
}

export const workatoModule: BridgeModule = {
  id: WORKATO_MODULE.id,
  title: WORKATO_MODULE.title,
  tools: WORKATO_MODULE.tools,
  instructions: WORKATO_MODULE.instructions,
  // The 1.x workato_* names of the core profile/bridge tools, until 3.0.
  aliases: WORKATO_MODULE.aliases,
  readOnlyTools: WORKATO_MODULE.readOnlyTools,
  destructiveTools: WORKATO_MODULE.destructiveTools,
  // Every 1.x bridge served the Workato tools.
  onAfterUpgrade: true,
  owns: (name) => OWNED.has(name),

  autoFile: {
    readTools: WORKATO_READ_TOOLS,
    // Every other Workato tool takes an explicit out_file, except the ones
    // that write their own files.
    accepts: (name) => OWNED.has(name) && !isWorkatoFileTool(name) && !isWorkatoLcapFileTool(name),
    fileStem: (name) => (OWNED.has(name) ? name.slice(TOOL_PREFIX.length) : undefined),
  },

  prepare,

  // `workato_datapill` is pure string assembly, no browser round trip. The
  // orchestrators drive several extension tools in sequence (pull -> mutate ->
  // save, or stop -> save -> restore) and need Node's filesystem for
  // code_path, so they run here rather than in the page.
  handle(name, args, ctx) {
    if (isWorkatoDatapillTool(name)) return Promise.resolve(handleWorkatoDatapillCall(name, args));
    if (isWorkatoRecipeMutatorTool(name)) {
      return handleWorkatoRecipeMutatorCall(name, args, ctx.callExtension);
    }
    // workato_step_schema(apply_to): generate in the extension, then write
    // both schemas onto the step in one saved version.
    if (isStepSchemaApplyCall(name, args)) {
      return handleWorkatoStepSchemaApplyCall(name, args, ctx.callExtension);
    }
    if (isWorkatoCallableTool(name))
      return handleWorkatoCallableCall(name, args, ctx.callExtension);
    // Journal reads happen in this process; only refresh/resume calls out.
    if (isWorkatoOperationTool(name)) {
      return handleWorkatoOperationCall(name, args, ctx.callExtension);
    }
    if (isWorkatoSaveWithDependentsTool(name)) {
      return handleWorkatoSaveWithDependentsCall(name, args, ctx.callExtension);
    }
    return undefined;
  },

  session: createWorkatoSessionHooks((name) => OWNED.has(name)),
};
