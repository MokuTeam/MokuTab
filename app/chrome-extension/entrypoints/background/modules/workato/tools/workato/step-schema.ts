import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';

/**
 * workato_step_schema: generate a step's `extended_input_schema` and
 * `extended_output_schema` instead of writing them by hand.
 *
 * Workato accepts a step without those arrays, reports `code_errors: []`, and
 * then drops structured input on readback (`declare_list.list_items`,
 * `call_recipe.parameters`, the clock trigger's `trigger_every`) or breaks a
 * downstream datapill with "Unknown data field". The recipe editor never writes
 * them by hand either: every time a field changes it POSTs the current input to
 *
 *   /connections/<connection id or adapter slug>/extended_schema.json
 *
 * and stores `result.input` / `result.output` on the step. Verified 2026-09-08:
 * the adapter SLUG works for connectionless adapters (`workato_variable`,
 * `clock`), a numeric connection id for the rest (jira `get_issue` returned a
 * 14 KB issue schema; a custom SDK connector's `run_suiteql` returned its
 * result columns). Nothing is saved by the call itself.
 *
 * Failure shape is HTTP 200 with `{"error": "HTTP status code 420"}` (or
 * `invalid_grant`), never a 4xx. Both Salesforce connections in the probe
 * workspace answered that way while reporting `authorization_status: success`,
 * so this call with an empty input is also the cheap liveness probe for a
 * connection.
 *
 * The editor's toolbar Refresh button fires this endpoint per step and THEN
 * saves the recipe. This tool does not; writing happens only through
 * `apply_to`, which the native server routes through the mutation engine.
 */

interface StepSchemaArgs {
  /** Technical adapter name, e.g. "salesforce", "workato_variable". */
  adapter: string;
  /** Trigger or action name, e.g. "search_sobjects", "declare_list". */
  operation: string;
  /** Numeric connection id. Required when the adapter needs a connection. */
  connection_id?: number;
  /** The step input as it would be saved. Default {}. */
  input?: Record<string, unknown>;
  /** Explicit dynamicPickListSelection. Derived from input when omitted. */
  dynamic_pick_list_selection?: Record<string, unknown>;
  /** Recipe id, forwarded as flow_id. */
  flow_id?: number;
  /** Which schemas to compute. Default both. */
  only?: ('input' | 'output')[];
  /** In-page fetch timeout. Default 45000, clamped 10000..110000. */
  timeout_ms?: number;
  tabId?: number;
}

interface InPageResult {
  ok: boolean;
  result?: { input?: unknown; output?: unknown; title?: unknown; description?: unknown };
  meta_flags?: {
    extends_input_schema?: boolean;
    extends_output_schema?: boolean;
    depends_on?: unknown;
    deprecated?: boolean;
    kind?: 'trigger' | 'action';
  };
  schema_drivers?: string[];
  connection_required?: boolean;
  dynamic_pick_list_selection_used?: Record<string, unknown>;
  url?: string;
  failure?: {
    stage: 'meta' | 'operation' | 'connection' | 'fetch' | 'shape';
    message: string;
    /** The `error` value Workato returned inside a 200, when that is the failure. */
    workato_error?: unknown;
  };
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based.
 * DO NOT add async/await (WXT/Vite rewrites it into a hoisted helper that does
 * not survive Function.prototype.toString; see pull-recipe.ts).
 */
function fetchStepSchemaInPage(
  adapter: string,
  operation: string,
  connectionId: number | null,
  inputJson: string,
  explicitSelectionJson: string | null,
  flowId: number | null,
  only: string[],
): Promise<InPageResult> {
  const headers = { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' };
  const metaUrl = `/integrations/meta?name=${encodeURIComponent(adapter)}`;

  function closest(names: string[], wanted: string): string[] {
    const w = wanted.toLowerCase();
    const scored = names.map((n) => {
      const l = n.toLowerCase();
      let score = 0;
      if (l === w) score = 100;
      else if (l.indexOf(w) >= 0 || w.indexOf(l) >= 0) score = 50;
      else {
        const parts = w.split(/[^a-z0-9]+/).filter((p) => p.length > 2);
        for (let i = 0; i < parts.length; i++) if (l.indexOf(parts[i]) >= 0) score += 10;
      }
      return { n: n, score: score };
    });
    scored.sort((a, b) => b.score - a.score || a.n.localeCompare(b.n));
    return scored
      .filter((s) => s.score > 0)
      .slice(0, 5)
      .map((s) => s.n);
  }

  return fetch(metaUrl, { credentials: 'include', headers: headers }).then((r) =>
    r.text().then((text) => {
      let doc: any = null;
      try {
        doc = JSON.parse(text);
      } catch (e) {
        return {
          ok: false,
          failure: { stage: 'meta' as const, message: `JSON.parse failed on ${metaUrl}` },
        };
      }
      const node = doc && (doc[adapter] || (doc.result && doc.result[adapter]));
      if (!node || typeof node !== 'object') {
        return {
          ok: false,
          failure: {
            stage: 'meta' as const,
            message:
              `Adapter "${adapter}" is not in the meta response (HTTP 200, ${text.length} bytes). ` +
              'Find the technical name with workato_apps_list(query); a custom connector uses ' +
              'its generated name.',
          },
        };
      }
      const actions = node.actions && typeof node.actions === 'object' ? node.actions : {};
      const triggers = node.triggers && typeof node.triggers === 'object' ? node.triggers : {};
      let kind: 'trigger' | 'action' | null = null;
      let op: any = null;
      if (actions[operation]) {
        kind = 'action';
        op = actions[operation];
      } else if (triggers[operation]) {
        kind = 'trigger';
        op = triggers[operation];
      }
      if (!op) {
        const all = Object.keys(actions).concat(Object.keys(triggers));
        const near = closest(all, operation);
        return {
          ok: false,
          failure: {
            stage: 'operation' as const,
            message:
              `No trigger or action named "${operation}" on "${adapter}". ` +
              (near.length > 0 ? `Closest names: ${near.join(', ')}. ` : '') +
              'workato_adapter_meta lists them.',
          },
        };
      }

      const connectionRequired =
        node.config && typeof node.config.required === 'boolean' ? node.config.required : true;
      if (connectionRequired && connectionId === null) {
        return {
          ok: false,
          connection_required: true,
          failure: {
            stage: 'connection' as const,
            message:
              `"${adapter}" needs a connection and none was given. Pass connection_id: find one ` +
              'with workato_apps_list(query) or workato_search_connections(provider). If the ' +
              'workspace has none, stop and ask the user to create it; these tools cannot.',
          },
        };
      }

      const input = JSON.parse(inputJson);
      const drivers: string[] = [];
      const inputFields = Array.isArray(op.input) ? op.input : [];
      const dynamicPick: Record<string, unknown> = {};
      for (let i = 0; i < inputFields.length; i++) {
        const f = inputFields[i];
        if (!f || typeof f !== 'object') continue;
        if (f.extends_schema === true && typeof f.name === 'string') drivers.push(f.name);
        if (
          typeof f.pick_list === 'string' &&
          typeof f.name === 'string' &&
          input &&
          Object.prototype.hasOwnProperty.call(input, f.name)
        ) {
          dynamicPick[f.name] = input[f.name];
        }
        if (
          f.toggle_field &&
          typeof f.toggle_field.name === 'string' &&
          f.toggle_field.extends_schema === true &&
          drivers.indexOf(f.toggle_field.name) < 0
        ) {
          drivers.push(f.toggle_field.name);
        }
      }
      const selection =
        explicitSelectionJson !== null
          ? JSON.parse(explicitSelectionJson)
          : Object.keys(dynamicPick).length > 0
            ? dynamicPick
            : null;

      const token = (document.cookie.match(/XSRF-TOKEN-V2=([^;]+)/) || [])[1];
      if (!token) {
        return {
          ok: false,
          failure: {
            stage: 'fetch' as const,
            message: 'No XSRF-TOKEN-V2 cookie on this tab. Is it logged in?',
          },
        };
      }

      const body: any = { operation_name: operation, input: input, only: only };
      if (flowId !== null) body.flow_id = flowId;
      if (selection) body.dynamic_pick_list_selection = selection;
      const url = `/connections/${connectionId !== null ? connectionId : encodeURIComponent(adapter)}/extended_schema.json`;
      const flags = {
        kind: kind as 'trigger' | 'action',
        extends_input_schema: op.extends_input_schema === true,
        extends_output_schema: op.extends_output_schema === true,
        depends_on: op.depends_on,
        deprecated: op.deprecated === true,
      };

      return fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-requested-with': 'XMLHttpRequest',
          'x-csrf-token': decodeURIComponent(token),
        },
        body: JSON.stringify(body),
      }).then((pr) =>
        pr.text().then((ptext) => {
          let json: any = null;
          try {
            json = JSON.parse(ptext);
          } catch (e) {
            return {
              ok: false,
              url: url,
              meta_flags: flags,
              schema_drivers: drivers,
              connection_required: connectionRequired,
              failure: {
                stage: 'shape' as const,
                message: `HTTP ${pr.status}, JSON.parse failed on the extended_schema response: ${ptext.slice(0, 200)}`,
              },
            };
          }
          if (pr.status < 200 || pr.status >= 300) {
            return {
              ok: false,
              url: url,
              meta_flags: flags,
              schema_drivers: drivers,
              connection_required: connectionRequired,
              failure: {
                stage: 'fetch' as const,
                message: `POST ${url} returned HTTP ${pr.status}: ${ptext.slice(0, 200)}`,
                workato_error: json && json.error,
              },
            };
          }
          if (json && json.error !== undefined && json.error !== null) {
            return {
              ok: false,
              url: url,
              meta_flags: flags,
              schema_drivers: drivers,
              connection_required: connectionRequired,
              dynamic_pick_list_selection_used: selection || undefined,
              failure: {
                stage: 'fetch' as const,
                message: String(
                  typeof json.error === 'string' ? json.error : JSON.stringify(json.error),
                ),
                workato_error: json.error,
              },
            };
          }
          if (!json || !json.result || typeof json.result !== 'object') {
            return {
              ok: false,
              url: url,
              meta_flags: flags,
              schema_drivers: drivers,
              connection_required: connectionRequired,
              failure: {
                stage: 'shape' as const,
                message: `Unexpected extended_schema response: ${ptext.slice(0, 200)}`,
              },
            };
          }
          return {
            ok: true,
            url: url,
            result: json.result,
            meta_flags: flags,
            schema_drivers: drivers,
            connection_required: connectionRequired,
            dynamic_pick_list_selection_used: selection || undefined,
          };
        }),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Pure shaping helpers. Exported for unit tests, no browser needed.
// ---------------------------------------------------------------------------

/** Strip Workato's `<span class="provider">` markup and collapse whitespace. */
export function stripHtml(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : undefined;
}

/** Only array-shaped schemas are schemas; anything else is treated as none. */
export function asSchemaArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface ApplyOp {
  op: 'set_extended_schema';
  step: string | number;
  kind: 'extended_input_schema' | 'extended_output_schema';
  schema: unknown[];
}

/**
 * The `workato_recipe_apply` operations that write these schemas onto a step.
 * An empty array is skipped: writing `[]` over a schema a step already has
 * would be a change the caller did not ask for.
 */
export function buildApplyOps(
  step: string | number,
  inputSchema: unknown[],
  outputSchema: unknown[],
): ApplyOp[] {
  const ops: ApplyOp[] = [];
  if (inputSchema.length > 0) {
    ops.push({
      op: 'set_extended_schema',
      step,
      kind: 'extended_input_schema',
      schema: inputSchema,
    });
  }
  if (outputSchema.length > 0) {
    ops.push({
      op: 'set_extended_schema',
      step,
      kind: 'extended_output_schema',
      schema: outputSchema,
    });
  }
  return ops;
}

/**
 * Explain an `error` Workato returned inside an HTTP 200.
 *
 * "HTTP status code NNN" is Workato relaying the app's own answer, so a 4xx or
 * 5xx there means the CONNECTION failed the call, whatever its
 * authorization_status says. `invalid_grant` is the OAuth flavour of the same.
 */
export function describeWorkatoError(
  error: unknown,
  connectionId: number | null,
  adapter: string,
): string {
  const text = typeof error === 'string' ? error : JSON.stringify(error);
  const status = /HTTP status code (\d{3})/i.exec(text ?? '');
  const oauth = /invalid_grant|invalid_client|unauthorized|expired/i.test(text ?? '');
  const who = connectionId !== null ? `connection ${connectionId}` : `adapter "${adapter}"`;
  if (status || oauth) {
    return (
      `Workato relayed a failure from the app behind ${who}: ${text}. ` +
      `The connection itself failed the call; its authorization_status can still read "success" ` +
      '(seen live on two Salesforce connections and one Google Sheets connection). Ask the user to ' +
      're-authorize that connection, or pick another one with workato_search_connections. ' +
      'workato_step_schema with input {} is the cheap liveness probe for a connection.'
    );
  }
  return (
    `Workato rejected the extended_schema request for ${who}: ${text}. Check the operation ` +
    'name and that input uses the field names workato_adapter_meta lists.'
  );
}

/**
 * Which schema drivers (fields marked `extends_schema`) the input still lacks.
 * An empty schema with a missing driver is expected, not an error, and the
 * caller is told which field to fill.
 */
export function missingDrivers(drivers: string[], input: Record<string, unknown>): string[] {
  return drivers.filter(
    (name) => input[name] === undefined || input[name] === null || input[name] === '',
  );
}

class WorkatoStepSchemaTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.STEP_SCHEMA;

  async execute(args: StepSchemaArgs): Promise<ToolResult> {
    try {
      const adapter = typeof args?.adapter === 'string' ? args.adapter.trim() : '';
      if (adapter.length === 0) {
        return createErrorResponse(
          'Param [adapter] must be the technical adapter name (e.g. "salesforce", ' +
            '"workato_variable"). Find it with workato_apps_list(query).',
        );
      }
      const operation = typeof args?.operation === 'string' ? args.operation.trim() : '';
      if (operation.length === 0) {
        return createErrorResponse(
          'Param [operation] must be a trigger or action name; workato_adapter_meta lists them.',
        );
      }
      let connectionId: number | null = null;
      if (args.connection_id !== undefined && args.connection_id !== null) {
        connectionId = Number(args.connection_id);
        if (!Number.isFinite(connectionId) || connectionId <= 0) {
          return createErrorResponse(
            'Param [connection_id] must be a positive numeric connection id.',
          );
        }
      }
      const input =
        args.input && typeof args.input === 'object' && !Array.isArray(args.input)
          ? args.input
          : {};
      if (args.input !== undefined && input !== args.input) {
        return createErrorResponse(
          'Param [input] must be an object: the step input as it would be saved.',
        );
      }
      if (
        args.dynamic_pick_list_selection !== undefined &&
        (typeof args.dynamic_pick_list_selection !== 'object' ||
          args.dynamic_pick_list_selection === null ||
          Array.isArray(args.dynamic_pick_list_selection))
      ) {
        return createErrorResponse('Param [dynamic_pick_list_selection] must be an object.');
      }
      const only = Array.isArray(args.only)
        ? args.only.filter((o): o is 'input' | 'output' => o === 'input' || o === 'output')
        : [];
      const onlyList = only.length > 0 ? [...new Set(only)] : ['input', 'output'];
      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 45_000, 10_000), 110_000);

      const tab = await findWorkatoTab(args.tabId);
      const result = await runInWorkatoTab(
        tab.tabId,
        fetchStepSchemaInPage,
        [
          adapter,
          operation,
          connectionId,
          JSON.stringify(input),
          args.dynamic_pick_list_selection
            ? JSON.stringify(args.dynamic_pick_list_selection)
            : null,
          typeof args.flow_id === 'number' ? args.flow_id : null,
          onlyList,
        ],
        { timeoutMs },
      );

      if (!result.ok) {
        const failure = result.failure;
        const message =
          failure?.stage === 'fetch' && failure.workato_error !== undefined
            ? describeWorkatoError(failure.workato_error, connectionId, adapter)
            : (failure?.message ?? 'unknown failure');
        return createErrorResponse(`workato_step_schema (${failure?.stage}): ${message}`);
      }

      const inputSchema = asSchemaArray(result.result?.input);
      const outputSchema = asSchemaArray(result.result?.output);
      const drivers = result.schema_drivers ?? [];
      const missing = missingDrivers(drivers, input);

      const payload: Record<string, unknown> = {
        adapter,
        ...(connectionId !== null ? { connection_id: connectionId } : {}),
        operation,
        kind: result.meta_flags?.kind,
        connection_required: result.connection_required,
      };
      const title = stripHtml(result.result?.title);
      const description = stripHtml(result.result?.description);
      if (title) payload.title = title;
      if (description) payload.description = description;
      payload.input_schema = inputSchema;
      payload.output_schema = outputSchema;
      payload.input_count = inputSchema.length;
      payload.output_count = outputSchema.length;
      payload.schema_drivers = drivers;
      payload.meta_flags = {
        extends_input_schema: result.meta_flags?.extends_input_schema === true,
        extends_output_schema: result.meta_flags?.extends_output_schema === true,
        ...(result.meta_flags?.depends_on !== undefined
          ? { depends_on: result.meta_flags.depends_on }
          : {}),
        ...(result.meta_flags?.deprecated ? { deprecated: true } : {}),
      };
      if (result.dynamic_pick_list_selection_used) {
        payload.dynamic_pick_list_selection_used = result.dynamic_pick_list_selection_used;
      }

      const dynamic =
        result.meta_flags?.extends_input_schema === true ||
        result.meta_flags?.extends_output_schema === true;
      if (inputSchema.length === 0 && outputSchema.length === 0 && dynamic && missing.length > 0) {
        payload.note =
          `Both schemas came back empty. This operation derives its schema from ${JSON.stringify(
            drivers,
          )} and input is missing ${JSON.stringify(missing)}; fill those (workato_pick_list ` +
          'resolves the values a select accepts) and call again.';
      } else if (inputSchema.length === 0 && outputSchema.length === 0 && !dynamic) {
        payload.note =
          'Both schemas are empty and the operation does not extend its schema: its fields are ' +
          'the static ones workato_adapter_meta lists, and the step needs no extended_*_schema.';
      }

      payload.apply_ops = buildApplyOps('<as>', inputSchema, outputSchema);
      payload.write_hint =
        'Write these with workato_recipe_apply (apply_ops above, replace "<as>" with the step ' +
        'anchor) or pass apply_to:{recipe_id, step} to this tool. A field fed by a dynamic pick ' +
        'list is written twice in the step: in input and in dynamicPickListSelection under the ' +
        'same name.';

      return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_step_schema failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoStepSchemaTool = new WorkatoStepSchemaTool();
