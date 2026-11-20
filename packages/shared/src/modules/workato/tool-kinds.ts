/**
 * What kind of call each Workato tool is. Plain name lists, with no schema
 * behind them, so the extension can import one without the catalogue.
 */

/**
 * Tools that change nothing in Workato and nothing in the page. Served with
 * readOnlyHint. Absent on purpose: workato_deploy_plan (opens a draft
 * deployment), workato_step_schema (apply_to writes a step),
 * workato_properties (reads and writes), workato_operation_status (finishes an
 * interrupted operation), workato_lcap_page_validate (its render check opens
 * and closes a tab), and the tools that run caller-chosen requests, queries or
 * actions.
 *
 * The hint is about Workato and the page. A read tool still writes the local
 * file a caller names in out_file, so a client must not take the hint as
 * leave to skip its own check of the arguments.
 */
export const WORKATO_READ_ONLY_TOOL_NAMES: readonly string[] = [
  'workato_whoami',
  'workato_session_context',
  'workato_pull_recipe',
  'workato_recipe_grep',
  'workato_recipe_status',
  'workato_recipe_version_diff',
  'workato_recipe_validate',
  'workato_recipe_callers',
  'workato_recipe_connections',
  'workato_recipe_step_search',
  'workato_job_trace',
  'workato_list_jobs',
  'workato_search_recipes',
  'workato_search_connections',
  'workato_get_connection',
  'workato_deployments_list',
  'workato_list_folders',
  'workato_adapter_meta',
  'workato_apps_list',
  'workato_pick_list',
  'workato_datapill',
  'workato_lookup_tables_list',
  'workato_lookup_table_get',
  'workato_lookup_table_row_search',
  'workato_data_tables_list',
  'workato_data_table_get',
  'workato_data_table_row_list',
  'workato_lcap_apps_list',
  'workato_lcap_page_get',
  'workato_ui_list_steps',
];

/** Tools whose whole job is to remove something. Served with destructiveHint. */
export const WORKATO_DESTRUCTIVE_TOOL_NAMES: readonly string[] = [
  'workato_delete_recipe',
  'workato_delete_folder',
  'workato_lookup_table_delete',
  'workato_lookup_table_row_delete',
  'workato_data_table_delete',
  'workato_data_table_delete_column',
  'workato_data_table_row_delete',
  'workato_lcap_page_delete',
];

/** Read-only tools that read the page's DOM, so they keep their turn on the tab. */
const DOM_READERS: readonly string[] = ['workato_ui_list_steps'];

/**
 * Read-only tools that are nothing but fetches made from the page: several of
 * them may run on one tab at once. The extension's per-tab queue lets these
 * overlap each other and still keeps them apart from every call that drives
 * the page.
 */
export const WORKATO_TAB_SHARED_TOOL_NAMES: readonly string[] =
  /* @__PURE__ */ WORKATO_READ_ONLY_TOOL_NAMES.filter((name) => !DOM_READERS.includes(name));
