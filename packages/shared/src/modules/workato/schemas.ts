/**
 * Workato module tool schemas.
 */
import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { WORKATO_TOOL_NAMES } from './tool-names';

export const WORKATO_TOOL_SCHEMAS: Tool[] = [
  {
    name: WORKATO_TOOL_NAMES.WORKATO.PULL_RECIPE,
    description:
      "Fetch a Workato recipe's code tree plus version metadata. Read-only. " +
      'Requires an open Workato tab (*.workato.com or *.workato.is) using the same ' +
      "session as the recipe's account.\n\n" +
      'By default returns a COMPACT view: the step tree with UI metadata stripped, ' +
      '_dp(...) datapills shortened to datapill(...), loop semantics kept (source, ' +
      'repeat_mode, clear_scope, batch_size), and any value over 240 chars replaced ' +
      'by a "<<preview ... path=...>>" marker naming the read-back call. Every view ' +
      'carries version_no; every list has a limit, a total and a cursor, and a filter ' +
      'never removes the limit.\n\n' +
      'Usage pipeline:\n' +
      '1. pull_recipe(recipe_id) -> compact tree, the cheap whole-recipe index.\n' +
      '2. view:"outline" -> structure, descriptions and input_keys only, for recipes ' +
      'that overflow compact.\n' +
      '3. step:"<as|number>" -> one step: `mappings` (classified input leaves), the ' +
      'settable `fields`, plus `available_datapills` / raw `schemas` on request via ' +
      '[include]. steps:["a","b"] reads several against ONE snapshot. A step with no ' +
      "schema of its own gets the adapter's static fields merged in, each tagged " +
      'provenance static|dynamic|both, with fields_complete.\n' +
      '4. paths:["input.code"] -> exact values, lossless. The way back from a ' +
      'preview marker.\n' +
      '5. fields:"text" -> narrow `mappings`/`fields`/`available_datapills`.\n' +
      '6. view:"full" -> the lossless raw tree; use [out_file] when it is large.\n\n' +
      'Use workato_recipe_grep to find WHERE a value appears. if_version:<n> answers ' +
      '{unchanged:true, version_no} without refetching.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Numeric Workato recipe id, e.g. 72449879. Found in the recipe URL: ' +
            'app.workato.com/recipes/<recipe_id>-<slug>.',
        },
        view: {
          type: 'string',
          enum: ['compact', 'outline', 'full'],
          description:
            "Whole-recipe read mode. 'compact' (default) strips UI metadata, shortens " +
            "datapills and previews long values; 'outline' replaces every step's input " +
            "with its top-level input_keys (lightest, for very large recipes); 'full' " +
            'returns the lossless raw code tree. With [step], view:"full" returns the ' +
            'raw step node.',
        },
        step: {
          type: 'string',
          description:
            "Drill into a single step. Accepts the step's 'as' anchor or its " +
            'numeric step number. Returns the step header (loop source included), its ' +
            '`mappings` (classified input leaves, the wiring and logic) and the ' +
            'settable `fields`. Pass view:"full" with step to return the raw step node, ' +
            'including schemas.',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Several step refs ("as" anchors or numbers) inspected against ONE ' +
            'snapshot, in the order given. Cheaper than one call per step. Refs that do ' +
            'not exist come back in `not_found`. Mutually exclusive with [step].',
        },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['mappings', 'fields', 'datapills', 'schemas', 'code'] },
          description:
            'Sections of a step view to return. Default ["mappings","fields"]. ' +
            '"datapills" adds the upstream pills this step can reference (loop items ' +
            'included), "schemas" adds the raw extended_input_schema / ' +
            'extended_output_schema entries, "code" returns `code` and `query` bodies ' +
            'whole instead of previewed.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Exact paths returned LOSSLESSLY: no datapill shortening, no preview, no ' +
            'budget cut. Dot/bracket syntax resolved against the step node when [step] ' +
            'is set, else against the recipe root, e.g. "input.code", ' +
            '"input.conditions[0].lhs". This is the read-back for a preview marker.',
        },
        fields: {
          type: 'string',
          description:
            'Case-insensitive substring filter for [step] mode. Matched against a ' +
            'mapping path, a field name or label, and a datapill ref or label. It ' +
            'narrows the lists; it does NOT lift [max_items]. Alias: field_query.',
        },
        field_query: {
          type: 'string',
          description: 'Older name for [fields]. Same behaviour.',
        },
        max_items: {
          type: 'number',
          description:
            'Items returned per list (mappings, fields, datapills, schema entries, and ' +
            'steps in compact/outline). Default 60, hard maximum 500. Each list reports ' +
            'its total, and a truncated response carries next_cursor.',
          minimum: 1,
          maximum: 500,
        },
        budget_chars: {
          type: 'number',
          description:
            'Character budget for the response. Default 12000 for step views, 60000 ' +
            'for compact/outline. Lists are cut at item boundaries; the response then ' +
            'carries truncated:true and next_cursor. Exact [paths] reads are exempt.',
          minimum: 500,
          maximum: 400000,
        },
        cursor: {
          type: 'string',
          description:
            'Opaque continuation token from a previous truncated response. Repeat the ' +
            'same call with it to get the next items without repeats.',
        },
        if_version: {
          type: 'number',
          description:
            'Answer {unchanged:true, version_no} when the recipe is still at this ' +
            'version, without transferring the code. Use the version_no from a previous ' +
            'read to re-check cheaply.',
        },
        out_file: {
          type: 'string',
          description:
            'Absolute path to write the complete recipe to as a JSON file (envelope: ' +
            '{recipe_id, name, version_no, code, config}). When set, the full code tree ' +
            'is saved to disk and the response returns only a compact summary plus a ' +
            'step list: the raw tree never enters the agent context. Forces full view; ' +
            'the projection params ([view], [step], [steps], [paths], [fields], ' +
            '[include], [max_items], [budget_chars], [cursor], [if_version]) are ' +
            'ignored. Edit the file, then push it back with ' +
            'workato_ui_save_recipe_code(code_path). The file also records an origin block ' +
            '(pulled_at, profile, tab, host, workspace, environment, folder) that the save uses ' +
            'to default the version lock and to refuse a push into another workspace.',
        },
        timeout_ms: {
          type: 'number',
          description:
            'In-page fetch timeout in milliseconds. Default 30000, clamped 10000-110000. ' +
            'Raise for very large recipes (300 KB+ code trees) that time out at the default.',
          minimum: 10000,
          maximum: 110000,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.RECIPE_GREP,
    description:
      'Find a string INSIDE one Workato recipe without pulling the recipe into ' +
      'context. Read-only. Requires an open Workato tab (*.workato.com or ' +
      "*.workato.is) using the same session as the recipe's account.\n\n" +
      'The recipe tree is searched locally and only the MATCHES come back: each ' +
      'one carries the step it belongs to ({number, as, keyword, provider, name, ' +
      'title}), the exact path, a bounded snippet, and the full length of the ' +
      'value. Answers "which step sets this field", "where is this account id ' +
      'hard-coded", "which step mentions this table" for the price of the matches ' +
      'instead of the price of the recipe.\n\n' +
      'The reported path is the one workato_pull_recipe(step, paths:[...]) reads ' +
      'back losslessly, so a hit turns straight into an exact read, and ' +
      'workato_recipe_set_input_path takes the same path minus the "input." ' +
      'prefix. Datapills are matched in their raw _dp(...) form, so a step line id ' +
      '(e.g. "e4f443bd") finds every reference to that step.\n\n' +
      'Use workato_pull_recipe when the step is already known, and ' +
      'workato_recipe_step_search to find steps across MANY recipes.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Numeric Workato recipe id, e.g. 72449879. Found in the recipe URL: ' +
            'app.workato.com/recipes/<recipe_id>-<slug>.',
        },
        query: {
          type: 'string',
          description:
            'What to look for. Interpreted according to [match]; case-insensitive in ' +
            'every mode.',
        },
        match: {
          type: 'string',
          enum: ['substring', 'word', 'regex'],
          description:
            "How [query] is interpreted. 'substring' (default) is a plain contiguous " +
            "match; 'word' matches whole words only; 'regex' is a JavaScript regular " +
            'expression, limited to 200 characters, refused when a quantifier is ' +
            'applied to a group that already contains one (e.g. "(a+)+"), and run ' +
            'against the first 20000 characters of each value.',
        },
        scope: {
          type: 'string',
          enum: ['input', 'all'],
          description:
            "Where to look. 'all' (default) covers step input (conditions included), " +
            'titles, descriptions, comments, the foreach source, the extended schemas, ' +
            "the picker selections that hold a called recipe's NAME, and the job report " +
            "columns on the trigger. 'input' searches only the configured input, which " +
            'is the fastest way to find a mapping.',
        },
        max_matches: {
          type: 'number',
          description:
            'Matches returned per call. Default 50, maximum 500. total_matches always ' +
            'reports how many exist; a truncated response carries next_cursor.',
          minimum: 1,
          maximum: 500,
        },
        cursor: {
          type: 'string',
          description:
            'Opaque continuation token from a previous truncated response. Repeat the ' +
            'same call with it to get the next matches without repeats.',
        },
        snippet_chars: {
          type: 'number',
          description:
            'Characters of context returned around each match. Default 160, clamped ' +
            '20-2000. A value shorter than this comes back whole.',
          minimum: 20,
          maximum: 2000,
        },
        timeout_ms: {
          type: 'number',
          description:
            'In-page fetch timeout in milliseconds. Default 30000, clamped ' +
            '10000-110000. Raise for very large recipes.',
          minimum: 10000,
          maximum: 110000,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: {
          type: 'number',
          description:
            'Accepted for call-shape symmetry with the browser tools and otherwise ' +
            'ignored: this tool resolves its tab from [tabId] or the session pinned tab.',
        },
      },
      required: ['recipe_id', 'query'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.RENAME_RECIPE,
    description:
      'Rename a Workato recipe by PUTting /recipes/<id>.json with {flow:{name}}. ' +
      'Returns the recipe id, new name, version number, updated_at, folders, and validation errors if Workato returns them. ' +
      'Requires an open Workato tab (*.workato.com or *.workato.is) using the same session as the recipe account.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Numeric Workato recipe id. Found in the recipe URL: app.workato.com/recipes/<recipe_id>-<slug>.',
        },
        name: {
          type: 'string',
          description: 'New recipe name.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id', 'name'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.SET_VERSION_COMMENT,
    description:
      'Set the comment on a specific Workato recipe version by PUTting /recipes/<id>/versions/<version>.json with {comment}. ' +
      'Use it to annotate a version in the recipe Versions tab (e.g. what changed and why). Pass an empty string to clear the comment. ' +
      'TIP: when the comment belongs to a save you are about to make, pass comment: directly to ' +
      'workato_ui_save_recipe_code instead: one call, one timeout window. ' +
      'If this request times out, the tool verifies whether the comment landed before reporting failure ' +
      '(succeeded_after_timeout:true in the response). ' +
      'Returns the recipe id, version, and comment. Requires an open Workato tab (*.workato.com or *.workato.is) using the same session as the recipe account.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Numeric Workato recipe id. Found in the recipe URL: app.workato.com/recipes/<recipe_id>-<slug>.',
        },
        version: {
          type: 'number',
          description:
            'Recipe version number to annotate, as shown in the recipe Versions tab (version_no from workato_pull_recipe).',
        },
        comment: {
          type: 'string',
          description: 'Comment text to attach to the version. Empty string clears the comment.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id', 'version', 'comment'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.START_RECIPE,
    description:
      'Start a Workato recipe by POSTing /web_api/recipes/<id>/start.json. ' +
      'Returns the enqueue status; pass wait:true to poll until the recipe actually reports running. ' +
      'If the request times out, the tool verifies actual recipe state before reporting failure ' +
      '(status "succeeded_after_timeout" means the start landed despite the timeout). ' +
      'Every response carries outcome: "state_reached" (the recipe reports running), "accepted" ' +
      '(Workato took the request and the end state is NOT verified) or "failed". Workato answers ' +
      '202 even when a recipe cannot start, so when wait:true ends without the state flipping the ' +
      'tool reads the activation record and, if Workato refused, returns an ERROR with start_error ' +
      '{state, code_errors, config_errors [{line_number, field, value, message}], param_errors, ' +
      'requirements_errors, message} naming the offending line and field; a config error about ' +
      'account_id also attaches a connections summary (see workato_recipe_connections). ' +
      'Requires an open Workato tab (*.workato.com or *.workato.is) using the same session as the recipe account.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Numeric Workato recipe id. Found in the recipe URL: app.workato.com/recipes/<recipe_id>-<slug>.',
        },
        wait: {
          type: 'boolean',
          description:
            'Poll workato_recipe_status until running=true (or the wait window expires). Response includes state, running, waited_ms, state_flipped.',
          default: false,
        },
        wait_timeout_ms: {
          type: 'number',
          description: 'Max polling window for wait:true. Default 20000, clamped 1000-60000.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.STOP_RECIPE,
    description:
      'Stop a Workato recipe by POSTing /web_api/recipes/<id>/stop.json. ' +
      'Pass force:true when Workato reports active dependent recipes and you still want to enqueue the stop. ' +
      'Returns the enqueue status; pass wait:true to poll until the recipe actually reports stopped. ' +
      'If the request times out, the tool verifies actual recipe state before reporting failure ' +
      '(status "succeeded_after_timeout" means the stop landed despite the timeout). ' +
      'Every response carries outcome: "state_reached" (the recipe reports stopped) or "accepted" ' +
      '(Workato took the request and the end state is NOT verified). Treat "accepted" as unverified, ' +
      'not as done. ' +
      'NOTE: to edit a running recipe, prefer workato_ui_save_recipe_code(restart_if_running:true) over a manual stop→save→start. ' +
      'Requires an open Workato tab (*.workato.com or *.workato.is) using the same session as the recipe account.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Numeric Workato recipe id. Found in the recipe URL: app.workato.com/recipes/<recipe_id>-<slug>.',
        },
        force: {
          type: 'boolean',
          description:
            'When true, sends {"force":true} to stop even if Workato reports active dependent recipes.',
        },
        wait: {
          type: 'boolean',
          description:
            'Poll workato_recipe_status until running=false (or the wait window expires). Response includes state, running, waited_ms, state_flipped.',
          default: false,
        },
        wait_timeout_ms: {
          type: 'number',
          description: 'Max polling window for wait:true. Default 20000, clamped 1000-60000.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.RECIPE_STATUS,
    description:
      "Cheap read of a recipe's live state: {running, state, version_no, last_run_at, stopped_at, " +
      'stop_reason, stopped_for_error, job_succeeded_count, job_failed_count}. ~4 KB fetch, no code tree. ' +
      'THE post-write verification tool: call after start/stop/save to confirm the change took effect, ' +
      'instead of re-running search_recipes or pulling the recipe. Also returns activation ' +
      '{state, error_message?, config_errors?}: the last activation attempt as Workato recorded it, ' +
      'which is the only place a refused start says why (no error there means no failed attempt on ' +
      'record, NOT that the recipe can start). Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description: 'Numeric Workato recipe id.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.ADAPTER_META,
    description:
      "Look up a connector's REAL config surface from /integrations/meta, the endpoint the " +
      'recipe editor itself calls. THE answer to "what is this field actually called?". ' +
      'Workato silently DROPS input keys it does not recognise, so a guessed key name saves ' +
      'cleanly and then does nothing; one call here replaces the guess/save/pull/check loop. ' +
      'Returns, per trigger and action: input[] and output[] field lists (name, type, ' +
      'control_type, label, optional, extends_schema), help text, and the behaviour flags ' +
      'extends_input_schema / extends_output_schema / depends_on / deprecated / batch / realtime. ' +
      'Each field also carries what decides whether a written step WORKS: `options` for a static ' +
      'select (the VALUE to write, not the label the UI shows; Workato takes a wrong value ' +
      'silently), `default`, `properties` for the item fields of an object/array, and ' +
      '`toggle_field` for the alternative form of a field that accepts either shape. ' +
      'Per adapter it returns title / aliases / categories, which confirm a GUESSED name is the ' +
      'right app, and connection_required, where false means the connector needs no connection at all ' +
      '(Email by Workato, logger, py_eval) and its step carries no account_id. ' +
      'Resolves any standard adapter whether or not this workspace has a connection to it; the ' +
      'array form reports unknown names under not_found. To find an adapter, use ' +
      'workato_apps_list; for how a connector is used here, workato_recipe_step_search. ' +
      '`depends_on` says a step takes its schema from another step (return_result from the ' +
      "recipe-function trigger's result_schema_json). " +
      'PAYLOAD: a bare call returns only the operation INDEX (names, titles, title_hint, ' +
      'aliases, field counts), deprecated operations hidden as the editor hides them ' +
      '(deprecated_hidden counts them; include_deprecated lists them); pass operation for one ' +
      'operation in full, or field_grep to find fields by name/label across all of them. When ' +
      'an operation has extends_input_schema / extends_output_schema, its real schema comes ' +
      'from workato_step_schema. Read-only. Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description:
            'Adapter name or names, e.g. "workato_recipe_function", "salesforce", ' +
            '["workato_recipe_function","workato_workflow_task"]. A custom connector uses its ' +
            'generated name (e.g. "netsuite_rest_connector_5105163_1745592003"): read it off ' +
            "a recipe step's `provider` field, or find it with workato_apps_list.",
        },
        include_deprecated: {
          type: 'boolean',
          description:
            'Index mode: list operations Workato marks deprecated too. Default false. Detail ' +
            'and grep modes always answer for the name or field asked.',
        },
        operation: {
          type: 'string',
          description:
            'Trigger or action name (e.g. "execute", "call_recipe", "return_result"). Returns ' +
            'that operation with full input/output field lists.',
        },
        field_grep: {
          type: 'string',
          description:
            'Substring, or /regex/, matched case-insensitively against field name and label. ' +
            'Returns every operation with a matching field, carrying only the matches. ' +
            'e.g. "schema" finds parameters_schema_json and result_schema_json.',
        },
        include_help: {
          type: 'boolean',
          description: "Include each operation's help text. Default true.",
        },
        raw: {
          type: 'boolean',
          description:
            'Return the raw meta document instead of the slim view. Capped at 20k chars; ' +
            'use out_file for the whole thing.',
        },
        out_file: {
          type: 'string',
          description:
            'Absolute path to write the raw meta JSON to. The document never enters the ' +
            'response, so this is the safe way to read a large adapter in full.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 30000, clamped 10000-110000.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['adapter'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.APPS_LIST,
    description:
      'THE FIRST CALL when a recipe needs an app: which connectors exist and what each is ' +
      "called technically (step.provider). Reads Workato's complete standard-connector " +
      'catalogue (338 adapters, from the app config every page preloads) plus this ' +
      "workspace's connections, SDK connectors, adapters used in recipes and, with a query, " +
      'the certified community catalogue. Each app carries source: "connection" (usable now, ' +
      'with connection ids and status), "recipes" (live examples for ' +
      'workato_recipe_step_search), "builtin" (Workato\'s own tools), "custom" (this ' +
      'workspace\'s SDK connector), "standard" (in the catalogue, no connection here), ' +
      '"certified" (not installed). Also title, aliases, categories, connection_required, ' +
      'actions_count, triggers_count. Usable apps sort first; deprecated connectors are hidden ' +
      'unless in use here or include_deprecated. A bare call returns a SUMMARY (connected, ' +
      'custom, category counts), not 338 rows: narrow with query (name, title, alias or ' +
      'category substring: "sheet", "python", "CRM") or category. ' +
      'NO CONNECTION MEANS STOP AND ASK THE USER: these tools cannot create one, and a step ' +
      'needs its provider account_id in the recipe config. An app with connection_required ' +
      'true and no "connection" source, or one whose status is not "success", is a blocker to ' +
      'raise before writing the step; "success" alone does not prove the connection works ' +
      '(workato_step_schema with input {} is the probe). Workato tools with ' +
      'connection_required false (email, logger, py_eval, clock) need nothing. ' +
      "WORKATO'S OWN TOOLS ARE NAMED NOTHING LIKE THEY ARE CALLED: HTTP is `rest`, Event " +
      'Streams is `workato_pub_sub`, Scheduler is `clock`, Python is `py_eval`; search by what ' +
      'it is called and read the name. An app in neither catalogue is NOT available as a ' +
      'connector: say so and offer `rest` or an SDK connector rather than guess a name ' +
      '(workato_adapter_meta takes an array and reports misses under not_found). ' +
      'Read-only. Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Case-insensitive substring matched against adapter name, title, aliases and ' +
            'categories, e.g. "sales", "sheet", "python", "CRM".',
        },
        category: {
          type: 'string',
          description:
            'Case-insensitive exact category, e.g. "CRM", "Database", "Recipe Tools". The bare ' +
            'call lists every category with counts.',
        },
        include_deprecated: {
          type: 'boolean',
          description:
            'List connectors Workato marks deprecated too. Default false; one this workspace ' +
            'connected or built with is always listed.',
        },
        only_connected: {
          type: 'boolean',
          description: 'Only apps with a connection in this workspace, as a plain list.',
        },
        include_certified: {
          type: 'boolean',
          description:
            "Search Workato's certified community catalogue too (~70 KB raw). Defaults to " +
            'true when query or category is set, false otherwise.',
        },
        limit: {
          type: 'number',
          description:
            'Max apps returned. Default 50 when query, category or only_connected is set, 200 ' +
            'otherwise, clamped 1-1000.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 30000, clamped 10000-110000.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.PICK_LIST,
    description:
      'Resolve a DYNAMIC pick list against a real connection: the customer own Salesforce ' +
      'objects, NetSuite record types, Slack channels. workato_adapter_meta returns a static ' +
      'select values inline; when a field pick_list is a STRING instead, the values are not in ' +
      'the meta document at all, because they are per-connection data. This is the call that ' +
      'turns "the agent knows the field" into "the agent can fill the field". ' +
      'Pass adapter + operation + field name and the field definition is looked up for you ' +
      '(nested properties and toggle_field included), or pass a raw field definition object. ' +
      'A field whose pick_list is already a static array is answered without a network call. ' +
      'Returns {value, label} pairs: Workato stores them label-FIRST, and `value` is the ' +
      'string that goes into step.input. A list can run to thousands of entries, so narrow ' +
      'with query and limit. ' +
      'WRITING THE RESULT: a step field fed by a dynamic pick list carries its choice TWICE, ' +
      'in `input` and in `dynamicPickListSelection` under the same field name. Setting only ' +
      '`input` saves cleanly and leaves the editor showing an empty picker. ' +
      'Read-only. Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: {
          type: 'number',
          description:
            'Numeric Workato connection id the list is resolved against. A dynamic pick list is ' +
            "the customer's own data, so it exists only per connection. Find one with " +
            'workato_apps_list or workato_search_connections.',
        },
        adapter: {
          type: 'string',
          description: 'Adapter name, e.g. "salesforce". Required when field is a name.',
        },
        operation: {
          type: 'string',
          description:
            'Trigger or action name that owns the field, e.g. "search_sobjects". Required when ' +
            'field is a name.',
        },
        field: {
          oneOf: [{ type: 'string' }, { type: 'object' }],
          description:
            'Field name (e.g. "sobject_name"), or the raw field definition object from ' +
            'workato_adapter_meta for a field it did not surface by name.',
        },
        pick_list_params: {
          type: 'object',
          description:
            'Values a parameterised list depends on, EVALUATED: {"sobject_name": "Account", ' +
            '"field_name": "Rating"}. The field names the params it needs in its own ' +
            'pick_list_params, but shows them as FORMULAS (the value appears wrapped in quotes), ' +
            'and sending that form verbatim fails with a bad-URI error. Quotes copied by mistake ' +
            'are stripped and reported. Omit for an unparameterised list.',
        },
        flow_id: {
          type: 'number',
          description: 'Recipe id, sent as flow_id. Optional; most lists resolve without it.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive substring filter over label and value.',
        },
        limit: {
          type: 'number',
          description: 'Max options returned. Default 100, clamped 1-2000.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 45000, clamped 10000-110000.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['connection_id', 'field'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.STEP_SCHEMA,
    description:
      "Generate a step's extended_input_schema and extended_output_schema from the adapter, " +
      'the way the recipe editor does (POST extended_schema.json), instead of writing them by ' +
      'hand. Workato saves a step without them with code_errors [] and then silently DROPS ' +
      'structured input on readback (declare_list list_items, call_recipe parameters, clock ' +
      'trigger_every) or fails a downstream datapill with "Unknown data field"; this call ' +
      'returns the exact arrays the step needs. Pass adapter + operation + the input as it ' +
      'would be saved. connection_id is required when the adapter needs a connection ' +
      '(workato_apps_list says); Workato tools such as workato_variable, clock, logger need ' +
      'none. Fields whose value drives the schema (schema_drivers, e.g. sobject_name, ' +
      'list_item_schema_json) must be in input, else both arrays come back empty and note says ' +
      'which are missing. dynamicPickListSelection is derived from input for pick-list fields. ' +
      'Returns input_schema, output_schema, counts, and apply_ops ready for ' +
      'workato_recipe_apply; or pass apply_to {recipe_id, step} to WRITE both schemas onto the ' +
      'step in one saved version (that path saves a recipe version). An error naming "HTTP ' +
      'status code 4xx" or invalid_grant means the CONNECTION failed the call even if its ' +
      'authorization_status reads success; with input {} this is the cheap liveness probe for ' +
      'a connection. Read-only without apply_to. Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: {
          type: 'string',
          description:
            'Technical adapter name, e.g. "salesforce", "workato_variable", or a custom ' +
            'connector generated name. Find it with workato_apps_list(query).',
        },
        operation: {
          type: 'string',
          description:
            'Trigger or action name, e.g. "search_sobjects", "declare_list". ' +
            'workato_adapter_meta lists them.',
        },
        connection_id: {
          type: 'number',
          description:
            'Numeric connection id. Required when the adapter needs a connection; omitted for ' +
            'Workato tools (the adapter name is used instead).',
        },
        input: {
          type: 'object',
          description:
            'The step input as it would be saved, e.g. {"sobject_name":"Account"} or ' +
            '{"name":"orders","list_item_schema_json":"[...]"}. Default {}.',
        },
        dynamic_pick_list_selection: {
          type: 'object',
          description:
            'Explicit dynamicPickListSelection. Omit to derive it from input for every field ' +
            'that has a dynamic pick list.',
        },
        flow_id: { type: 'number', description: 'Recipe id, forwarded as flow_id. Optional.' },
        only: {
          type: 'array',
          items: { type: 'string', enum: ['input', 'output'] },
          description: 'Which schemas to compute. Default both.',
        },
        apply_to: {
          type: 'object',
          description:
            'Write the generated schemas onto a step: {recipe_id, step (number, as anchor or ' +
            'uuid), comment?, expected_base_version_no?, dry_run?, verify_readback?, ' +
            'restart_if_running?, ensure_running?}. Both non-empty arrays land in ONE version; ' +
            'an empty array is never written. Omit to only generate.',
          properties: {
            recipe_id: { type: 'number' },
            step: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            comment: { type: 'string' },
            expected_base_version_no: { type: 'number' },
            dry_run: { type: 'boolean' },
            verify_readback: { type: 'boolean' },
            restart_if_running: { type: 'boolean' },
            ensure_running: { type: 'boolean' },
          },
          required: ['recipe_id', 'step'],
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 45000, clamped 10000-110000.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['adapter', 'operation'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.RECIPE_STEP_SEARCH,
    description:
      'Find how a connector is ACTUALLY used in this workspace: returns real steps from real ' +
      'recipes as templates. workato_adapter_meta says what a field is called and what it ' +
      'accepts; it cannot say what a working value looks like: which datapill shape the team ' +
      'uses, which optional fields they always set, how they format an internal id. That only ' +
      'exists in the recipes already running here. ' +
      'Scans the recipe list (every item already carries trigger_application and ' +
      'action_applications, so candidates are found without opening them), reads the code of the ' +
      'matches, and walks the tree at any depth so steps nested inside if / repeat_each / try ' +
      'blocks are found too. Scope it with folder_ids (exact folder membership via the ' +
      "dependency-graph listing, because Workato's recipe list ignores folder_id) or skip the " +
      'listing with recipe_ids; input_query keeps only steps whose serialized input ' +
      'matches. Returns per hit: recipe_id, recipe_name, step_number, keyword, name, `as` anchor, ' +
      'description and the `input` block, or input_preview + input_chars past preview_chars. ' +
      'Connection secrets are stripped. `coverage` says whether the scan finished: a failed page, ' +
      'max_pages, max_recipes or a filled limit each leave it incomplete. ' +
      'The returned input is a TEMPLATE, not a value to copy blindly: its datapills are bound to ' +
      "that recipe's own steps and must be repointed. Zero results is a normal answer meaning " +
      'this connector was never used here, not an error. Read-only. Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description:
            'Adapter name to look for, matched against step.provider, e.g. "salesforce", ' +
            '"email", "netsuite_rest_connector_5105163_1745592003". Find it with ' +
            'workato_apps_list.',
        },
        action: {
          type: 'string',
          description:
            'Optional action or trigger name matched exactly (case-insensitive) against ' +
            'step.name, e.g. "send_mail". Omit to see every step for this provider, which is ' +
            'also how you learn which of its operations are used here at all.',
        },
        folder_ids: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Folders to scan, each non-recursive. Exact folder membership via the ' +
            "dependency-graph listing; Workato's recipe list endpoint ignores folder_id. Omit to " +
            'scan the workspace list. Cannot be combined with recipe_ids.',
        },
        recipe_ids: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Read exactly these recipes and skip the list scan entirely. At most 25. Use it when ' +
            'the candidates are already known, e.g. from workato_search_recipes.',
        },
        input_query: {
          type: 'string',
          description:
            "Keep only steps whose serialized input matches, e.g. 'internalId' or a datapill " +
            'path. Matched against the input AFTER secrets are stripped.',
        },
        input_match: {
          type: 'string',
          enum: ['substring', 'regex'],
          description: "How input_query is compared. Default 'substring' (case-insensitive).",
          default: 'substring',
        },
        preview_chars: {
          type: 'number',
          description:
            'Serialized input longer than this comes back as input_preview + input_truncated + ' +
            'input_chars instead of the whole block. Default 2000; 0 returns it unbounded.',
          default: 2000,
        },
        limit: {
          type: 'number',
          description: 'Max matching steps returned. Default 5, clamped 1-25.',
        },
        max_recipes: {
          type: 'number',
          description: 'Max recipes whose code is read. Default 8, clamped 1-25.',
        },
        max_pages: {
          type: 'number',
          description:
            'Pages of the recipe list to scan per scope, 20 recipes per page. Default 5, clamped ' +
            '1-25. Raise it for a workspace with more recipes than that.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 45000, clamped 10000-110000.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['provider'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.RECIPE_CALLERS,
    description:
      'Who calls this recipe. Use it before stopping, saving or deleting a callable, and to ' +
      'answer "what breaks if I change this". Three evidence sources, labelled per caller: ' +
      "'graph' is Workato's own dependency graph (one request, workspace-wide, the Flow->Flow " +
      "edges behind the Operations hub dependency page); 'code' reads candidate recipes and " +
      'matches call_recipe / call_recipe_async input.flow_id, the only source that names the ' +
      'calling STEP and the only one that can report a call whose flow_id is built at runtime; ' +
      "'jobs' reads calling_recipe_id off recent jobs of this recipe, which is observed " +
      'EXECUTION HISTORY, never a complete dependency list. Default sources: graph + code. ' +
      "The code scan covers the recipe's own folder unless folder_ids, project_id or " +
      "scope:'workspace' is given, and walks every page of the candidate list. A folder scope " +
      "is exact: membership comes from Workato's dependency-graph listing, because the recipe " +
      'list endpoint ignores folder_id. ' +
      'Returns callers[] (recipe_id, name, running, folder_id, step, sources, observed_at), ' +
      'callees, connections, lookup_tables, lcap_pages, unresolved_dynamic_targets, ' +
      "failed_reads, scope, freshness and completeness 'complete' | 'partial' with reasons. " +
      "Take 'partial' literally: it means other callers may exist and the list must not be " +
      'described as exhaustive. Repeated calls reuse a version-aware index and re-read only ' +
      'the recipes whose updated_at changed. Read-only. Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'The recipe whose callers you want.' },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['graph', 'code', 'jobs'] },
          description:
            'Evidence sources to combine. Default ["graph","code"]. Add "jobs" for observed ' +
            'execution history, which is supplementary, not proof of the full caller set.',
        },
        folder_ids: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Folders the code scan reads (non-recursive per folder, so list subfolders too). ' +
            'From workato_list_folders. Implies scope "folders". Exact folder membership via the ' +
            "dependency-graph listing; Workato's recipe list endpoint ignores folder_id.",
        },
        project_id: {
          type: 'string',
          description:
            'Project id, project name or project root folder id. With scope "project" every ' +
            'folder under that root is scanned.',
        },
        scope: {
          type: 'string',
          enum: ['folders', 'project', 'workspace'],
          description:
            'Code scan scope. Omit to scan the recipe\'s own folder (or "folders" when ' +
            'folder_ids is given). "workspace" walks the whole recipe list and costs the most.',
        },
        max_recipes: {
          type: 'number',
          description: 'Cap on candidate recipes listed. Default 200, clamped 1-2000.',
        },
        max_pages: {
          type: 'number',
          description:
            'Cap on listing pages per scanned folder, 20 recipes per page. Default 25, ' +
            'clamped 1-200. Hitting the cap makes the answer partial.',
        },
        include_transitive: {
          type: 'boolean',
          description:
            'Also return the caller edges this scan saw, the indirect callers with their hop ' +
            'depth, and any call cycle. Default false.',
        },
        include_callees: {
          type: 'boolean',
          description: 'Return what this recipe itself calls. Default true.',
        },
        refresh: {
          type: 'boolean',
          description:
            'Ignore the cached index and re-read every candidate. Use after edits made outside ' +
            'this session. Default false.',
        },
        jobs_limit: {
          type: 'number',
          description: 'Recent jobs read when "jobs" is a source. Default 50, clamped 1-100.',
        },
        timeout_ms: {
          type: 'number',
          description:
            'Overall in-page budget across the graph, listing, code and job reads. Default ' +
            '60000, clamped 10000-110000. Running out is reported, never hidden.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.SAVE_WITH_DEPENDENTS,
    description:
      'Save a CALLABLE recipe (recipe function) and handle its callers around the save. ' +
      'Workato refuses to stop a callable while a recipe that calls it is running ' +
      '(active_dependent_recipes_count), and refuses a code save on a running recipe, so every ' +
      'edit to a shared callable is stop-caller-A, stop-caller-B, save, start-A, start-B. This ' +
      'does that in one call and RESTORES each dependent to the state it was in, so a caller that ' +
      'was already stopped stays stopped. ' +
      'DEPENDENT DISCOVERY: pass dependent_recipe_ids (the callers you already know), or a scan ' +
      'scope (scan_folder_id, scan_folder_ids, scan_project_id or scan_scope:"workspace"), ' +
      'which runs workato_recipe_callers (dependency graph plus a paged code scan) and uses its ' +
      'result. With neither, the call is REFUSED rather than saving as if there were no ' +
      'dependents. A discovery that comes back partial is reported as a warning, not hidden. If ' +
      'the save fails because more dependents are active than were listed, everything this call ' +
      'stopped is restarted and the mismatch is reported. ' +
      'DURABLE: every response carries an operation_id; a client timeout does not lose the ' +
      'operation. Read it with workato_operation_status, finish it with resume:true. A save that ' +
      'persisted an INVALID or INCOMPLETE version is reported with its version and never has ' +
      'callers restarted against it. Connections are checked before anything is stopped. ' +
      'For a callable with no callers, use workato_ui_save_recipe_code instead.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'The callable recipe to save.' },
        code: {
          type: 'object',
          description: 'Full recipe code tree. Use code_path for anything large.',
        },
        code_path: {
          type: 'string',
          description:
            'Absolute path to a recipe JSON file (as written by workato_pull_recipe out_file). ' +
            'Read in the bridge, so the tree never crosses the context.',
        },
        config: {
          type: 'array',
          description: "Recipe connection config. Defaults to the recipe's own.",
        },
        dependent_recipe_ids: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Recipe ids that call this one. The fast, exact path: used verbatim, no discovery.',
        },
        scan_folder_id: {
          type: 'number',
          description:
            'Instead of a list: discover the callers in this folder with workato_recipe_callers ' +
            '(dependency graph plus a paged code scan) and use them as the dependents. Exact ' +
            "folder membership via the dependency-graph listing; Workato's recipe list endpoint " +
            'ignores folder_id.',
        },
        scan_folder_ids: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Several folders to discover callers in. Same discovery as scan_folder_id, same exact ' +
            'folder membership.',
        },
        scan_project_id: {
          type: 'string',
          description:
            'Discover callers across every folder of this project (project id, name or root ' +
            'folder id).',
        },
        scan_scope: {
          type: 'string',
          enum: ['folders', 'project', 'workspace'],
          description:
            'Discovery scope passed to workato_recipe_callers. Use "workspace" when the callers ' +
            "may live outside the callee's project; it costs a full recipe-list walk.",
        },
        expected_base_version_no: {
          type: 'number',
          description:
            'Optimistic lock: refuse if the recipe moved past this version since you pulled it. ' +
            "Defaults to the callee's current version, read before anything is stopped, so a " +
            'retry after a timeout cannot create a second version.',
        },
        preflight_connections: {
          type: 'boolean',
          description:
            'Check connection health (workato_recipe_connections) for the callee and every ' +
            'running caller BEFORE stopping anything. Default true. A callee whose connections ' +
            'are broken is still saved so it stays editable, but it is not restarted and its ' +
            'callers are not restarted against it, with exact ids and reasons in the response.',
        },
        async: {
          type: 'boolean',
          description:
            'Return {operation_id, phase} immediately and keep running in the bridge. Poll with ' +
            'workato_operation_status(operation_id). Default false (the call waits, and its ' +
            'response still carries operation_id).',
        },
        ensure_running: {
          type: 'boolean',
          description: 'Start the callee after the save even if it was stopped beforehand.',
        },
        comment: {
          type: 'string',
          description:
            'Version comment. CLIENT-VISIBLE in the recipe version history (these recipes get ' +
            'promoted to the client production environment), so keep it neutral and boring: ' +
            '"schema refresh", "config update". Never a narrative of what was changed or of ' +
            'what an agent did. Defaults to "schema refresh".',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.OPERATION_STATUS,
    description:
      'Read back a journalled multi-recipe operation, and finish one that was interrupted. ' +
      'workato_recipe_save_with_dependents stops several recipes, saves one and puts the others ' +
      'back; every response carries an operation_id and the bridge writes each phase to disk ' +
      'BEFORE the call it describes, so a client timeout or a bridge restart cannot lose which ' +
      'production recipes are sitting stopped. ' +
      'Pass operation_id for the full record (context, affected recipes with the state and ' +
      'version they had BEFORE the operation, phases with timestamps, the save outcome, and the ' +
      'reasons anything was left stopped). Pass list:true for the most recent operations. ' +
      'refresh:true adds one live workato_recipe_status per affected recipe plus a drift list. ' +
      'resume:true finishes the restore: it re-reads every recipe, restarts ONLY the ones that ' +
      'were running before and only when the saved version is usable and the connections are ' +
      'healthy, leaves previously stopped recipes stopped, reuses the journalled version lock so ' +
      'a retried save answers already_applied instead of creating a duplicate version, and lists ' +
      'exact ids and reasons for anything it will not do. It never rolls back over a version ' +
      'somebody else saved. Journals are kept 7 days or 200 records, in the bridge that ran them.',
    inputSchema: {
      type: 'object',
      properties: {
        operation_id: {
          type: 'string',
          description: 'The operation to read, from a save_with_dependents response.',
        },
        list: {
          type: 'boolean',
          description: 'List the most recent operations instead of reading one.',
        },
        limit: {
          type: 'number',
          description: 'How many operations to list. Default 10, max 50.',
        },
        refresh: {
          type: 'boolean',
          description:
            'Read the live state of every affected recipe (one workato_recipe_status each) and ' +
            'report how it drifted from the journal.',
        },
        resume: {
          type: 'boolean',
          description:
            'Finish an interrupted operation. WRITES: it can start recipes and, when the save ' +
            'outcome is unknown and the code came from code_path, re-issue the save under the ' +
            'journalled lock.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID for refresh/resume. Omit to use the session pinned tab.',
        },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.CALLABLE_SCHEMA_SET,
    description:
      "Declare a callable recipe's parameter and result schemas as one coherent unit. " +
      "A recipe function's contract lives in FOUR places that must agree and nothing checks " +
      "that they do: the trigger's parameters_schema_json, the trigger's result_schema_json, " +
      "the trigger's extended_output_schema (the `parameters` wrapper), and the return_result " +
      "step's extended_input_schema + input {result:{...}} + visible_config_fields. " +
      'MISSING result_schema_json IS SILENT AND TOTAL: the callee saves cleanly, its job ' +
      "succeeds, its trace shows the full payload, and the caller's call_recipe output is " +
      '{job_id, job_url, result: null} with every downstream pill resolving empty. This tool ' +
      'writes all four together. Existing datapill mappings under input.result are preserved, ' +
      'and values sitting flat on input (the pre-fix shape that CAUSES result:null) are migrated ' +
      'under the result wrapper instead of being dropped. Pulls, mutates and saves in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description: 'The CALLABLE recipe (trigger provider workato_recipe_function).',
        },
        parameters: {
          type: 'array',
          description:
            'Input fields the callable accepts. Each {name, type, control_type?, label?, ' +
            'optional?, properties?}. Only `name` is required; the rest are filled in the way ' +
            'the schema designer would. At runtime these arrive under `parameters`: the ' +
            'trigger pill path is ["parameters","<Name>"].',
          items: { type: 'object' },
        },
        results: {
          type: 'array',
          description:
            'Fields the callable returns. Same entry shape; nested arrays take of:"object" plus ' +
            'properties[]. These must be WRITTEN under a `result` wrapper, which this tool does.',
          items: { type: 'object' },
        },
        expected_base_version_no: {
          type: 'number',
          description: 'Optimistic lock against the version you pulled.',
        },
        restart_if_running: {
          type: 'boolean',
          description:
            'Stop, save, restart when the recipe is running. Does NOT stop dependent callers; ' +
            'use workato_recipe_save_with_dependents when the callable has running callers.',
        },
        ensure_running: { type: 'boolean', description: 'Start the recipe after saving.' },
        comment: {
          type: 'string',
          description:
            'Version comment. CLIENT-VISIBLE in the recipe version history: keep it neutral ' +
            '("schema refresh", "schema update"), never a description of the work done. ' +
            'Defaults to "schema refresh".',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.CALLER_BIND,
    description:
      'Teach a call_recipe step what its callee returns, and repoint the pills written against ' +
      "the old shape. Reads the CALLEE's own trigger for the contract (nothing is guessed), then " +
      "writes the caller step's extended_output_schema (job_id, job_url, and the callee's " +
      '`result` object node) plus its extended_input_schema (the `parameters` node), and rewrites ' +
      'every datapill in the caller that reads a result field straight off that step so its path ' +
      'starts with "result". Run workato_callable_schema_set on the callee FIRST: a callee with ' +
      'no result_schema_json is refused here, because binding to it would produce result:null.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description: 'The CALLER recipe (the one with the call_recipe step).',
        },
        callee_recipe_id: {
          type: 'number',
          description:
            'The callable being called. Optional when the caller has exactly one call_recipe ' +
            "step: it is read from that step's flow_id.",
        },
        step: {
          type: 'string',
          description:
            'Which call_recipe step, by `as` id or step number. Needed only when several match.',
        },
        expected_base_version_no: { type: 'number', description: 'Optimistic lock.' },
        restart_if_running: { type: 'boolean', description: 'Stop, save, restart when running.' },
        ensure_running: { type: 'boolean', description: 'Start the recipe after saving.' },
        comment: {
          type: 'string',
          description:
            'Version comment. CLIENT-VISIBLE: keep it neutral ("schema refresh"). Defaults to ' +
            '"schema refresh".',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.DATAPILL,
    description:
      'Build a datapill reference string exactly, instead of assembling one by hand. Workato ' +
      "matches the _dp('<json>') literal BYTE-FOR-BYTE: one inserted space, or a line wrap, " +
      'and the pill saves fine and then silently resolves to nothing. THREE dialects: recipe ' +
      'step output ({pill_type, provider, line, path}), Workflow App widget ({source:"widget", ' +
      'id, path}), and Workflow App page variable ({source:"page-variable", id, path}), plus ' +
      'two modes: "interpolated" (#{_dp(...)}, for a normal string field) and ' +
      '"formula" (bare _dp(...), valid only inside a value whose first character is "="). ' +
      'Path shorthand: "rows[]" is the element under iteration (current_item), "rows#size" is the ' +
      'collection length. Pure string assembly: no browser, no Workato call.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['recipe', 'widget', 'variable'],
          description:
            'Which dialect. Inferred from widget_id / variable_id when given, "recipe" otherwise.',
        },
        mode: {
          type: 'string',
          enum: ['interpolated', 'formula'],
          description:
            '"interpolated" (default) wraps as #{_dp(...)} for a plain string field. "formula" ' +
            'emits a bare _dp(...) for use inside a leading-"=" expression.',
        },
        shorthand: {
          type: 'string',
          description:
            'Recipe dialect in one token: "provider.line.path.parts", e.g. ' +
            '"salesforce.9ad56b78.records[].Id" or "py_eval.84767f5e.output.rows#size".',
        },
        provider: {
          type: 'string',
          description: 'Recipe dialect: the step adapter, e.g. "salesforce", "py_eval".',
        },
        line: {
          type: 'string',
          description: 'Recipe dialect: the target step `as` id (8 hex chars), NOT its number.',
        },
        pill_type: {
          type: 'string',
          description: 'Recipe dialect. Default "output". "job_context" takes no provider/line.',
        },
        widget_id: {
          type: 'string',
          description:
            'Widget dialect: the widget 8-hex id read from the page content. Never invent one.',
        },
        variable_id: {
          type: 'string',
          description:
            'Page-variable dialect: the variable 8-hex id from the page content. Emits ' +
            'source:"page-variable", the shape the builder itself writes when a page variable ' +
            'is dropped into a field.',
        },
        path: {
          oneOf: [{ type: 'string' }, { type: 'array' }],
          description:
            'Dotted string or array. Widget and page-variable pills default to ["value"]. Array ' +
            'entries may be literal {"path_element_type":"current_item"} / ' +
            '{"path_element_type":"size"} objects.',
        },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.VERSION_DIFF,
    description:
      'Compare two saved versions of a recipe and return ONLY the changed steps (compact). ' +
      'Fetches both code trees via /recipes/<id>/code.json?version_no=N, diffs them in the ' +
      'background, and returns {summary, added, removed, changed} where each changed step lists ' +
      'field-level changes as {path, from, to} excerpts. Steps that merely got renumbered by an ' +
      'insertion above them are counted in summary.moved but not listed. Use for "what did I just ' +
      'change" verification (from=base, to=new version_no returned by save) and for version ' +
      'archaeology ("what changed between v46 and v47"). Read-only. Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description: 'Numeric Workato recipe id.',
        },
        from: {
          type: 'number',
          description: 'Older version_no (as shown in the Versions tab).',
        },
        to: {
          type: 'number',
          description: 'Newer version_no to compare against.',
        },
        value_excerpt_chars: {
          type: 'number',
          description:
            'Max characters per old/new value excerpt in field changes. Default 200, clamped 40-2000.',
        },
        timeout_ms: {
          type: 'number',
          description:
            'In-page fetch timeout in milliseconds (two full code trees are fetched). ' +
            'Default 40000, clamped 10000-110000.',
          minimum: 10000,
          maximum: 110000,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id', 'from', 'to'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.LIST_FOLDERS,
    description:
      'List the full Workato project/folder tree (GET /folders?projects_mode=true). ' +
      'Top-level entries are project root folders: their `id` is the folder id to use as ' +
      'parent_id (create/move folder) or folder_id (move recipe), and `project_id` is the owning ' +
      "project's id. Each node reports flow_count/active_flow_count (recipes) plus non-zero asset " +
      'counts under `counts`, and nested `children`. Slim by default; totals holds account-wide ' +
      'asset counters. THE tool to call before creating/moving folders or recipes: it is the ' +
      'source of folder ids. Returns {project_count, projects}. Read-only. Requires an open ' +
      'Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'Optional filter: return only the project whose name (case-insensitive) or project_id ' +
            'matches. Errors with the list of available projects when nothing matches.',
        },
        full: {
          type: 'boolean',
          description: 'Return the raw untrimmed API response instead of the slim tree.',
          default: false,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.CREATE_FOLDER,
    description:
      'Create a folder by POSTing /folders with {name, parent_id}. parent_id is a folder id from ' +
      "workato_list_folders: use a project's root folder id to create at the top of a project, " +
      'or another folder id to nest. Returns the new folder_id (use it as parent_id/folder_id in ' +
      'later calls). If the request times out, the tool re-reads the folder tree to check whether ' +
      'the folder actually got created before reporting failure (succeeded_after_timeout:true). ' +
      'Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new folder.',
        },
        parent_id: {
          type: 'number',
          description:
            'Parent folder id (from workato_list_folders). Project root folders work here.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['name', 'parent_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.UPDATE_FOLDER,
    description:
      'Rename and/or move a folder by PUTting /folders/<id> with {name?, parent_id?}. ' +
      'Pass name to rename, parent_id to move it under another folder (must be in the same ' +
      'project tree), or both. At least one is required; omitted fields are left unchanged. ' +
      'If the request times out, the tool re-reads the folder tree to verify the change landed ' +
      'before reporting failure (succeeded_after_timeout:true). Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: {
          type: 'number',
          description: 'Folder id to update (from workato_list_folders).',
        },
        name: {
          type: 'string',
          description: 'New folder name. Omit to keep the current name.',
        },
        parent_id: {
          type: 'number',
          description: 'New parent folder id to move the folder under. Omit to keep it in place.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['folder_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.DELETE_FOLDER,
    description:
      'Delete a folder by DELETEing /folders/<id>. DANGER: Workato CASCADES this delete: a ' +
      'non-empty folder is deleted together with everything inside it (recipes, subfolders, ' +
      'connections...), verified live. This tool therefore pre-checks the folder tree and refuses ' +
      'when the folder is not empty unless force:true; it also refuses project root folders ' +
      'outright. Only pass force:true when the user explicitly confirmed cascading deletion. ' +
      'Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: {
          type: 'number',
          description: 'Folder id to delete (from workato_list_folders).',
        },
        force: {
          type: 'boolean',
          description:
            'Delete even when the folder is not empty, CASCADES to all contents. Requires ' +
            'explicit user confirmation.',
          default: false,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['folder_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.PROPERTIES,
    description:
      'Read and write Workato properties: the named configuration values recipes resolve at job ' +
      'start (Recipe data > Properties). One controller, /account_properties.json. ' +
      'action "list" (default) is read-only; action "set" (upsert by name: PUT when the name ' +
      'exists, POST when it does not) and action "delete" WRITE workspace configuration that ' +
      'running recipes read at job start, so the next job picks the change up. ' +
      'scope "account" is the whole environment; scope "project" needs project_id, which is the ' +
      'PROJECT id (the `project_id` field on a project root in workato_list_folders), NOT the ' +
      'folder `id`. A project property and an account property may share a name and neither ' +
      'shadows the other. Values are stored in the CLEAR on Workato, including the ones it flags ' +
      'sensitive (any name containing password, key or secret); this tool masks a sensitive ' +
      'value to XXXXXXXXXX plus its last 3 characters and sets value_masked, unless you pass ' +
      'reveal:true. Every successful set issues a NEW id and version_no, so ids from an earlier ' +
      'list go stale; set sends last_version_no and reports a mismatch as a version conflict, ' +
      'and expected_version_no makes that check yours. delete takes name (exact, refused when it ' +
      'matches nothing or more than one) or id. Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'set', 'delete'],
          description:
            'What to do: "list" (read, default), "set" (create or update by name), "delete".',
          default: 'list',
        },
        scope: {
          type: 'string',
          enum: ['account', 'project'],
          description:
            'Property scope: "account" (environment-wide, default) or "project" (one project).',
          default: 'account',
        },
        project_id: {
          type: 'number',
          description:
            'Required for scope "project": the PROJECT id, reported as `project_id` on a project ' +
            'root folder by workato_list_folders. A folder id here is refused with HTTP 404.',
        },
        name: {
          type: 'string',
          description:
            'Property name. On "list" it filters client-side (exact match first, else ' +
            'case-insensitive substring). Required on "set". On "delete" it must resolve to one.',
        },
        value: {
          type: 'string',
          description:
            'Required on "set": the new value. An empty string is accepted and stores an empty ' +
            'value. Max 1024 characters.',
        },
        rename_to: {
          type: 'string',
          description:
            'On "set": rename the property found under name to this. Fails when name does not ' +
            'exist yet, since there is nothing to rename.',
        },
        expected_version_no: {
          type: 'string',
          description:
            'On "set": the version_no you expect the property to be at. A mismatch is refused as ' +
            'a version conflict before anything is written. Omit to use the current one.',
        },
        id: {
          type: 'number',
          description:
            'On "delete": the property id, as an alternative to name. Ids change on every update.',
        },
        reveal: {
          type: 'boolean',
          description:
            'Return the real value of a sensitive property instead of the mask. Default false.',
          default: false,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.MOVE_RECIPE,
    description:
      'Move a recipe into another folder by PUTting /recipes/<id>/update_folder.json with ' +
      '{folder_id}. Get the target folder id from workato_list_folders (project root folder ids ' +
      'work, which puts the recipe at the top level of the project). Moving across projects ' +
      'changes which project owns the recipe. If the request times out, the tool re-reads the ' +
      "recipe's folder_id to verify the move landed before reporting failure " +
      '(succeeded_after_timeout:true). Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Numeric Workato recipe id. Found in the recipe URL: app.workato.com/recipes/<recipe_id>-<slug>.',
        },
        folder_id: {
          type: 'number',
          description: 'Destination folder id (from workato_list_folders).',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id', 'folder_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.COPY_RECIPE,
    description:
      'Copy (clone) a recipe by POSTing /recipes/<id>/copy.json with {folder_id}. Returns the ' +
      'new recipe id. The copy is created stopped, with the same code tree as the source; get the ' +
      'destination folder id from workato_list_folders (project root folder ids work, and copying ' +
      'into another project is allowed). If the request times out, the tool re-reads the ' +
      "destination folder's recipe list to check whether the copy landed before reporting failure " +
      '(succeeded_after_timeout:true). Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Numeric Workato recipe id of the source recipe. Found in the recipe URL: ' +
            'app.workato.com/recipes/<recipe_id>-<slug>.',
        },
        folder_id: {
          type: 'number',
          description: 'Destination folder id for the copy (from workato_list_folders).',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id', 'folder_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.DELETE_RECIPE,
    description:
      'Permanently delete a recipe by DELETEing /recipes/<id>.json. There is no undo, so only ' +
      'call this when the user explicitly asked for the deletion. The tool pre-reads the recipe ' +
      'and refuses when it is running (stop it first with workato_stop_recipe). If the request ' +
      'times out, the tool re-reads the recipe to verify it is gone before reporting failure ' +
      '(succeeded_after_timeout:true). Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Numeric Workato recipe id. Found in the recipe URL: app.workato.com/recipes/<recipe_id>-<slug>.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.CREATE_PROJECT,
    description:
      'Create a new Workato project by POSTing /web_api/projects.json with {name}. Returns ' +
      "{project_id, name, folder_id, project_type}, where folder_id is the project's root folder, the " +
      'parent_id to use for workato_create_folder and the folder_id for placing recipes in the ' +
      'new project. If the request times out, the tool re-reads the folder tree to check whether ' +
      'the project got created before reporting failure (succeeded_after_timeout:true). ' +
      'NOTE: there is no delete-project tool, and creating a project is easy to do but manual to ' +
      'undo, so only create when the user asked for it. Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new project.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.UPDATE_PROJECT,
    description:
      'Rename a project and/or change its color/icon by PUTting /web_api/projects/f<folder_id>.json ' +
      "with {name?, color?, icon?}. Takes the project's ROOT FOLDER id (top-level `id` from " +
      'workato_list_folders, or folder_id from workato_create_project), NOT the project_id. ' +
      'Omitted fields keep their current value. If the request times out, the tool re-reads the ' +
      'folder tree to verify the change landed before reporting failure ' +
      '(succeeded_after_timeout:true). Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: {
          type: 'number',
          description:
            "The project's root folder id (top-level `id` in workato_list_folders). Not the project_id.",
        },
        name: {
          type: 'string',
          description: 'New project name. Omit to keep the current name.',
        },
        color: {
          type: 'string',
          description:
            'Project color slug as used by the Workato UI (e.g. "forest", "purple", "gold", ' +
            '"plum", "slate", "neutral"). Omit to keep the current color.',
        },
        icon: {
          type: 'string',
          description: 'Project icon identifier. Omit to keep the current icon.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['folder_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.JOB_TRACE,
    description:
      "Fetch a Workato job's per-step execution trace. Read-only. Returns a slimmed " +
      'shape by default (step list, status, error, truncated input/output; schema noise ' +
      'like output_schema/extended_*_schema is stripped from summaries). ' +
      'recipe.version_no is the version THIS job ran on, not the current one. ' +
      'For long recipes, narrow with lines:[104,118] (exact set) or line_range:[91,123] ' +
      "(inclusive). THE PER-STEP UNTRUNCATED READ IS detail:'full' PLUS lines:[N] (or " +
      'line_range): there is no `step` parameter, and passing one does nothing, so a trace ' +
      'that still looks truncated means the line selection was missing. That pair is the ' +
      'way to answer "what exactly did step 118 receive ' +
      'in this job". Narrow the payload further with paths (nested projection over each step\'s ' +
      "input/output, dot/bracket with [] for every array element), empty:'drop' (removes " +
      "undefined/null/''/{}/[] only: 0 and false always survive, and arrays are never filtered " +
      'so indices stay stable), max_items (long arrays come back as ' +
      '{_array_preview,total,shown,items}, default 20) and fields (keys kept per step). ' +
      'Pass full=true to get raw responses for both the job metadata and ' +
      'line details endpoints, unprojected. Requires an open Workato tab. Both recipe_id and ' +
      'job_id are required: Workato job trace endpoints are recipe-scoped.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description: 'Numeric Workato recipe id the job belongs to.',
        },
        job_id: {
          type: ['string', 'number'],
          description:
            'Workato job id. May be string or number depending on source; both accepted.',
        },
        lines: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Only return steps with these exact recipe_line_number values, e.g. [104, 118].',
        },
        line_range: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Only return steps whose recipe_line_number is within [from, to] inclusive.',
        },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description:
            "'summary' (default): truncated summaries. 'full': exact untruncated input/output " +
            '(schema-stripped) for the selected steps; requires lines/line_range matching ≤20 steps.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Keep only these nested paths inside each step's input and output, e.g. " +
            "['body.items[].id','headers.status','rows[0].amount']. Dots for keys, [N] for one " +
            "index, [] for every element, ['a.b'] for a key containing a dot. Array indices " +
            'are preserved, so a projected element keeps its position. Applied in summary and ' +
            "detail:'full' alike, before truncation.",
        },
        empty: {
          type: 'string',
          enum: ['keep', 'drop'],
          description:
            "Default 'keep'. 'drop' removes undefined, null, '', {} and [] from objects, and " +
            'nothing else: 0 and false are data and always survive. Arrays are mapped, never ' +
            'filtered, so indices never shift; an object that becomes empty is dropped from its ' +
            'parent.',
          default: 'keep',
        },
        max_items: {
          type: 'number',
          description:
            'Preview arrays longer than this as {_array_preview:true, total, shown, items}. ' +
            'Default 20; 0 disables previewing and returns every element.',
          default: 20,
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Keys kept on each returned step. Allowed: recipe_line_number, adapter_name, ' +
            'adapter_operation, input, output, input_summary, output_summary. ' +
            'recipe_line_number is always kept.',
        },
        full: {
          type: 'boolean',
          description: 'If true, return raw responses instead of the slim shape. Default false.',
          default: false,
        },
        timeout_ms: {
          type: 'number',
          description:
            'In-page fetch timeout in milliseconds. Default 30000, clamped 10000-110000. ' +
            'Raise for very large job traces.',
          minimum: 10000,
          maximum: 110000,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id', 'job_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.SEARCH_RECIPES,
    description:
      'Search Workato recipes. `text` is NOT a name substring: Workato runs a FULL-TEXT search ' +
      "over the recipe name, its description AND its trigger/action titles, which is why 'ECO' " +
      "answers with recipes whose steps say 'New/updated records'. In that default mode each hit " +
      'carries `matched` (the highlighted name/description/action, markup removed) so it is ' +
      'visible WHY it came back. For a name-only search pass match: name_substring / name_word / ' +
      'name_exact / name_regex, which walk pages and filter client-side, so bound them with ' +
      'folder_id, app or max_pages. Filters: app (adapter technical name; one name uses the ' +
      "server's adapters= filter, several are ANDed client-side), running (client-side; Workato " +
      'ignores the server param), folder_id (exact folder, not recursive; membership comes from ' +
      'the dependency-graph listing and the filter is client-side, because the list endpoint ' +
      'ignores folder_id). Walks up to max_pages ' +
      '(default 5, max 50) of 20 and returns `coverage` {pages_scanned, recipes_scanned, matched, ' +
      'complete, next_page}: an incomplete scan says so instead of implying nothing else exists. ' +
      '`limit` caps the recipes returned (default 20). full=true returns the raw items. Requires ' +
      'an open Workato tab (*.workato.com or *.workato.is).',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'What to search for. In the default fulltext mode this is matched by Workato over ' +
            'name, description and action/trigger titles. In a name_* mode it is matched ' +
            'client-side against the recipe name only. Omit for all recipes.',
        },
        match: {
          type: 'string',
          enum: ['fulltext', 'name_substring', 'name_word', 'name_exact', 'name_regex'],
          description:
            "Default 'fulltext' (server-side, the only mode that returns `matched` highlights). " +
            'The name_* modes are applied client-side over walked pages and do not send `text` ' +
            'upstream, because the two searches do not agree.',
          default: 'fulltext',
        },
        app: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description:
            "Adapter TECHNICAL name(s), e.g. 'salesforce', 'workato_recipe_function'. One name " +
            'is filtered server-side (adapters=); several are ANDed client-side, meaning the ' +
            'recipe uses all of them as its trigger or an action app. Find names with ' +
            'workato_apps_list.',
        },
        running: {
          type: 'boolean',
          description:
            'Keep only running (true) or only stopped (false) recipes. Client-side: Workato ' +
            'silently ignores running/state parameters on this endpoint.',
        },
        folder_id: {
          type: 'number',
          description:
            'Numeric folder id to scope the search. Exact folder, not recursive. Membership comes ' +
            'from the dependency-graph listing and the filter is applied client-side, because ' +
            "Workato's recipe list endpoint ignores folder_id.",
        },
        page: {
          type: 'number',
          description:
            '1-based page number the walk STARTS at. Default 1. 20 items per page (server-capped).',
          default: 1,
        },
        max_pages: {
          type: 'number',
          description:
            'Pages walked from `page`. Default 5, clamped 1-50. Coverage reports how many were ' +
            'actually read and whether the list ended.',
          default: 5,
        },
        limit: {
          type: 'number',
          description: 'Max recipes returned after filtering. Default 20, clamped 1-100.',
          default: 20,
        },
        sort: {
          type: 'string',
          enum: ['latest_activity', 'name', 'updated_at', 'created_at', 'relevance'],
          description:
            "Sort order. Default latest_activity. 'relevance' is what the assets page uses with " +
            'a text search.',
          default: 'latest_activity',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 45000, clamped 10000-110000.',
        },
        full: {
          type: 'boolean',
          description: 'If true, return the raw Workato response shape instead of the slim shape.',
          default: false,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.SEARCH_CONNECTIONS,
    description:
      'Search Workato connections by name. Same paginated endpoint as ' +
      'workato_search_recipes but filters to connections. Note: text= ' +
      'matches connection NAMES, not the provider field. To find "the ' +
      'salesforce connection" pass provider:"salesforce" instead (the tool ' +
      'walks up to 5 pages and filters client-side). Alternative pattern: ' +
      "read the connection id straight from the recipe's config " +
      '(pull_recipe version.config account_id entries), often the better ' +
      'source when you already have the recipe. Slim response includes ' +
      '`count` for pagination decisions. Pass full=true for the raw 18-key ' +
      'per-item Workato shape. Requires an open Workato tab (*.workato.com ' +
      'or *.workato.is).',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Connection name substring search.',
        },
        provider: {
          type: 'string',
          description:
            'Exact provider/adapter name filter (case-insensitive), e.g. "salesforce", "netsuite". ' +
            'Applied client-side across up to 5 pages; response sets provider_filtered:true and pages_scanned.',
        },
        folder_id: {
          type: 'number',
          description: 'Numeric folder id to scope the search.',
        },
        page: {
          type: 'number',
          description: '1-based page number. Default 1. 20 items per page.',
          default: 1,
        },
        sort: {
          type: 'string',
          enum: ['latest_activity', 'name', 'updated_at'],
          description: 'Sort order. Default latest_activity.',
          default: 'latest_activity',
        },
        full: {
          type: 'boolean',
          description: 'If true, return raw Workato shape instead of slim shape.',
          default: false,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.GET_CONNECTION,
    description:
      'Fetch a single Workato connection by id. Returns metadata ' +
      '(id, name, provider, recipe_count, authorization_status, ' +
      'dates) plus a config object containing per-provider settings ' +
      'with secret-shaped keys/values stripped (auth tokens, passwords, ' +
      'API keys, JWTs, long opaque tokens). The strip applies even with ' +
      'full=true: there is no escape hatch for secrets. Requires an ' +
      'open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: {
          type: 'number',
          description: 'Numeric Workato connection id.',
        },
        full: {
          type: 'boolean',
          description:
            'If true, return the secret-stripped raw response instead of the slim metadata+config shape.',
          default: false,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['connection_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.RECIPE_CONNECTIONS,
    description:
      'Connection health for ONE recipe: which connections its steps are bound to, and ' +
      'whether they can still authenticate. Workato has no per-recipe connection endpoint, ' +
      "so this reads the recipe's config bindings, then each bound connection, then " +
      '/integrations/meta for the providers that carry no account_id. Returns one entry per ' +
      'binding {provider, connection_id, connection_name, authorization_status, authorized_at, ' +
      'connection_lost_at, connection_lost_reason, authorization_error, warning, ' +
      'running_recipe_count, status} where status is ok | lost | missing | not_required | ' +
      'unknown, plus a recipe verdict {healthy, blocking[], actions[]} phrased as what to ask ' +
      'the user for (a lost connection is named by id to re-authorize, never replaced by a ' +
      'request for a new one). Use it BEFORE stopping a chain you will have to restart, and ' +
      'whenever a start does not take: a disconnected connector otherwise shows up only as ' +
      '"state did not flip". Credentials and the provider input bag are never returned. ' +
      'Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description: 'Numeric Workato recipe id.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.LIST_JOBS,
    description:
      "List and SEARCH jobs for a Workato recipe. Auto-walks Workato's cursor pagination. " +
      'Two searches, combinable: `query` is the SERVER one and matches a contiguous, ' +
      'case-insensitive substring of the job id or of a custom job-report column value ONLY ' +
      '(not the error text, not column labels, and never an erased job); `match` is a LOCAL scan ' +
      'of every job the walk sees, over id / title / error / report columns, as exact, substring ' +
      'or regex. Date range: started_from / started_to (ISO, or YYYY-MM-DD widened to the whole ' +
      'day) in `timezone` (default UTC); started_at takes only the fixed presets. Two budgets: ' +
      '`limit` caps matches RETURNED, `scan_budget` caps jobs SCANNED. Every response carries ' +
      '`coverage` (scanned, matched, erased_seen, window, complete, next_cursor, ' +
      'retention_boundary_reached) and a `summary` sentence: zero matches from an incomplete scan ' +
      'is NOT evidence of none, so resume with cursor=next_cursor. ERASED jobs (retention swept) ' +
      'stay listed with erased:true, title/report null and no error: unavailable, not empty. The ' +
      'walk stops after 3 consecutive erased jobs because that boundary is workspace-wide and ' +
      'everything older is erased too (stop_on_erased:false to keep going). Report columns come ' +
      'back with their configured labels, all of them, plus report_columns. `fields` projects the ' +
      'slim job. Returns {total, succeeded, failed, jobs, coverage, next_cursor, ' +
      'report_columns}. Requires an open Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description: 'Numeric Workato recipe id.',
        },
        limit: {
          type: 'number',
          description:
            'Max jobs to return. 1..100, default 25. Tool auto-walks Workato pagination cursor to fulfill.',
          default: 25,
          minimum: 1,
          maximum: 100,
        },
        status: {
          type: 'string',
          description:
            "Server-side status filter. Use 'failed', 'succeeded', 'pending', etc. SINGULAR; statuses[] is silently ignored.",
        },
        query: {
          type: 'string',
          description:
            'Server-side search: a contiguous case-insensitive SUBSTRING of the job id or of a ' +
            'custom job-report column value. Does NOT match the error message, logger output or ' +
            'column labels, and never matches an erased job. Use [match] for those.',
        },
        match: {
          type: 'object',
          description:
            'Local scan applied to every job the walk sees, inside the page walk. Use it for ' +
            'what `query` cannot search: error text, a whole-word or regex match.',
          properties: {
            mode: {
              type: 'string',
              enum: ['exact', 'substring', 'regex'],
              description:
                "Default 'substring'. exact and substring are case-insensitive; regex is " +
                'compiled case-insensitive.',
            },
            fields: {
              type: 'array',
              items: { type: 'string' },
              description:
                "Fields to look at: 'id', 'title', 'error' (message + inner_message + type), " +
                "'report' (every column), or 'report.<column label>' / 'report.<custom_column_N>'. " +
                'Default: id, title, error, report.',
            },
            value: { type: 'string', description: 'The string or pattern to look for.' },
          },
          required: ['value'],
        },
        scan_budget: {
          type: 'number',
          description:
            'Jobs SCANNED before the walk gives up, separate from `limit` (matches returned). ' +
            'Default 500, max 5000. Raised to `limit` when it would be smaller.',
          default: 500,
        },
        stop_on_erased: {
          type: 'boolean',
          description:
            'Stop after 3 consecutive erased jobs. Default true: the retention sweep is ' +
            'workspace-wide, so everything older than the boundary is erased too and scanning on ' +
            'spends pages for nothing. Set false to walk past it anyway.',
          default: true,
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Project each job down to these fields, e.g. ['id','started_at','status'," +
            "'report.Marker code']. Allowed: id, status, started_at, completed_at, duration_ms, " +
            'error_summary, error_line_number, title, report, erased, zero_retention, is_test, ' +
            'calling_recipe_id, calling_job_id, or report.<label> / report.<custom_column_N>. ' +
            'Unavailable data (an erased job) comes back null with erased:true, never as empty.',
        },
        report_labels: {
          type: 'boolean',
          description:
            "Label report columns from the recipe's job_report_schema (one extra recipe read, " +
            'cached per recipe and version). Default true; false keeps custom_column_N keys.',
          default: true,
        },
        started_at: {
          type: 'string',
          enum: ['1.hour', '24.hours', '7.days', '30.days', 'all'],
          description:
            'Preset window. These five are the ONLY values Workato honours; any other is ' +
            'silently ignored server-side, so this tool rejects it rather than returning an ' +
            'unfiltered scope. Use started_from/started_to for a custom range.',
        },
        started_from: {
          type: 'string',
          description:
            'Oldest job start to include. ISO-8601 with an offset or Z, YYYY-MM-DD (widened to ' +
            '00:00:00) or YYYY-MM-DDTHH:MM(:SS). Sent as started_at_from; filters server-side.',
        },
        started_to: {
          type: 'string',
          description:
            'Newest job start to include. Same formats; a bare YYYY-MM-DD is widened to ' +
            '23:59:59, so started_from=started_to=a date selects that whole day. Sent as ' +
            'started_at_to.',
        },
        timezone: {
          type: 'string',
          description:
            "Zone applied to started_from/started_to when they carry no offset. Default 'UTC'. " +
            "Accepts an offset ('-07:00') or an IANA name ('America/Los_Angeles').",
          default: 'UTC',
        },
        group_by_master_job: {
          type: 'boolean',
          description: 'Collapse retry chains under their master job.',
          default: false,
        },
        cursor: {
          type: 'string',
          description:
            'Job id to resume from. Pass the next_cursor from a previous response to page forward.',
        },
        full: {
          type: 'boolean',
          description: 'If true, return raw concatenated pages instead of the slim shape.',
          default: false,
        },
        timeout_ms: {
          type: 'number',
          description:
            'Overall timeout in milliseconds. Default 30000, clamped 10000-110000. The internal ' +
            'page-walk budget is timeout_ms minus ~8s headroom, so raising this lets one call scan ' +
            'deeper before returning partial results.',
          minimum: 10000,
          maximum: 110000,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.REPEAT_JOB,
    description:
      'Repeat (re-run) one or more Workato jobs by master job id. WRITE operation: ' +
      "each repeated job re-executes the recipe against that job's original trigger " +
      'data. job_ids are the string master job ids as returned by workato_list_jobs / ' +
      "workato_job_trace (e.g. 'j-Aaxc9bm4-egoMDh-CD'). Returns a per-job ok flag " +
      'from Workato. Not auto-retried on timeout (a blind retry could double-run ' +
      'jobs), so re-check with workato_list_jobs before retrying. Requires an open ' +
      'Workato tab.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description: 'Numeric Workato recipe id the jobs belong to.',
        },
        job_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 50,
          description: "Master job ids to repeat, e.g. ['j-Aaxc9bm4-egoMDh-CD']. Max 50 per call.",
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id', 'job_ids'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.TEST_RECIPE,
    description:
      'Run a Workato recipe Test, with trigger input where Workato supports it. The supported ' +
      'alternative to a throwaway recipe plus the browser Test button. The mode ' +
      'comes from the trigger: input (workato_recipe_function: trigger_input becomes ' +
      "trigger_event.parameters and is checked against the trigger's declared parameters), " +
      'immediate (clock/scheduler, takes no trigger_input), waiting (webhook or ' +
      "workato_pub_sub: the test arms and waits for a real event; end it with action:'stop'), " +
      'unsupported (any other trigger; nothing is sent). A test EXECUTES the real steps, so ' +
      'allow_writes:true is required when the recipe binds a connection-backed provider (a ' +
      'config entry with account_id); connectionless recipes (logger, workato_variable, ' +
      'workato_pub_sub, clock, py_eval) run without it. The recipe is not started and stays ' +
      'stopped (stop_reason test_run_stop). Workato returns no job id, so this polls the ' +
      'test-job list: with wait (default true) it returns the finished job, or status ' +
      '"pending" with the elapsed time when the wait runs out, never a guessed result. Read ' +
      'the job with workato_job_trace(recipe_id, job_id). Publishing to an Event Streams topic ' +
      'has no API: the only supported path is test-running a recipe with a workato_pub_sub ' +
      'publish_to_topic step, input {topic_id, message} plus a matching extended_input_schema. ' +
      'workato_call_action cannot run a connectionless adapter: its endpoint needs a real ' +
      "connection id. action:'status' reports flow.testing and the newest test job.",
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description: 'Numeric Workato recipe id to test.',
        },
        action: {
          type: 'string',
          enum: ['run', 'stop', 'status'],
          description:
            "'run' (default) starts one test, 'stop' ends a waiting webhook/pub_sub test, 'status' reads flow.testing and the newest test job.",
          default: 'run',
        },
        trigger_input: {
          type: 'object',
          description:
            "Trigger data for a workato_recipe_function trigger; sent as trigger_event.parameters. Keys must match the trigger's parameters_schema_json (unknown or missing required keys are refused before anything is sent). Rejected for every other trigger type.",
        },
        allow_writes: {
          type: 'boolean',
          description:
            'Required (true) when the recipe binds any connection-backed provider, because the test executes its real steps against those systems. Default false.',
          default: false,
        },
        wait: {
          type: 'boolean',
          description:
            'Poll the test-job list until the job finishes. Default true. Ignored for a waiting trigger, which produces no job until a real event arrives.',
          default: true,
        },
        wait_timeout_ms: {
          type: 'number',
          description:
            'Max time to wait for the test job to finish. Default 60000, clamped 2000 to 110000. On timeout the response carries status "pending" and the elapsed time.',
          minimum: 2000,
          maximum: 110000,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.RUN_QUERY,
    description:
      'Run a SQL-style query (SOQL, SuiteQL, or SQL) against any Workato ' +
      'connection. Returns {schema, rows} in a consistent shape regardless ' +
      'of underlying SaaS. Hard-capped at ~100 rows server-side; narrow via ' +
      'WHERE clause for more. SOQL queries: any trailing LIMIT clause is ' +
      'stripped before sending (Workato auto-appends LIMIT 100, so a ' +
      'user-supplied LIMIT would collide). connection_id is shared_account_id ' +
      'from search_connections or recipe.version.config. Read-only, never ' +
      'treat as a write API. Requires an open Workato tab (*.workato.com or ' +
      '*.workato.is).',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: {
          type: 'number',
          description: 'Numeric Workato connection id (shared_account_id).',
        },
        query: {
          type: 'string',
          description:
            'The query body. For SOQL, do NOT include a LIMIT clause (Workato adds its own). For SuiteQL use NetSuite Analytics Browser syntax. For SQL, support depends on adapter.',
        },
        type: {
          type: 'string',
          enum: ['soql', 'suiteql', 'sql'],
          description:
            "Query dialect. 'soql' for Salesforce, 'suiteql' for NetSuite, 'sql' for some database adapters (not all support this).",
        },
        schema_only: {
          type: 'boolean',
          description: 'If true, return only field schema (drop rows). Default false.',
          default: false,
        },
        full: {
          type: 'boolean',
          description: 'If true, return the raw Workato result envelope instead of the slim shape.',
          default: false,
        },
        timeout_ms: {
          type: 'number',
          description:
            'Max time to wait for the query before aborting, in milliseconds. Default 90000 ' +
            '(90s). Clamped to 5000-110000. Raise this for slow connectors (e.g. NetSuite ' +
            'SuiteQL or large scans) that return "timed out after Ns and was aborted".',
          minimum: 5000,
          maximum: 110000,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['connection_id', 'query', 'type'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.CALL_ACTION,
    description:
      'Invoke any named connector action with arbitrary input via the same ' +
      "endpoint Workato's recipe editor uses for the Test button. " +
      '\n\n**MOST POWERFUL TOOL IN THE KIT: CAN MUTATE SAAS DATA.** ' +
      'Defaults to a read-only safety gate: action_name must start with ' +
      'search_/get_/list_/query_/find_/describe_/read_/fetch_, OR be exactly ' +
      "'execute_suiteql', OR be '__adhoc_http_action' with verb get/head/options. " +
      'Anything else (add_record, upsert_record, delete_*, POST/PUT/DELETE HTTP ' +
      'verbs, etc.) is rejected with WorkatoUnsafeAction unless caller passes ' +
      'allow_writes:true. Use that flag deliberately: it can create, modify, or ' +
      'delete real records in production SaaS. ' +
      '\n\nAction names come from inspecting recipe steps: every step in a ' +
      "recipe's code tree has a 'name' field that is a valid action_name. " +
      'Pull a representative recipe with workato_pull_recipe and read its ' +
      'step structure to learn what actions exist on a connector. Common ' +
      "names: '__adhoc_http_action' (any HTTP connector), 'execute_suiteql' " +
      "(NetSuite), 'search_sobjects_soql_v2' (Salesforce), 'add_record'/" +
      "'upsert_record'/'delete_record' (NetSuite, writes)." +
      '\n\nAD-HOC SOQL (the killer use case: query Salesforce through the ' +
      "recipe's own connection, no SFDC UI access needed): action_name " +
      "'search_sobjects_soql_v2' with minimal input {query:'SELECT Id FROM " +
      'Asset WHERE ...\', limit:100, output_schema:\'[{"name":"Id"}]\'}. ' +
      'output_schema is REQUIRED but need not match the selected fields; a ' +
      'one-field dummy schema works; all selected fields come back anyway. ' +
      'Omitting output_schema/limit makes Workato introspect the full object ' +
      'schema and the call usually times out (which looks like a wrong input ' +
      'shape but is not). Prefer workato_run_query(type:"soql") when you just ' +
      'need rows; call_action is for when you need the raw action behavior.' +
      '\n\nconnection_id must be a real connection id: an adapter name (logger, ' +
      'workato_pub_sub) is rejected by the endpoint, so a connectionless step ' +
      'can only be executed by test-running a recipe that contains it, via ' +
      'workato_test_recipe.',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: {
          type: 'number',
          description: 'Numeric Workato connection id.',
        },
        action_name: {
          type: 'string',
          description:
            "The action identifier (the 'name' field on a recipe step). E.g. 'execute_suiteql', '__adhoc_http_action', 'search_sobjects_soql_v2'.",
        },
        input: {
          type: 'object',
          description:
            "The action's input parameters as a JSON object. Shape is action-specific. For __adhoc_http_action: {mnemonic:'Custom action', verb, path, response_type:'json', inspect:true, request_headers?}; both `mnemonic` and `inspect:true` are REQUIRED; Workato rejects with \"'Action name' must be present\" if either is omitted. For execute_suiteql: {query}. For SOQL search: {query, output_schema, ...}.",
        },
        allow_writes: {
          type: 'boolean',
          description:
            'Required (true) for actions that look like writes. Default false. Loudly enables potentially destructive operations.',
          default: false,
        },
        full: {
          type: 'boolean',
          description:
            'If true, return the full Workato response envelope instead of just the result.',
          default: false,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['connection_id', 'action_name', 'input'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.OPEN_RECIPE,
    description:
      'Open a Workato recipe by ID. If a tab is already on this recipe, activates it; otherwise navigates the active Workato tab. ' +
      'Set mode="edit" to open directly in the editor (URL gets /edit suffix). ' +
      'Waits for the recipe toolbar to appear before returning.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'Workato recipe ID (integer).' },
        mode: {
          type: 'string',
          enum: ['view', 'edit'],
          description: 'Open in view or edit mode (default: view).',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.ENTER_EDIT_MODE,
    description:
      'Click the toolbar "Edit" button to enter the recipe editor. No-op if the URL is already /edit. ' +
      'Waits up to 8s for the "Save" button to appear before returning. ' +
      'Prerequisite: workato_ui_open_recipe must have been called (or a Workato recipe page is otherwise loaded).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.LIST_STEPS,
    description:
      'List all steps on the currently open recipe as JSON: {number, label}. ' +
      "`label` is the trimmed text of each step's .recipe-step__title-container " +
      '(e.g. "Log message to Job report"). ' +
      'Useful right after workato_ui_open_recipe or after workato_ui_add_step to discover the newest step number. ' +
      'Works in both view and edit mode.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.FOCUS_STEP,
    description:
      'Click the step bubble with the given number to open its config panel on the right. ' +
      'Required before workato_ui_set_field / workato_ui_insert_datapill, which operate on the focused step.',
    inputSchema: {
      type: 'object',
      properties: {
        step_number: { type: 'number', description: 'Step number to focus (1-indexed).' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['step_number'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.ADD_STEP,
    description:
      'Insert a new step after step `after_step`. For kind="action" (default), drives the full picker chain: ' +
      '"Add step" -> "Action in app" -> select app -> select action. For other kinds (if/repeat/stop/handle_errors), ' +
      'only the menuitem click is performed. Returns the new step number. ' +
      'Prerequisite: recipe must be in edit mode (call workato_ui_enter_edit_mode first).',
    inputSchema: {
      type: 'object',
      properties: {
        after_step: {
          type: 'number',
          description:
            'Step number to insert after (1-indexed; uses 1 to insert after the trigger).',
        },
        app: {
          type: 'string',
          description:
            'App display name as shown in Workato (e.g. "Logger by Workato", "Salesforce", "NetSuite SOAP"). Case-insensitive substring match.',
        },
        action: {
          type: 'string',
          description:
            'Action display name within the chosen app. Case-insensitive substring match.',
        },
        kind: {
          type: 'string',
          enum: ['action', 'if', 'repeat', 'stop', 'handle_errors'],
          description: 'Step kind (default: action).',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['after_step', 'app', 'action'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.SET_FIELD,
    description:
      'Set a field value on the currently focused step. Matches the field by visible label first (e.g. "Message"), ' +
      'then falls back to internal data-field-id (e.g. "message"). Handles CodeMirror, plain inputs, textareas, ' +
      'and contenteditable. Optional mode="formula"/"text" toggles the formula switcher. ' +
      'Prerequisite: caller must have focused the relevant step first via workato_ui_focus_step.',
    inputSchema: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          description: 'Field label (visible) or internal data-field-id. Label is tried first.',
        },
        value: { type: 'string', description: 'Value to write into the field.' },
        mode: {
          type: 'string',
          enum: ['text', 'formula'],
          description: 'Optionally toggle the text/formula switcher before writing.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['field', 'value'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.INSERT_DATAPILL,
    description:
      'Insert a datapill from `source_step` into the named field. First tries HTML5 drag emulation; if the field value ' +
      'does not change within 300ms, falls back to formula injection (=_dp(...)) by fetching the recipe code and ' +
      "reading the source step's line id + provider. " +
      'Prerequisite: caller must have focused the relevant step first via workato_ui_focus_step. ' +
      'NOTE: HTML5 synthetic drag is unreliable across Chrome versions; formula fallback is the production path.',
    inputSchema: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          description: 'Target field (label or data-field-id) on the currently focused step.',
        },
        source_step: {
          type: 'number',
          description: 'Step number whose output tree provides the pill.',
        },
        path: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Path through the source step\'s output tree to the leaf (e.g. ["body","id"]).',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['field', 'source_step', 'path'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.SAVE_RECIPE,
    description:
      'Click "Save" and wait until the recipe\'s ng-dirty count drops to 0 (verified via DOM poll). ' +
      'Returns an error if validation errors appear or if dirty state does not clear within 10s. ' +
      'Prerequisite: recipe must be in edit mode with pending changes.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.EXIT_EDIT_MODE,
    description:
      'Click "Exit". If Workato pops a "Unsaved changes" confirm dialog, the `discard` flag picks which button to press: ' +
      'true -> discard/leave; false (default) -> cancel/stay. ' +
      'Prerequisite: recipe must be in edit mode.',
    inputSchema: {
      type: 'object',
      properties: {
        discard: {
          type: 'boolean',
          description:
            'If a confirm dialog appears, true=discard changes, false=stay (default false).',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.CREATE_RECIPE,
    description:
      "Create a new Workato recipe via the live tab's authenticated session (POST /recipes.json). " +
      'Two modes: ' +
      '(1) pass `folder_id` to drop the recipe into an existing folder; ' +
      '(2) pass `project_name` (and omit `folder_id`) to first create a new project via ' +
      "POST /web_api/projects.json and then create the recipe in that project's folder. " +
      'Returns the new recipe id and edit URL. Prerequisite: the active tab must be a logged-in Workato page ' +
      '(needed to read the CSRF token and reuse the session cookie). The recipe is created in trigger-only ' +
      'state; open it in edit mode (workato_ui_open_recipe with mode="edit") to configure the trigger.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Recipe name (required).' },
        folder_id: {
          type: 'number',
          description:
            'Existing folder/project ID to create the recipe in. Mutually exclusive with project_name.',
        },
        project_name: {
          type: 'string',
          description:
            'If provided AND folder_id is omitted, a new project is created first and its folder_id is used.',
        },
        description: {
          type: 'string',
          description:
            'Optional description. When creating a project it is applied to the project; the recipe description defaults to empty.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['name'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_UI.SAVE_RECIPE_CODE,
    description:
      'Save a complete recipe code tree directly via the Workato REST API (PUT /recipes/<id>.json). ' +
      'Bypasses the UI entirely: no need to enter edit mode, focus steps, or drive the editor. ' +
      'Pair with workato_pull_recipe to fetch the current code, mutate it client-side, then save. ' +
      'For large recipes use the file round-trip: workato_pull_recipe(out_file:...) then save with ' +
      '[code_path] so the recipe tree never has to be passed inline. ' +
      'RUNNING RECIPES: Workato rejects code saves on running recipes, so pass restart_if_running:true ' +
      'to have the tool stop → save → verify → restart atomically (response reports stopped_at + restarted). ' +
      'SAFETY: pass expected_base_version_no (the version_no you pulled) to refuse saving over someone ' +
      "else's concurrent edit; pass comment to annotate the new version in the same call. " +
      'If the save request times out, the tool verifies via version_no and a tree readback whether the ' +
      'save actually landed and reports save_status:"succeeded_after_timeout" instead of a false failure; ' +
      'retrying a save that already landed returns save_status:"already_applied" without creating a ' +
      'duplicate version. ' +
      'VERIFIED WRITES: every save is read back and compared against what was sent. Workato silently ' +
      'drops dynamic input keys (py_eval code_input.data, call_recipe parameters, custom_fields, ' +
      'data-table columns, declare_variable variables) on steps that lack a matching ' +
      'extended_input_schema: it answers 200 with empty code_errors and stores nothing. When that ' +
      'happens the tool FAILS with save_status:"persisted_incomplete" and names the dropped paths. ' +
      'Datapill payloads are also re-serialized compactly before saving, because Workato matches ' +
      "#{_dp('<json>')} byte-for-byte and a pill with json.dumps spacing resolves to an empty value. " +
      'Returns the new version_no plus any validation errors Workato emits about the saved tree. ' +
      'Targets the session pinned tab or any open Workato app tab (never whatever tab is focused).',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Numeric Workato recipe id. Required unless [code_path] is given and the file ' +
            'contains a numeric recipe_id.',
        },
        code: {
          description:
            'Recipe code tree. Either a plain object (will be JSON.stringified) or an already-stringified JSON string. Same shape as workato_pull_recipe returns under .code. Provide this OR [code_path], not both.',
        },
        code_path: {
          type: 'string',
          description:
            'Absolute path to a recipe JSON file as written by workato_pull_recipe(out_file:...). ' +
            'When set, code/config/recipe_id are read from the file and [code]/[config] are ' +
            'ignored, so the recipe tree never has to be passed inline. The agent-friendly push path.',
        },
        config: {
          description:
            'Optional config array (apps/connections used by the recipe). Either an array (will be JSON.stringified) or a stringified JSON. Ignored when [code_path] is set.',
        },
        name: {
          type: 'string',
          description: 'Optional new recipe name. Omit to leave unchanged.',
        },
        description: {
          type: 'string',
          description: 'Optional description. Omit to leave unchanged.',
        },
        restart_if_running: {
          type: 'boolean',
          description:
            'When the recipe is running: stop it, save, then start it again: one atomic call ' +
            'with the smallest possible trigger downtime. Response includes stopped_at and restarted. ' +
            'Without this flag, saving a running recipe fails fast with a clear error. ' +
            'This flag only restores what the save stopped: a recipe that was ALREADY stopped stays ' +
            'stopped (the response says so via was_running:false). Use ensure_running to start it.',
          default: false,
        },
        ensure_running: {
          type: 'boolean',
          description:
            'Start the recipe after a successful save even when it was already stopped before the ' +
            'call. Use it when the recipe must be live afterwards regardless of the state it was in.',
          default: false,
        },
        comment: {
          type: 'string',
          description:
            'Version comment to set on the newly created version (replaces a separate workato_set_version_comment call).',
        },
        expected_base_version_no: {
          type: 'number',
          description:
            'Optimistic lock: refuse to save when the current version_no differs from this value ' +
            '(someone else saved since you pulled). Pass the version_no from your pull_recipe call. ' +
            'With [code_path] it defaults to the version_no recorded in the file.',
        },
        ignore_file_version: {
          type: 'boolean',
          description:
            'Push a [code_path] file even though the recipe moved on since it was pulled: skips ' +
            'the version lock defaulted from the file. A deliberate overwrite of newer work.',
          default: false,
        },
        allow_context_mismatch: {
          type: 'boolean',
          description:
            'Allow the save when the target tab is in a different workspace/environment than the ' +
            'file origin or the pinned session. Off by default, and off is what you want.',
          default: false,
        },
        verify_readback: {
          type: 'boolean',
          description:
            'Read the saved tree back and compare it against what was sent (default true). This is ' +
            'the silent-strip guard; turn it off only to push past a verification you have ' +
            'established is a false positive.',
          default: true,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_RECIPE.ADD_STEP,
    description:
      'Insert one step into a Workato recipe. Runs through the guarded mutation engine ' +
      '(pull, apply to a clone, validate, merge config, save, read back), so the existing ' +
      '`config` array is MERGED rather than rebuilt and every account_id binding survives; the ' +
      'whole tree is renumbered, nested blocks included; and the insertion point may be nested ' +
      '(pass anchor, or an after_step that lives inside a foreach/if/try). Generates a fresh ' +
      '8-hex `as` and a uuid, and refuses before saving when the result would break the nesting ' +
      'rules. A provider new to the recipe gets a config entry, with account_id only when ' +
      'connection_id is given (otherwise the response reports connection_binding: missing). ' +
      'For several edits at once, or for remove/move/loop-source operations, use ' +
      'workato_recipe_apply. Requires an open logged-in Workato tab (uses the session pinned ' +
      'tab or first Workato app tab, never whatever tab is focused).',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'Numeric Workato recipe id.' },
        after_step: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description:
            'Insert the new step after this step number or `as` anchor, nested blocks included. ' +
            'Use 0 to insert as the first action right after the trigger. Omit to append at the end, ' +
            'or pass `anchor` for full control.',
        },
        anchor: {
          type: 'object',
          description:
            'Explicit placement, overriding after_step. mode: after | before | into; step: number, `as`, or uuid; position: first | last (mode into only).',
          properties: {
            mode: { type: 'string', enum: ['after', 'before', 'into'] },
            step: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            position: { type: 'string', enum: ['first', 'last'] },
          },
        },
        connection_id: {
          description:
            'Connection id for a provider new to this recipe, written as account_id in its config entry.',
        },
        provider: {
          type: 'string',
          description:
            'Connector/provider name, e.g. "logger", "salesforce", "netsuite". Becomes step.provider. Required for keyword "action".',
        },
        action_name: {
          type: 'string',
          description:
            'Action name within the provider, e.g. "log_message", "search_sobjects_soql_v2". Becomes step.name. Required for keyword "action".',
        },
        input: {
          type: 'object',
          description:
            'Optional initial field values for the new step (becomes step.input). Defaults to an empty object.',
        },
        keyword: {
          type: 'string',
          enum: ['action', 'if', 'foreach', 'repeat', 'try', 'stop'],
          description:
            'Step keyword. Defaults to "action". A repeat is created with its while_condition as the first child and a try with its catch last, per the code-tree rules. A return_result step is keyword "action" with action_name "return_result" and provider "workato_recipe_function".',
        },
        source: {
          description:
            'foreach only: the list datapill (object or `provider.line.path` shorthand) written at the node root.',
        },
        expected_base_version_no: {
          type: 'number',
          description:
            'Optimistic lock forwarded to the save. Defaults to the version_no this call just pulled.',
        },
        comment: {
          type: 'string',
          description: 'Forwarded to the underlying save: version comment for the new version.',
        },
        verify_readback: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: read the stored tree back and fail when Workato silently dropped input keys (default true).',
          default: true,
        },
        dry_run: {
          type: 'boolean',
          description: 'Validate and report what would change without saving anything.',
          default: false,
        },
        auto_schema: {
          type: 'boolean',
          description:
            "Derive the extended schemas the recipe's own declarations imply (Variables steps, clock trigger) so a structured input is not silently dropped on save. Default true.",
          default: true,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_RECIPE.SET_STEP_INPUT,
    description:
      'Set an input field on an existing recipe step. Runs through the guarded mutation engine ' +
      '(pull, apply to a clone, validate, merge config, save, read back), so the existing config ' +
      'and its account_id bindings survive the save and the stored tree is verified afterwards. ' +
      'NESTED PATHS SUPPORTED: field accepts dotted paths like ' +
      '"parameters.sysid_param.asset_id" or "filters[0].value", with no file round-trip needed for ' +
      'one-field fixes deep in a step. Steps anywhere in the tree are reachable: step_number ' +
      'accepts the numeric step number (0 = trigger) OR the step `as` anchor string, and nested ' +
      'blocks (if / foreach / try) are searched recursively. Preserves all other fields. ' +
      'For datapill/formula values with validation, prefer workato_recipe_set_input_path. ' +
      'Requires a logged-in Workato browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'Numeric Workato recipe id.' },
        step_number: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description:
            'Step to modify: numeric step number (0 = trigger), `as` anchor string (e.g. "c0a385ab"), or uuid. Nested blocks are searched; a duplicated number in a corrupted tree is refused rather than guessed.',
        },
        field: {
          type: 'string',
          description:
            'Input field name or nested dotted path, e.g. "message" or "parameters.sysid_param.asset_id" or "filters[0].value". Missing intermediate objects/arrays are created.',
        },
        value: {
          description:
            'Value to write into the path. Accepts string, number, boolean, object, or array.',
        },
        expected_base_version_no: {
          type: 'number',
          description:
            'Optimistic lock forwarded to the save. Defaults to the version_no this call just pulled.',
        },
        comment: {
          type: 'string',
          description: 'Forwarded to the underlying save: version comment for the new version.',
        },
        verify_readback: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: read the stored tree back and fail when Workato silently dropped input keys (default true).',
          default: true,
        },
        dry_run: {
          type: 'boolean',
          description: 'Validate and report what would change without saving anything.',
          default: false,
        },
        auto_schema: {
          type: 'boolean',
          description:
            "Derive the extended schemas the recipe's own declarations imply (Variables steps, clock trigger) so a structured input is not silently dropped on save. Default true.",
          default: true,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['recipe_id', 'step_number', 'field', 'value'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_RECIPE.MAP_DATAPILL,
    description:
      "Map a target step field to a datapill from another step's output. Runs through the guarded " +
      'mutation engine (pull, apply to a clone, validate, merge config, save, read back), so the ' +
      'existing config and its account_id bindings survive the save. ' +
      'Builds the canonical Workato `=_dp(...)` formula from the source ' +
      "step's `as` (line id) and `provider`, then writes it into the target path. " +
      'NESTED PATHS SUPPORTED: target_field accepts dotted paths like "parameters.sysid_param.asset_id"; ' +
      'target_step/source_step accept step numbers (0 = trigger) or `as` anchor strings, and nested ' +
      'blocks are searched recursively. LIST PILLS: a path element "list_items[]" expands to ' +
      '"list_items" + {path_element_type:"current_item"} (referencing the foreach current item, e.g. ' +
      '"f95ce216.list_items[].AssetId" → source_step:"f95ce216", path:["list_items[]","AssetId"]); ' +
      'raw path objects also pass through unchanged. Requires a logged-in Workato browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'Numeric Workato recipe id.' },
        target_step: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description:
            'Step where the field being mapped lives: numeric step number (0 = trigger) or `as` anchor string.',
        },
        target_field: {
          type: 'string',
          description:
            'Field name or nested dotted path on the target step that will hold the datapill formula, e.g. "parameters.sysid_param.asset_id".',
        },
        source_step: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description:
            'Step whose output is being referenced: numeric step number (0 = trigger) or `as` anchor string. Must already have an `as` and `provider`.',
        },
        path: {
          type: 'array',
          items: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
          description:
            'Path into the source step output, e.g. ["records"] or ["body","id"]. "name[]" expands to ' +
            'name + {path_element_type:"current_item"}; "name#size" expands to the collection count; ' +
            'raw objects (e.g. {path_element_type:"current_item"}) ' +
            'pass through as-is. Empty array references the root output.',
        },
        expected_base_version_no: {
          type: 'number',
          description:
            'Optimistic lock forwarded to the save. Defaults to the version_no this call just pulled.',
        },
        comment: {
          type: 'string',
          description: 'Forwarded to the underlying save: version comment for the new version.',
        },
        verify_readback: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: read the stored tree back and fail when Workato silently dropped input keys (default true).',
          default: true,
        },
        dry_run: {
          type: 'boolean',
          description: 'Validate and report what would change without saving anything.',
          default: false,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['recipe_id', 'target_step', 'target_field', 'source_step', 'path'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_RECIPE.SET_INPUT_PATH,
    description:
      "Set a nested value inside an existing Workato recipe step's input via a native-server " +
      'pull-mutate-push round trip. NESTED PATHS are first-class here: the target step may be ' +
      'identified by step number or `as` anchor (nested blocks searched), and the path may be a ' +
      'dotted string such as `records.item.items[0].amount` or an array of string/number segments. ' +
      'Creates missing intermediate objects/arrays, refuses unsafe path segments and ' +
      'non-container parents, and preserves all unrelated code-tree fields. Supports literal values, ' +
      'formula strings, interpolated strings, and datapill specs; datapill shorthand ' +
      '`datapill(provider.line.list_items[].AssetId)` expresses current-item (foreach) pills. ' +
      'THE preferred tool for one-field fixes deep inside a step (no file round-trip needed). ' +
      'Accepts restart_if_running/ensure_running/comment/expected_base_version_no, forwarded to the ' +
      'underlying save (which verifies the readback and fails when Workato silently drops input keys). ' +
      'Requires a logged-in Workato browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'Numeric Workato recipe id.' },
        step: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Target step number or `as` anchor. Use 0 for the trigger if needed.',
        },
        path: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
          ],
          description:
            'Input path to set. Dotted strings support numeric indexes, e.g. `filters[0].field_id`.',
        },
        value: {
          description:
            'Value to write. For literal, any JSON value. For formula/interpolated, a string. For datapill, either a datapill object {provider,line,path,pill_type?} or shorthand such as `datapill(provider.line.output.rows[].id)`.',
        },
        value_kind: {
          type: 'string',
          enum: ['literal', 'datapill', 'formula', 'interpolated'],
          description:
            'How to encode value. Default literal. formula prefixes `=` when absent; datapill writes a text-mode #{_dp(...)} reference.',
        },
        restart_if_running: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: stop a running recipe, save, restart: one atomic call. ' +
            'A recipe that was already stopped stays stopped; use ensure_running to start it.',
          default: false,
        },
        ensure_running: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: start the recipe afterwards even if it was already stopped.',
          default: false,
        },
        comment: {
          type: 'string',
          description: 'Forwarded to the underlying save: version comment for the new version.',
        },
        expected_base_version_no: {
          type: 'number',
          description:
            'Optimistic lock forwarded to the save. Defaults to the version_no this call just pulled, so concurrent edits are refused automatically.',
        },
        verify_readback: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: read the stored tree back and fail when Workato ' +
            'silently dropped input keys (default true). Set false only to push past a ' +
            'verification you have established is a false positive.',
          default: true,
        },
        tabId: { type: 'number', description: 'Target tab ID for the final save (optional).' },
        windowId: { type: 'number', description: 'Window ID for the final save (optional).' },
      },
      required: ['recipe_id', 'step', 'path', 'value'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_RECIPE.DELETE_INPUT_PATH,
    description:
      "Delete a nested leaf from an existing Workato recipe step's input via a native-server " +
      'pull-mutate-push round trip. The target step may be identified by step number or `as` anchor. ' +
      'After deleting the leaf, empty parent objects/arrays along that path are pruned. Unrelated ' +
      'input branches are preserved. Requires a logged-in Workato browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'Numeric Workato recipe id.' },
        step: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Target step number or `as` anchor. Use 0 for the trigger if needed.',
        },
        path: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
          ],
          description: 'Input path to delete, e.g. `records.tranId` or `filters[0].field_id`.',
        },
        restart_if_running: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: stop a running recipe, save, restart. Already-stopped recipes stay stopped.',
          default: false,
        },
        ensure_running: {
          type: 'boolean',
          description: 'Forwarded to the underlying save: start the recipe afterwards.',
          default: false,
        },
        comment: {
          type: 'string',
          description: 'Forwarded to the underlying save: version comment for the new version.',
        },
        expected_base_version_no: {
          type: 'number',
          description:
            'Optimistic lock forwarded to the save. Defaults to the version_no this call just pulled.',
        },
        verify_readback: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: read the stored tree back and fail when Workato silently dropped input keys (default true).',
          default: true,
        },
        tabId: { type: 'number', description: 'Target tab ID for the final save (optional).' },
        windowId: { type: 'number', description: 'Window ID for the final save (optional).' },
      },
      required: ['recipe_id', 'step', 'path'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_RECIPE.SET_PY_EVAL_CODE,
    description:
      'Replace the `input.code` body of a Python by Workato action (`py_eval / invoke_custom_py_code`). ' +
      'Accepts either inline `code` or a local `code_path`; when `code_path` is used, the native server reads ' +
      'the file before pushing the recipe so the code body does not need to enter agent context. By default, ' +
      'the tool refuses non-py_eval targets; set validate_step=false only when intentionally writing a compatible custom step.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'Numeric Workato recipe id.' },
        step: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Target py_eval step number or `as` anchor.',
        },
        code: { type: 'string', description: 'Inline Python source to write to input.code.' },
        code_path: {
          type: 'string',
          description:
            'Absolute or relative local path on the bridge host. The native server reads it as UTF-8 and sends it as code.',
        },
        validate_step: {
          type: 'boolean',
          description: 'When false, skip the default provider/name check. Default true.',
        },
        restart_if_running: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: stop a running recipe, save, restart. Already-stopped recipes stay stopped.',
          default: false,
        },
        ensure_running: {
          type: 'boolean',
          description: 'Forwarded to the underlying save: start the recipe afterwards.',
          default: false,
        },
        comment: {
          type: 'string',
          description: 'Forwarded to the underlying save: version comment for the new version.',
        },
        expected_base_version_no: {
          type: 'number',
          description:
            'Optimistic lock forwarded to the save. Defaults to the version_no this call just pulled.',
        },
        verify_readback: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: read the stored tree back and fail when Workato silently dropped input keys (default true).',
          default: true,
        },
        ignore_file_version: {
          type: 'boolean',
          description:
            'Save without the optimistic lock the tool otherwise derives from the version it just ' +
            'pulled. A deliberate overwrite of a concurrent edit.',
          default: false,
        },
        allow_context_mismatch: {
          type: 'boolean',
          description:
            'Allow the save when the target tab is in a different workspace/environment than the ' +
            'pinned session. Off by default.',
          default: false,
        },
        tabId: { type: 'number', description: 'Target tab ID for the final save (optional).' },
        windowId: { type: 'number', description: 'Window ID for the final save (optional).' },
      },
      required: ['recipe_id', 'step'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_RECIPE.SET_EXTENDED_SCHEMA,
    description:
      'Set an explicit `extended_input_schema` or `extended_output_schema` array on a Workato recipe step. ' +
      'This centralizes a common silent-strip risk when structured inputs or referenced outputs require schema metadata. ' +
      'This first version accepts only an explicit schema array; it does not infer schemas automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'Numeric Workato recipe id.' },
        step: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Target step number or `as` anchor.',
        },
        kind: {
          type: 'string',
          enum: ['extended_input_schema', 'extended_output_schema'],
          description: 'Schema property to replace on the target step.',
        },
        schema: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'Full Workato schema array to write. Each entry is preserved as provided.',
        },
        restart_if_running: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: stop a running recipe, save, restart. Already-stopped recipes stay stopped.',
          default: false,
        },
        ensure_running: {
          type: 'boolean',
          description: 'Forwarded to the underlying save: start the recipe afterwards.',
          default: false,
        },
        comment: {
          type: 'string',
          description: 'Forwarded to the underlying save: version comment for the new version.',
        },
        expected_base_version_no: {
          type: 'number',
          description:
            'Optimistic lock forwarded to the save. Defaults to the version_no this call just pulled.',
        },
        verify_readback: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: read the stored tree back and fail when Workato silently dropped input keys (default true).',
          default: true,
        },
        tabId: { type: 'number', description: 'Target tab ID for the final save (optional).' },
        windowId: { type: 'number', description: 'Window ID for the final save (optional).' },
      },
      required: ['recipe_id', 'step', 'kind', 'schema'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_RECIPE.APPLY,
    description:
      'Several recipe edits in ONE pull-validate-save-readback cycle: many mappings become one ' +
      'version instead of one version per field. THE tool for more than a single edit, and the ' +
      'only one with structural operations. Ops: set_input, delete_input, set_extended_schema, ' +
      'set_py_eval_code, map_datapill, insert_step, remove_step, move_step, set_loop_source, ' +
      'bind_connection, derive_schema. Steps are addressed by number, `as` anchor, or uuid; a duplicated number ' +
      'in a corrupted tree is refused rather than guessed. Changes are applied to a clone and ' +
      'validated locally first (numbering globally sequential including nested blocks, unique ' +
      '8-hex `as`, uuid on new nodes, else/elsif last inside if.block, catch last inside ' +
      'try.block, foreach source at the node root, while_condition first in a repeat): one ' +
      'invalid operation refuses the WHOLE batch before anything is written, naming the change ' +
      'index and the reason. The config is merged, never rebuilt, so existing account_id ' +
      'bindings survive; a provider new to the recipe gets an entry, with account_id only when ' +
      'connection_id is given (otherwise the response reports connection_binding: missing). ' +
      'dry_run returns the same summary with nothing saved. The response reports persisted, ' +
      'valid and verified separately, plus changed_paths and version_no. ' +
      'Requires a logged-in Workato browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'Numeric Workato recipe id.' },
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          description:
            'Operations, applied in order to one pulled tree and saved as one version. ' +
            'An empty array is refused; the cap is 50.',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['op'],
            properties: {
              op: {
                type: 'string',
                enum: [
                  'set_input',
                  'delete_input',
                  'set_extended_schema',
                  'set_py_eval_code',
                  'map_datapill',
                  'insert_step',
                  'remove_step',
                  'move_step',
                  'set_loop_source',
                  'bind_connection',
                  'derive_schema',
                ],
                description: 'Which operation this entry performs.',
              },
              step: {
                oneOf: [{ type: 'string' }, { type: 'number' }],
                description:
                  'Target step: number (0 = trigger), `as` anchor, or uuid. Required by every op except insert_step and bind_connection.',
              },
              path: {
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
                ],
                description:
                  'set_input / delete_input / map_datapill: input path, e.g. `filters[0].field_id`.',
              },
              value: {
                description: 'set_input: the value to write (any JSON value for a literal).',
              },
              value_kind: {
                type: 'string',
                enum: ['literal', 'datapill', 'formula', 'interpolated'],
                description: 'set_input: how to encode value. Default literal.',
              },
              kind: {
                type: 'string',
                enum: ['extended_input_schema', 'extended_output_schema'],
                description: 'set_extended_schema: which schema property to replace.',
              },
              schema: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description: 'set_extended_schema: the full schema array to write.',
              },
              code: { type: 'string', description: 'set_py_eval_code: the Python source.' },
              validate_step: {
                type: 'boolean',
                description: 'set_py_eval_code: false skips the py_eval provider/name check.',
              },
              source_step: {
                oneOf: [{ type: 'string' }, { type: 'number' }],
                description: 'map_datapill: the step whose output is referenced.',
              },
              source_path: {
                type: 'array',
                items: {
                  oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }],
                },
                description:
                  'map_datapill: path into the source output. "rows[]" expands to the current item, "rows#size" to the count; raw path objects pass through.',
              },
              mode: {
                type: 'string',
                enum: ['formula', 'interpolated'],
                description:
                  'map_datapill: `=_dp(...)` (formula) or `#{_dp(...)}` (interpolated, default).',
              },
              keyword: {
                type: 'string',
                enum: ['action', 'if', 'foreach', 'repeat', 'try', 'stop'],
                description:
                  'insert_step: node shape. Default action. repeat gets a while_condition first child and try gets a trailing catch automatically.',
              },
              provider: {
                type: 'string',
                description:
                  'insert_step (action) / bind_connection: technical adapter name, e.g. `logger`, `salesforce`.',
              },
              action_name: {
                type: 'string',
                description:
                  'insert_step (action): action name within the provider, becomes step.name.',
              },
              input: {
                type: 'object',
                description: 'insert_step: initial step.input. Default {}.',
              },
              connection_id: {
                description:
                  'insert_step / bind_connection: connection id written as account_id in the config entry. null clears it.',
              },
              extended_input_schema: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description: 'insert_step: extended_input_schema for structured inputs.',
              },
              extended_output_schema: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description:
                  'insert_step: extended_output_schema when downstream pills read this step.',
              },
              title: { type: 'string', description: 'insert_step: optional step title.' },
              as: {
                type: 'string',
                description: 'insert_step: explicit 8-hex `as` anchor. Generated when omitted.',
              },
              anchor: {
                type: 'object',
                description:
                  'insert_step / move_step: where the step goes. Defaults to the end of the trigger block.',
                properties: {
                  mode: {
                    type: 'string',
                    enum: ['after', 'before', 'into'],
                    description: 'Placement relative to `step`. Default into.',
                  },
                  step: {
                    oneOf: [{ type: 'string' }, { type: 'number' }],
                    description: 'Anchor step: number, `as`, or uuid. 0 is the trigger.',
                  },
                  position: {
                    type: 'string',
                    enum: ['first', 'last'],
                    description: 'For mode into: first or last child of that block. Default last.',
                  },
                },
              },
              source: {
                description:
                  'insert_step (foreach) / set_loop_source: list datapill (object or `provider.line.path` shorthand) written at the node root, never under input.',
              },
              source_kind: {
                type: 'string',
                enum: ['datapill', 'formula', 'interpolated', 'literal'],
                description: 'How to encode source. Inferred when omitted.',
              },
              repeat_mode: {
                type: 'string',
                enum: ['simple', 'batch'],
                description: 'foreach mode.',
              },
              batch_size: {
                oneOf: [{ type: 'string' }, { type: 'number' }],
                description: 'foreach batch size (stored as a string).',
              },
              clear_scope: {
                type: 'string',
                description: 'foreach clear_scope, "true" or "false".',
              },
              force: {
                type: 'boolean',
                description:
                  'remove_step: remove even though other steps reference its datapills. Default false.',
              },
            },
          },
        },
        expected_base_version_no: {
          type: 'number',
          description:
            'Optimistic lock forwarded to the save. Defaults to the version_no this call just pulled, so concurrent edits are refused automatically.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'Validate and report changed_paths and would_save_version without saving anything.',
          default: false,
        },
        idempotency_key: {
          type: 'string',
          description:
            'Caller-chosen key. A repeat of the same key on the same recipe returns the stored summary instead of saving again (kept in bridge memory only).',
        },
        comment: {
          type: 'string',
          description: 'Forwarded to the underlying save: version comment for the new version.',
        },
        restart_if_running: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: stop a running recipe, save, restart. Already-stopped recipes stay stopped.',
          default: false,
        },
        ensure_running: {
          type: 'boolean',
          description: 'Forwarded to the underlying save: start the recipe afterwards.',
          default: false,
        },
        verify_readback: {
          type: 'boolean',
          description:
            'Forwarded to the underlying save: read the stored tree back and fail when Workato silently dropped input keys (default true).',
          default: true,
        },
        auto_schema: {
          type: 'boolean',
          description:
            "Derive the extended schemas the recipe's own declarations imply (Variables steps, clock trigger) so a structured input is not silently dropped on save. Default true.",
          default: true,
        },
        tabId: { type: 'number', description: 'Target tab ID for the pull and save (optional).' },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['recipe_id', 'changes'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_RECIPE.VALIDATE,
    description:
      'Check a recipe locally WITHOUT saving. Workato has no validate-without-save endpoint, so ' +
      'the only way to learn a tree was wrong was to save it and read code_errors, at the cost of ' +
      'a version. Checks: structure (globally sequential numbering, unique 8-hex `as`, uuid ' +
      'present, else/elsif last in an if block, catch last in try, while_condition first in ' +
      'repeat, foreach source at the node root); bindings (every connection-backed provider has a ' +
      'config entry with an account_id, the gap Workato reports only at start time as ' +
      '"account_id cannot be blank"); datapills (every _dp reference and Variables `<uuid>:<as>` ' +
      'composite points at a step that exists and runs earlier, reported with the step and the ' +
      'exact path); schemas (structured input with no extended_input_schema, a datapill target ' +
      'with no extended_output_schema) plus a preview of the schemas auto_schema would derive. ' +
      'NOT covered: formulas are Ruby and are not parsed, and nothing is executed, so a valid ' +
      'result is not proof the recipe runs. Source: recipe_id pulls the saved recipe, code_path ' +
      'reads a pulled file, code validates a tree before you save it. Never writes.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: {
          type: 'number',
          description:
            'Recipe to pull and validate. With code or code_path it is metadata only and nothing is pulled.',
        },
        code_path: {
          type: 'string',
          description:
            'Local recipe file from workato_pull_recipe(out_file), or a bare code tree. Its config is used when config is not given.',
        },
        code: {
          type: 'object',
          description:
            'Recipe code tree (the trigger object with its nested block) to validate as is.',
        },
        config: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Recipe config array for the binding check. Defaults to the pulled or file config; without one, bindings are reported as unchecked.',
        },
        tabId: { type: 'number', description: 'Target tab ID for the pull (optional).' },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.TABLES_LIST,
    description:
      'List all Workato lookup tables visible to the signed-in user (GET /lookup_tables.json). ' +
      'Returns {headline, items: [{id, name, entry_count, updated_at}]}. ' +
      'Requires an open logged-in Workato tab (uses the session pinned tab or first Workato app tab, never whatever tab is focused).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.TABLE_GET,
    description:
      'Fetch a single lookup table with its columns and rows (GET /lookup_tables/<id>.json). ' +
      'Internally maps col1..col10 to the user-facing column labels, so the response is keyed by label. ' +
      'Returns {id, name, columns: [{name: label, position: 1..10}], rows: [{id, ...by-label}], total_count, page, per_page}. ' +
      'Supports pagination (page, per_page) and a server-side full-text filter (qterm). ' +
      'Lookup tables have at most 10 columns. Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'number', description: 'Numeric lookup-table id.' },
        page: { type: 'number', description: 'Page number (1-based). Optional.' },
        per_page: { type: 'number', description: 'Rows per page. Optional.' },
        qterm: {
          type: 'string',
          description: 'Server-side full-text filter applied to rows. Optional.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.TABLE_CREATE,
    description:
      'Create a new lookup table (POST /lookup_tables.json), then optionally rename and apply a column schema. ' +
      'If `name` is provided, a PUT /lookup_tables/<id>.json sets the name. ' +
      'If `columns` is provided (1-10 user-facing labels), a PUT /lookup_tables/<id>/update_schema.json applies them, ' +
      'padding the remaining slots with placeholders. Returns {table_id, name, columns}. ' +
      'Lookup tables always have exactly 10 column slots internally. ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'New table name. Defaults to "Untitled lookup table".',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional initial column labels (1-10). Each becomes the user-facing name for col1..colN; remaining slots are padded with placeholders.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.TABLE_RENAME,
    description:
      'Rename an existing lookup table (PUT /lookup_tables/<id>.json with {name}). Returns {id, name}. ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'number', description: 'Numeric lookup-table id.' },
        name: { type: 'string', description: 'New name (non-empty).' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'name'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.TABLE_SET_COLUMNS,
    description:
      "Replace a lookup table's column schema (PUT /lookup_tables/<id>/update_schema.json). " +
      'Accepts 1-10 user-facing column labels; internally builds the full 10-slot schema by padding with ' +
      '"Untitled column N" placeholders (sticky=false). Returns {table_id, columns}. ' +
      'Lookup tables have a fixed 10-column limit. ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'number', description: 'Numeric lookup-table id.' },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description:
            '1-10 user-facing column labels. The first N slots are named; the rest are padded with placeholders.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'columns'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.TABLE_DELETE,
    description:
      'Delete a lookup table (DELETE /lookup_tables/<id>.json). Returns {table_id, deleted: true}. ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'number', description: 'Numeric lookup-table id.' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.ROW_CREATE,
    description:
      'Add a row to a lookup table (POST /lookup_tables/<id>/add_row.json). ' +
      "Accepts `row` keyed by the table's user-facing column labels; internally fetches the table once to " +
      'learn the label→col1..col10 mapping, then builds the full 10-key data object (missing columns are null). ' +
      'Returns {table_id, row_id, row} where `row` is keyed by label. ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'number', description: 'Numeric lookup-table id.' },
        row: {
          type: 'object',
          description:
            'Row values keyed by user-facing column label (e.g. {"Email": "a@b", "Country": "US"}). Missing columns are sent as null. Only labels that match the table\'s schema are kept.',
          additionalProperties: true,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'row'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.ROW_UPDATE,
    description:
      'Update an existing row in a lookup table (PUT /lookup_tables/<id>/update_row.json). ' +
      'Accepts a partial `row` keyed by label; the tool fetches the existing row, merges the provided fields ' +
      'over it, and writes the full 10-key data object back (Workato requires all col1..col10 in update payloads). ' +
      'Returns {table_id, row_id, row} keyed by label. ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'number', description: 'Numeric lookup-table id.' },
        row_id: { type: 'number', description: 'Numeric row id (from a prior get/search).' },
        row: {
          type: 'object',
          description:
            'Partial row keyed by user-facing column label. Only provided labels are overwritten; the rest are preserved from the current row.',
          additionalProperties: true,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'row_id', 'row'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.ROW_DELETE,
    description:
      'Delete a row from a lookup table (DELETE /lookup_tables/<id>/delete_row.json?row_id=<row_id>). ' +
      'Returns {table_id, row_id, deleted: true}. ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'number', description: 'Numeric lookup-table id.' },
        row_id: { type: 'number', description: 'Numeric row id.' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'row_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.ROW_UPSERT,
    description:
      'Create-or-update one lookup-table row, keyed by a column value. The tool for ' +
      'per-environment config: lookup tables do not carry across dev/test/prod, so the same ' +
      'keyed rows get re-applied on every deploy, and doing that with row_create plus a manual ' +
      'search is how duplicate keys appear. A duplicate is not harmless: the `lookup()` formula ' +
      'returns the FIRST match, so a stale row silently wins. ' +
      'Searches the whole table (all pages) for rows whose key_column equals key_value: none ' +
      'creates, exactly one updates (merging, so columns you do not name keep their values), ' +
      'and MORE THAN ONE IS REFUSED with the offending row ids rather than picking one. ' +
      'Returns {table_id, row_id, action:"created"|"updated", changed_columns, row}.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'number', description: 'Numeric lookup-table id.' },
        key_column: {
          type: 'string',
          description: 'Column LABEL whose value identifies the row, e.g. "Key".',
        },
        key_value: {
          type: ['string', 'number', 'boolean'],
          description:
            'Value to match in key_column. Compared exactly, as a string; lookup tables are ' +
            'case-sensitive.',
        },
        values: {
          type: 'object',
          description:
            'Column-label-keyed values to write, e.g. {"Value":"true","Notes":"set 2026-08-26"}. ' +
            'Columns not named here keep their current value. The key column is written for you.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'key_column', 'key_value'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.ROW_SEARCH,
    description:
      'Server-side text search across rows of a lookup table (GET /lookup_tables/<id>.json?qterm=...). ' +
      'Returns the same shape as workato_lookup_table_get: {id, name, columns, rows, total_count, page, per_page} ' +
      'with rows keyed by user-facing column label. Supports optional page / per_page pagination. ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'number', description: 'Numeric lookup-table id.' },
        qterm: { type: 'string', description: 'Server-side full-text query.' },
        page: { type: 'number', description: 'Page number (1-based). Optional.' },
        per_page: { type: 'number', description: 'Rows per page. Optional.' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'qterm'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LOOKUP.IMPORT_CSV,
    description:
      'Bulk-import rows into a Workato Lookup Table from a CSV file (PUT /lookup_tables/<id>/upload.json, multipart). ' +
      'TWO WAYS to provide the CSV, **prefer `csv_path` for files on disk** so the file content stays out of agent context: ' +
      '(1) `csv_path`: absolute path on the bridge host; the bridge reads the file via GET /file and streams it. ' +
      '(2) `csv_content`: inline CSV string for ad-hoc small imports. ' +
      'Two modes: ' +
      '`mode="append"` (DEFAULT, safe) preserves existing rows and adds the CSV rows after them. ' +
      '`mode="replace"` wipes all existing rows first, then inserts. ' +
      'If your CSV has a header row, set `skip_first_row=true` so it is not imported as data. ' +
      'Column order in the CSV is positional (maps to col1, col2, ...). ' +
      'Limits: up to 10 columns and 100,000 rows per table. ' +
      'Returns {table_id, name, entry_count, columns, first_rows} where first_rows is a label-keyed preview (~20 rows). ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'number', description: 'Numeric lookup-table id.' },
        csv_path: {
          type: 'string',
          description:
            'Absolute file path on the BRIDGE HOST (the machine running the native-server). The bridge reads the file via GET /file and streams content, so the agent never materializes it in context. Mutually exclusive with csv_content.',
        },
        csv_content: {
          type: 'string',
          description:
            'Inline CSV string (alternative to csv_path). Use only for small ad-hoc imports; large files will bloat agent context. Cells with commas/quotes must be RFC-4180-quoted.',
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace'],
          description:
            'Import mode. `append` (default) preserves existing rows; `replace` wipes them first. Use replace deliberately: it is destructive.',
        },
        skip_first_row: {
          type: 'boolean',
          description:
            'When true, skips the first row of the CSV (treats it as a header). Default false, so every row is imported. Set to true when your CSV starts with column names like "name,color".',
        },
        filename: {
          type: 'string',
          description:
            'Optional filename to send in the multipart part. Defaults to "data.csv" or, when csv_path is used, the basename of the path.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.TABLES_LIST,
    description:
      'List Workato Data Tables in a project folder (GET /web_api/mixed_assets.json filtered to data-table assets). ' +
      'Data Tables are the newer relational store (distinct from the older Lookup Tables at /lookup_tables/). ' +
      'Returns {tables: [{id, name, folder_id, total_entries_count, updated_at}], page, per_page, count, folder_id}. ' +
      'If folder_id is omitted, the tool falls back to the folder visible in the current Workato URL (best-effort). ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: {
          type: 'number',
          description:
            'Numeric folder id to list data tables under. Optional; falls back to the folder in the current URL when possible.',
        },
        page: { type: 'number', description: 'Page number (1-based). Optional.' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.TABLE_GET,
    description:
      'Fetch a Data Table with its columns (GET /web_api/workato_db/tables/<id>.json). ' +
      'Returns {id, name, table_id_uuid, folder_id, columns: [{name, type, id, hidden, read_only}], total_entries_count}. ' +
      'System columns (Record ID, Created time, Last modified time) are hidden by default; pass include_system=true to include them.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data Table id (UUID string).' },
        include_system: {
          type: 'boolean',
          description:
            'When true, also returns the 3 system columns (Record ID, Created time, Last modified time). Default false.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.TABLE_CREATE,
    description:
      'Create a new Data Table (POST /web_api/workato_db/tables.json) and optionally add user columns via a follow-up schema PUT. ' +
      'The server auto-seeds 3 system columns (Record ID, Created time, Last modified time); when `columns` is provided, the tool GETs ' +
      'the new table, appends the user columns (only {type,title} needed), and PUTs the full schema back. ' +
      'Column types: short-text, long-text, integer, decimal, boolean, date, date-time, file, multi-value, link-to-table. ' +
      'Returns {table_id, name, folder_id, columns}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'New data-table name (non-empty).' },
        folder_id: { type: 'number', description: 'Numeric folder id to create the table under.' },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Column title.' },
              type: {
                type: 'string',
                description:
                  'Column type: short-text (default), long-text, integer, decimal, boolean, date, date-time, file, multi-value, link-to-table.',
              },
            },
            required: ['name'],
          },
          description: 'Optional user columns to create after the table is provisioned.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['name', 'folder_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.TABLE_RENAME,
    description:
      'Rename a Data Table (PUT /web_api/workato_db/tables/<id>.json with {name}). Returns {table_id, name}.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data Table id (UUID string).' },
        name: { type: 'string', description: 'New name (non-empty).' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'name'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.TABLE_DELETE,
    description:
      'Delete a Data Table (DELETE /web_api/workato_db/tables/<id>.json). Returns {table_id, deleted: true}.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data Table id (UUID string).' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.ADD_COLUMN,
    description:
      'Append a column to a Data Table by GETting the current schema, appending the new entry, and PUTting the full schema back. ' +
      'Default type is short-text. Returns {table_id, column_id, name, type}.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data Table id (UUID string).' },
        name: { type: 'string', description: 'New column title (non-empty).' },
        type: {
          type: 'string',
          description:
            'Column type: short-text (default), long-text, integer, decimal, boolean, date, date-time, file, multi-value, link-to-table.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'name'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.UPDATE_COLUMN,
    description:
      'Rename and/or retype an existing user column (full-schema PUT). Identify the column by column_name OR column_id. ' +
      'At least one of `name` or `type` must be provided. System columns are protected. Returns {table_id, column_id, name, type}.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data Table id (UUID string).' },
        column_name: {
          type: 'string',
          description: 'Existing column title to update (provide this OR column_id).',
        },
        column_id: {
          type: 'string',
          description: 'Existing column UUID to update (provide this OR column_name).',
        },
        name: { type: 'string', description: 'New column title. Optional.' },
        type: {
          type: 'string',
          description:
            'New column type. Optional. Must be one of: short-text, long-text, integer, decimal, boolean, date, date-time, file, multi-value, link-to-table.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.DELETE_COLUMN,
    description:
      'Delete a user column from a Data Table (full-schema PUT omitting the column). Identify by column_name OR column_id. ' +
      'Refuses to delete the 3 system columns (Record ID, Created time, Last modified time). Returns {table_id, column_id, deleted: true}.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data Table id (UUID string).' },
        column_name: {
          type: 'string',
          description: 'Existing column title to delete (provide this OR column_id).',
        },
        column_id: {
          type: 'string',
          description: 'Existing column UUID to delete (provide this OR column_name).',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.ROW_LIST,
    description:
      'Query rows in a Data Table (POST /web_api/workato_db/tables/<id>/records/query.json). ' +
      'Supports order_by_column (user-facing label, default "Created time"), direction (asc|desc, default desc), ' +
      'limit (default 100), and continuation_token for pagination. Returns rows keyed by user-facing column label ' +
      '(plus a `Record ID` field carrying the row UUID).',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data Table id (UUID string).' },
        order_by_column: {
          type: 'string',
          description: 'Column title to sort by. Defaults to "Created time".',
        },
        direction: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort direction. Default desc.',
        },
        limit: { type: 'number', description: 'Max rows to return. Default 100.' },
        continuation_token: {
          type: 'string',
          description: 'Opaque cursor returned by a prior page. Optional.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.ROW_CREATE,
    description:
      'Insert a row into a Data Table (POST /web_api/workato_db/tables/<id>/records.json). ' +
      "Accepts `row` keyed by the table's user-facing column labels; the tool fetches the schema to resolve " +
      'label->UUID, then sends a UUID-keyed body. Returns {table_id, record_id, row} where `row` is label-keyed.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data Table id (UUID string).' },
        row: {
          type: 'object',
          description:
            'Row values keyed by user-facing column label. Only labels matching the table schema are sent.',
          additionalProperties: true,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'row'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.ROW_UPDATE,
    description:
      'Update a row in a Data Table (PUT /web_api/workato_db/tables/<id>/records/<record_id>.json). ' +
      'Accepts a partial label-keyed `row`; only provided fields are sent (UUID-keyed). ' +
      'Returns {table_id, record_id, row}. NOTE: endpoint is inferred; verify on smoke test.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data Table id (UUID string).' },
        record_id: {
          type: 'string',
          description: 'Row UUID (the "Record ID" value of the target row).',
        },
        row: {
          type: 'object',
          description:
            'Partial row keyed by user-facing column label. Only provided labels are updated.',
          additionalProperties: true,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'record_id', 'row'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_DATA_TABLE.ROW_DELETE,
    description:
      'Delete one or more rows from a Data Table (POST /web_api/workato_db/tables/<id>/records/delete_batch.json). ' +
      'Accepts a single record id (string) or an array of ids. Returns {table_id, record_ids, deleted: true}.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Data Table id (UUID string).' },
        record_ids: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Row UUID, or array of row UUIDs, to delete.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
      required: ['table_id', 'record_ids'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_SESSION.WHOAMI,
    description:
      'Returns who/where the active Workato tab is connected: workspace, user, role, ' +
      'available environments, teams, timezone, membership tier. Fetches /web_api/auth_user.json ' +
      'and slims it down to an agent-friendly JSON shape. ' +
      "Use this FIRST when you don't know which Workato workspace/account/environment " +
      'the agent is currently connected to (especially when the user has multiple ' +
      'Workato accounts open in different tabs). ' +
      'Prerequisite: the active tab must be a logged-in Workato page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        windowId: { type: 'number', description: 'Window ID (when tabId omitted).' },
      },
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_SESSION.SESSION_CONTEXT,
    description:
      'Which Workato tab, host, workspace and environment a call would actually land in: ' +
      '{tab_id, host, workspace_id, workspace_name, environment, user_id}. ' +
      'The cheap identity check: prefer it over workato_whoami whenever you only need to ' +
      'confirm the target workspace/environment; use whoami for the full profile (user, roles, ' +
      'teams, membership, available environments). ' +
      'Cached per tab for 60s and dropped automatically when the tab navigates, so calling it ' +
      'repeatedly is nearly free. ' +
      'Prerequisite: a logged-in Workato app tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
        max_age_ms: {
          type: 'number',
          description: 'Accept a cached context younger than this. Default 60000, max 600000.',
        },
        refresh: {
          type: 'boolean',
          description: 'Ignore the cache and read the tab again.',
          default: false,
        },
      },
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.SWITCH_ENVIRONMENT,
    description:
      'Move the Workato session to another environment (dev, test, prod) and/or another client ' +
      'workspace, the way the app header switchers do: it navigates the tab through ' +
      '/users/switch_team and /users/switch_environment and verifies the result with a fresh ' +
      'auth_user read. The session belongs to the Chrome PROFILE, so EVERY Workato tab in that ' +
      'profile moves; other tabs keep showing their old page until reloaded. Changes no Workato ' +
      'data, so it needs no write flag, but it changes what every later call in this profile ' +
      'reads and writes: switch back when done. environment takes dev|development, test, ' +
      'prod|production, an exact environment name, or an id; workspace takes an exact name, a ' +
      'unique part of one, or an id, from the workspaces this user belongs to (ambiguous input ' +
      'is refused with the candidates). With both, the workspace switches first and the ' +
      'environment is resolved inside it. return_to lands the tab on an app path after an ' +
      'environment switch. Returns {changed, before, after:{workspace_id, workspace_name, ' +
      'environment, environment_id, environment_type}, tab_id, landed_url}; changed:false means ' +
      'it was already there. A pinned MCP session on this profile follows the switch. Use ' +
      'workato_whoami for the list of environments and workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        environment: {
          type: ['string', 'number'],
          description: 'Target environment: dev, test, prod, an environment name or id.',
        },
        workspace: {
          type: ['string', 'number'],
          description: 'Target client workspace: its name (or a unique part of it) or id.',
        },
        return_to: {
          type: 'string',
          description:
            'App path to land on after an environment switch, starting with "/", e.g. "/recipes/123".',
        },
        tabId: {
          type: 'number',
          description:
            'Workato tab to navigate. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.DEPLOYMENTS_LIST,
    description:
      "A project's deployment history and where it can deploy to. Resolves the project from " +
      'recipe_id, folder_id or project (name or project_id), then returns deployable_environments ' +
      '[{id, name, type}] and one page of deployments: id, deployment_id, title, state ' +
      '(deploy_finished, deploy_failed, ...), error, environment name/type/id, created_at, ' +
      'updated_at, performed_by, zip_file_name, plus page/per_page/count/total. Abandoned drafts ' +
      '(a plan that was never run) are not listed there. Read only. Run it from the SOURCE ' +
      'environment tab, where the project is developed.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'A recipe of the project.' },
        folder_id: { type: 'number', description: 'Any folder of the project, root or nested.' },
        project: {
          type: ['string', 'number'],
          description: 'Project name (exact, case-insensitive) or project_id.',
        },
        page: { type: 'number', description: 'Page of the history, 1-based. Default 1.' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: [],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.DEPLOY_PLAN,
    description:
      'Step 1 of a deployment: what would change in the target environment, before anything is ' +
      'deployed. Run from the SOURCE environment tab (usually Development); a target equal to the ' +
      'tab environment is refused. Opens a deployment draft (a server object that changes nothing ' +
      'in either environment; an unused draft lingers and is not listed in the history), selects ' +
      'the assets, and waits for Workato to calculate the diff. With recipe_id the default ' +
      'selection is the recipe plus the project assets it depends on, transitively (the recipe ' +
      'page "Deploy to" button); a recipe that calls it is not included. assets:"all" takes the ' +
      'whole project; include/exclude toggle source asset ids. Returns deployment_id, summary ' +
      '{added, updated, unchanged}, assets [{name, type, source_id, target_id, state, changes, ' +
      'running}], not_included, will_stop (changed recipes running in the target: the run stops ' +
      'and restarts them) and step_diffs per changed recipe: steps_changed with field diffs (code ' +
      'as a unified diff, target now vs source), steps_added, steps_removed, and remaps: ids that ' +
      'only differ because each environment has its own copy (data table, called recipe, lookup ' +
      'table), which are not changes. Then call workato_deploy_run with the deployment_id.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'number', description: 'Deploy this recipe (and its dependencies).' },
        folder_id: { type: 'number', description: 'A folder of the project to deploy.' },
        project: {
          type: ['string', 'number'],
          description: 'Project name (exact, case-insensitive) or project_id.',
        },
        environment: {
          type: ['string', 'number'],
          description: 'TARGET environment: test, prod, an environment name or id.',
        },
        assets: {
          type: 'string',
          enum: ['recipe_with_deps', 'all'],
          description:
            'recipe_with_deps (default with recipe_id) or all (default with folder_id/project).',
        },
        include: {
          type: 'array',
          items: { type: 'number' },
          description: 'Source asset ids to add to the selection.',
        },
        exclude: {
          type: 'array',
          items: { type: 'number' },
          description: 'Source asset ids to leave out; wins over include.',
        },
        include_step_diff: {
          type: 'boolean',
          description: 'Fetch the step-level diff of each changed recipe. Default true.',
          default: true,
        },
        include_tags: {
          type: 'boolean',
          description: 'Deploy asset tags too, as the UI does. Default true.',
          default: true,
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['environment'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.DEPLOY_RUN,
    description:
      'Step 2 of a deployment: deploy a plan from workato_deploy_plan to its target environment. ' +
      'WRITES TO THE TARGET (often production): requires allow_writes:true, and only after the ' +
      'plan was reviewed. Sets the deployment title (required; the target history shows it, keep ' +
      'it neutral), starts the deploy and polls until it finishes. When the target has running ' +
      'recipes the deployment changes, Workato refuses until they may be stopped: without ' +
      'allow_stop_running:true the call returns status "needs_stop" with recipes_to_stop and ' +
      'nothing changed; with it, Workato stops them, deploys and restarts them (recipes with jobs ' +
      'in progress cannot be stopped). Returns state (deploy_finished or the failure verbatim), ' +
      'changed_assets, imported_recipes_status {stopped, restarted, failed, stop_failed} and ' +
      'zip_file_name. Idempotent: calling it again on a deployment in flight only polls, and on a ' +
      'finished one only reports; title is ignored once the deploy has started. On timeout or ' +
      'wait:false it returns the current state; call again to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'number', description: 'deployment_id from workato_deploy_plan.' },
        title: {
          type: 'string',
          description: 'Deployment name shown in the target history. Required, non-empty.',
        },
        description: { type: 'string', description: 'Optional deployment description.' },
        allow_writes: {
          type: 'boolean',
          description: 'Required (true): this deploys to the target environment. Default false.',
          default: false,
        },
        allow_stop_running: {
          type: 'boolean',
          description:
            'Let Workato stop the running target recipes the deployment changes, then restart them. Default false.',
          default: false,
        },
        wait: {
          type: 'boolean',
          description: 'Poll until the deploy finishes. Default true.',
          default: true,
        },
        timeout_ms: {
          type: 'number',
          description: 'How long to poll in this call. Default 90000, max 110000.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab.',
        },
      },
      required: ['deployment_id', 'title', 'allow_writes'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LCAP.APPS_LIST,
    description:
      'List the Workflow Apps (LCAP) in the current workspace. Returns {app_count, apps: [{id, ' +
      'name, project_id, unique_id, live}]}. Read-only. There is no endpoint that lists the PAGES in an app - page ids come from ' +
      "the builder URL (app.workato.com/lcap/pages/<id>) or the project's asset view. Requires " +
      'an open Workato tab in the right workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab. Pass ' +
            'this together with `profile` - an omitted profile resolves against the default ' +
            'Chrome profile and reports "Tab not found" for a tab that exists.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 30000, clamped 10000-110000.',
        },
      },
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LCAP.PAGE_GET,
    description:
      'Read a Workflow App page. Read-only. Returns page metadata (name, path, folder, ' +
      'updated_at, page variables, pageLoad handler) plus a widget INDEX: one row per widget ' +
      'with id, type, name, x, width, row, owning container, which handler slots are wired, the ' +
      'bound app-function recipe id, and whether `visible` is conditional. The index is the ' +
      'default because a real page is 6 KB+ of JSON and most reads only need to know what is on ' +
      "the page. Pass view:'full' for the raw `content` tree, or out_file to write " +
      '{page_id, updated_at, content} to disk and keep the tree out of the context entirely - ' +
      'edit that file and push it back with workato_lcap_page_save(content_path). Save the ' +
      'returned updated_at and pass it as expected_updated_at when you save.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: {
          type: 'number',
          description:
            'Numeric page id, from the builder URL app.workato.com/lcap/pages/<page_id>.',
        },
        view: {
          type: 'string',
          enum: ['index', 'full'],
          description:
            "'index' (default) returns metadata plus the widget index. 'full' adds the raw " +
            'content tree.',
        },
        out_file: {
          type: 'string',
          description:
            'Absolute path to write {page_id, updated_at, content} as JSON. The tree never ' +
            'enters the response; the widget index still does.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab. Pass ' +
            'this together with `profile` - an omitted profile resolves against the default ' +
            'Chrome profile and reports "Tab not found" for a tab that exists.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 30000, clamped 10000-110000.',
        },
      },
      required: ['page_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LCAP.PAGE_SAVE,
    description:
      "Replace a Workflow App page's content tree (PUT is whole-tree; there is no partial " +
      'update). WRITE. Guards, all of them earned: (1) refuses while the page builder is open ' +
      "on that page, because the builder's Save overwrites with its cached tree - the symptom " +
      'is "saved fine, changes vanished"; (2) refuses when a widget id present in the stored ' +
      'page is missing from yours (ids are the address datapills use) unless ' +
      'allow_widget_removal; (3) refuses a row collapse - removing a widget without renumbering ' +
      "the rows of what remains drops the following containers' computed `top` so they all " +
      'stack at 0, while the JSON reads back perfectly - unless allow_row_collapse; (4) allows ' +
      'moving widgets onto one row (fields side by side is ordinary layout work), warning only ' +
      'when the merged widths sum past the 12 column grid - the renderer stacks those rather ' +
      'than overlapping them, so it is a "did you mean that", not a refusal; (5) refuses ' +
      'an unknown `visible` opcode or wrong arity (opcodes are 1-14, 1-10 binary, 11-14 unary); ' +
      '(6) refuses a _dp() payload that is not valid JSON, and compacts the ones that are; ' +
      '(7) after the PUT it opens the page in a background tab and checks the RENDERED geometry, ' +
      'reporting render_check passed/failed - the JSON is valid in the stacking failure, so ' +
      'this is the only real proof. Pass expected_updated_at (from page_get) for optimistic ' +
      'locking.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'number', description: 'Numeric page id.' },
        content: {
          type: 'object',
          description:
            'The complete replacement content tree: {type,maxWidth,spacing,background,variables,' +
            'handlers,layout}. Provide this OR content_path.',
        },
        content_path: {
          type: 'string',
          description:
            'Absolute path to a JSON file holding the tree, or a {content:...} envelope as ' +
            'written by workato_lcap_page_get(out_file). Resolved in the native-server, so the ' +
            'tree never passes through the tool call.',
        },
        expected_updated_at: {
          type: 'string',
          description:
            "Optimistic lock: refuse if the stored page's updated_at differs. Pass the value " +
            'workato_lcap_page_get returned.',
        },
        allow_widget_removal: {
          type: 'boolean',
          description:
            'Permit widgets present in the stored page to be absent from this tree. Only when ' +
            'the deletion is intended: every datapill pointing at a removed id resolves empty.',
        },
        allow_row_collapse: {
          type: 'boolean',
          description:
            "Permit a layout's row extent to shrink after a removal. Check render_check in the " +
            'response when you use this.',
        },
        force: {
          type: 'boolean',
          description: 'Save even though the page builder is open on this page.',
        },
        skip_render_check: {
          type: 'boolean',
          description:
            'Skip the post-save render probe (it opens and closes a background tab). Only for ' +
            'batched writes where a later save will be checked.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab. Pass ' +
            'this together with `profile` - an omitted profile resolves against the default ' +
            'Chrome profile and reports "Tab not found" for a tab that exists.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 30000, clamped 10000-110000.',
        },
      },
      required: ['page_id'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LCAP.PAGE_VALIDATE,
    description:
      'Check a Workflow App page without writing anything. Read-only. With page_id: runs the ' +
      'static checks over the stored tree AND opens the page in a background tab to check the ' +
      'rendered geometry (every top level widget must carry a `top:`; no two may share a ' +
      'bounding-box y). With content (or content_path): static checks only - layout shape, ' +
      'widget id format and duplicates, `visible` opcodes and arity, broken _dp payloads. Use ' +
      'this to diagnose "the page looks wrong but the JSON is fine", which is the signature of ' +
      'the row-collapse bug.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: {
          type: 'number',
          description: 'Validate the stored page (static checks plus the render probe).',
        },
        content: {
          type: 'object',
          description:
            'Validate a tree in hand. With page_id, also diffed against the stored page.',
        },
        content_path: { type: 'string', description: 'Path to a JSON file holding the tree.' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab. Pass ' +
            'this together with `profile` - an omitted profile resolves against the default ' +
            'Chrome profile and reports "Tab not found" for a tab that exists.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 30000, clamped 10000-110000.',
        },
      },
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LCAP.WIDGET_PATCH,
    description:
      'Change presentational properties of ONE widget on a Workflow App page. WRITE, but the ' +
      'safe subset: it reads the page, edits that widget, and saves through the same guards as ' +
      'workato_lcap_page_save (builder-open, id preservation, row integrity, datapills, render ' +
      'check). Allowed: label, hint, placeholder, text, alignment, color, title, description, x, ' +
      'width, displayedRowsCount, allowRowCreation, allowRowDeletion, forbidEmptyRows, ' +
      'addRowButtonText, columnsSettings, options, enabled, style, padding, margin, ' +
      'backgroundColor, borderColor, pillsSupportMarkdown, multiValue, editable, name. REFUSES ' +
      'id, type, handlers, appFunctionOptions, visible, layout, dataSource, validations - those ' +
      'carry bindings or addresses and belong in a reviewed full-tree save. Most polish work is ' +
      'exactly this list, and doing it by rewriting the whole tree is what creates the chance to ' +
      'break the layout.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'number', description: 'Numeric page id.' },
        widget_id: {
          type: 'string',
          description: "The widget's 8-hex id, from the index workato_lcap_page_get returns.",
        },
        props: {
          type: 'object',
          description: 'Properties to overwrite, e.g. {"label":"Post to NetSuite","width":6}.',
        },
        expected_updated_at: {
          type: 'string',
          description: 'Optimistic lock, as in workato_lcap_page_save.',
        },
        force: { type: 'boolean', description: 'Patch even though the builder is open.' },
        skip_render_check: { type: 'boolean', description: 'Skip the post-save render probe.' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab. Pass ' +
            'this together with `profile` - an omitted profile resolves against the default ' +
            'Chrome profile and reports "Tab not found" for a tab that exists.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 30000, clamped 10000-110000.',
        },
      },
      required: ['page_id', 'widget_id', 'props'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LCAP.PAGE_CREATE,
    description:
      'Create a Workflow App page in a folder. WRITE. Defaults to a valid empty page ' +
      '([1] layout) when no content is given, so the usual flow is create then page_save with ' +
      'the real tree. Note Workato regenerates `path` from `name`, so the path you pass is ' +
      'advisory. Returns the new page id and its builder URL.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: {
          type: 'number',
          description: "Numeric id of the Workflow App's folder (its project asset folder).",
        },
        name: { type: 'string', description: 'Page name. Stored verbatim, markdown included.' },
        path: { type: 'string', description: 'Advisory: Workato regenerates it from `name`.' },
        content: {
          type: 'object',
          description: 'Initial content tree. Defaults to an empty page.',
        },
        content_path: { type: 'string', description: 'Path to a JSON file holding the tree.' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab. Pass ' +
            'this together with `profile` - an omitted profile resolves against the default ' +
            'Chrome profile and reports "Tab not found" for a tab that exists.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 30000, clamped 10000-110000.',
        },
      },
      required: ['folder_id', 'name'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO_LCAP.PAGE_DELETE,
    description:
      'Permanently delete a Workflow App page. WRITE, no undo - requires confirm:true, and only ' +
      'call it when the user explicitly asked. A deleted page takes its widget ids with it, so ' +
      'anything bound to them is gone too.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'number', description: 'Numeric page id.' },
        confirm: { type: 'boolean', description: 'Must be exactly true. There is no undo.' },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab. Pass ' +
            'this together with `profile` - an omitted profile resolves against the default ' +
            'Chrome profile and reports "Tab not found" for a tab that exists.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 30000, clamped 10000-110000.',
        },
      },
      required: ['page_id', 'confirm'],
    },
  },
  {
    name: WORKATO_TOOL_NAMES.WORKATO.API_REQUEST,
    description:
      "ESCAPE HATCH: issue an arbitrary request to the Workato app host under the user's " +
      'logged-in session. Use it only for endpoints no dedicated tool covers yet - the ' +
      'dedicated tools carry guards (silent-strip detection, datapill normalization, row ' +
      'integrity, render checks) that this one has none of. Same-origin only: `path` is a path ' +
      'on the Workato host, never a URL elsewhere. Sends x-requested-with automatically and ' +
      'attaches x-csrf-token from the XSRF-TOKEN-V2 cookie on writes; the token is never ' +
      'returned. Anything other than GET/HEAD needs allow_writes:true. A 404 on a /web_api/ ' +
      'path usually means the tab is in the wrong workspace or environment, not that the object ' +
      'is missing.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP method. Default GET.',
        },
        path: {
          type: 'string',
          description:
            'Path on the Workato app host, e.g. "/web_api/lcap/pages/61604.json" or ' +
            '"/integrations/meta". Must start with "/"; an absolute URL is refused.',
        },
        query: {
          type: 'object',
          description: 'Query parameters, appended to the path. Values are stringified.',
        },
        body: {
          description:
            'Request body. An object is JSON-serialized with content-type: application/json; a ' +
            'string is sent verbatim.',
        },
        headers: {
          type: 'object',
          description:
            'Extra request headers, merged over the defaults. x-requested-with cannot be ' +
            'removed - Workato /web_api routes require it.',
        },
        allow_writes: {
          type: 'boolean',
          description: 'Required for POST/PUT/PATCH/DELETE. No endpoint-specific guards run here.',
        },
        out_file: {
          type: 'string',
          description:
            'Absolute path to write the raw response body to. Use it for large responses ' +
            'instead of raising max_bytes.',
        },
        max_bytes: {
          type: 'number',
          description:
            'Response body cap before truncation. Default 20000, clamped 512-200000. A ' +
            'truncated body is returned as text, unparsed, with truncated:true.',
        },
        tabId: {
          type: 'number',
          description:
            'Target Workato tab ID. Omit to use the session pinned tab or first app tab. Pass ' +
            'this together with `profile` - an omitted profile resolves against the default ' +
            'Chrome profile and reports "Tab not found" for a tab that exists.',
        },
        timeout_ms: {
          type: 'number',
          description: 'In-page fetch timeout. Default 30000, clamped 10000-110000.',
        },
      },
      required: ['path'],
    },
  },
];
