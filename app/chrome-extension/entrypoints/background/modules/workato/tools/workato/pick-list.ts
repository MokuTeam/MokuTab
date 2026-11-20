import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';

/**
 * workato_pick_list — resolve a DYNAMIC pick list against a real connection.
 *
 * workato_adapter_meta returns a select's values when they are static. When
 * `pick_list` is a string instead, the values do not exist in the meta
 * document at all: they are fetched per connection, because they are the
 * customer's own Salesforce objects, NetSuite record types, Slack channels.
 * That was the last thing standing between "the agent knows the field" and
 * "the agent can fill the field".
 *
 * The editor resolves them at POST /connections/<id>/pick_list.json, whose
 * body is the FIELD DEFINITION itself — the same object /integrations/meta
 * returns — plus optional `flow_id` and `pick_list_params`. Verified live:
 * salesforce `all_sobjects` answers with 2567 label/value pairs, and neither
 * flow_id nor pick_list_params is required for an unparameterised list.
 *
 * The response is `[[label, value], ...]`, label FIRST, the same inversion as
 * a static pick list. `value` is what goes into step.input.
 *
 * TWO KEYS, NOT ONE: a step whose field came from a dynamic pick list carries
 * the choice twice — in `input` and in `dynamicPickListSelection`. Observed on
 * a live recipe:
 *   "input": {"sobject_name": "Account", ...},
 *   "dynamicPickListSelection": {"sobject_name": "Account"}
 * Writing only `input` saves cleanly and leaves the editor showing an empty
 * picker, which is the usual Workato failure: silent.
 */

interface PickListArgs {
  /** Connection whose account the list is resolved against. */
  connection_id: number;
  /** Adapter name, used to look the field definition up when `field` is a name. */
  adapter?: string;
  /** Trigger or action name that owns the field. */
  operation?: string;
  /** Field name (needs adapter + operation), or a raw field definition object. */
  field: string | Record<string, unknown>;
  /** Params for a parameterised list, EVALUATED, e.g. {sobject_name: "Account"}. */
  pick_list_params?: Record<string, unknown>;
  /** Recipe id, passed through as flow_id. Optional for most lists. */
  flow_id?: number;
  /** Case-insensitive substring filter on label and value. */
  query?: string;
  /** Max options returned. Default 100, clamped 1–2000. */
  limit?: number;
  /** In-page fetch timeout. Default 45000, clamped 10000–110000. */
  timeout_ms?: number;
  tabId?: number;
}

interface PickOption {
  value: unknown;
  label?: string;
}

interface InPageResult {
  ok: boolean;
  /** Resolved when the field was looked up rather than passed in. */
  field_def?: Record<string, unknown>;
  /** The `pick_list` value found on the field: a name, or an inline static list. */
  pick_list?: unknown;
  /** Present when the list was static and needed no call. */
  static_options?: unknown[];
  raw?: unknown[];
  failure?: { stage: 'meta' | 'field' | 'fetch' | 'shape'; message: string };
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based —
 * DO NOT add async/await (WXT/Vite rewrites it into a hoisted helper that does
 * not survive Function.prototype.toString; see pull-recipe.ts).
 */
function resolvePickListInPage(
  connectionId: number,
  adapter: string | null,
  operation: string | null,
  fieldName: string | null,
  fieldDefJson: string | null,
  paramsJson: string,
  flowId: number | null,
): Promise<InPageResult> {
  const headers = { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' };

  /** Depth-first hunt for a field by name, through properties and toggle_field. */
  function findField(list: any, name: string): any {
    if (!Array.isArray(list)) return null;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f || typeof f !== 'object') continue;
      if (f.name === name) return f;
      const nested = findField(f.properties, name);
      if (nested) return nested;
      if (f.toggle_field && f.toggle_field.name === name) return f.toggle_field;
    }
    return null;
  }

  function post(field: any): Promise<InPageResult> {
    const pickList = field.pick_list;
    // A static list is already the answer; asking the server would be a
    // round trip to be told what the field already said.
    if (Array.isArray(pickList)) {
      return Promise.resolve({
        ok: true,
        field_def: field,
        pick_list: pickList,
        static_options: pickList,
      });
    }
    if (typeof pickList !== 'string' || pickList.length === 0) {
      return Promise.resolve({
        ok: false,
        pick_list: pickList,
        field_def: field,
        failure: {
          stage: 'field' as const,
          message:
            `Field "${field.name}" has no pick_list, so there is no list of values to resolve. ` +
            'Its control_type is ' +
            String(field.control_type) +
            '. A free-text field takes any value.',
        },
      });
    }
    const token = (document.cookie.match(/XSRF-TOKEN-V2=([^;]+)/) || [])[1];
    if (!token) {
      return Promise.resolve({
        ok: false,
        failure: {
          stage: 'fetch' as const,
          message: 'No XSRF-TOKEN-V2 cookie on this tab. Is it logged in?',
        },
      });
    }
    const body: any = { field: field, pick_list_params: JSON.parse(paramsJson) };
    if (flowId !== null) body.flow_id = flowId;
    return fetch(`/connections/${connectionId}/pick_list.json`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'x-csrf-token': decodeURIComponent(token),
      },
      body: JSON.stringify(body),
    }).then((r) =>
      r.text().then((text) => {
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          return {
            ok: false,
            failure: {
              stage: 'shape' as const,
              message: `JSON.parse failed on the pick_list response: ${text.slice(0, 200)}`,
            },
          };
        }
        // Workato answers 200 with {"error": ...} for a malformed body.
        if (json && json.error) {
          return {
            ok: false,
            field_def: field,
            pick_list: pickList,
            failure: {
              stage: 'fetch' as const,
              message:
                `Workato rejected the pick_list request: ${String(json.error)}. ` +
                'Two usual causes: pick_list_params is missing a value this list depends on ' +
                '(the field own pick_list_params names them), or a value was passed as the ' +
                'FORMULA the schema shows rather than the evaluated string: send Account, ' +
                'not the quoted form.',
            },
          };
        }
        if (!json || !Array.isArray(json.result)) {
          return {
            ok: false,
            field_def: field,
            failure: {
              stage: 'shape' as const,
              message: `Unexpected pick_list response: ${text.slice(0, 200)}`,
            },
          };
        }
        return { ok: true, field_def: field, pick_list: pickList, raw: json.result };
      }),
    );
  }

  if (fieldDefJson !== null) return post(JSON.parse(fieldDefJson));

  const metaUrl = `/integrations/meta?name=${encodeURIComponent(String(adapter))}`;
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
      const node = doc && (doc[String(adapter)] || doc);
      if (!node || typeof node !== 'object') {
        return {
          ok: false,
          failure: {
            stage: 'meta' as const,
            message: `Adapter "${adapter}" not found in the meta response.`,
          },
        };
      }
      const op =
        (node.actions && node.actions[String(operation)]) ||
        (node.triggers && node.triggers[String(operation)]);
      if (!op) {
        return {
          ok: false,
          failure: {
            stage: 'meta' as const,
            message: `No trigger or action named "${operation}" on "${adapter}".`,
          },
        };
      }
      const field =
        findField(op.input, String(fieldName)) || findField(op.output, String(fieldName));
      if (!field) {
        return {
          ok: false,
          failure: {
            stage: 'field' as const,
            message: `No field named "${fieldName}" on ${adapter}.${operation}. Call workato_adapter_meta with operation to list them.`,
          },
        };
      }
      return post(field);
    }),
  );
}

// ---------------------------------------------------------------------------
// Pure shaping helpers. Exported for unit tests — no browser needed.
// ---------------------------------------------------------------------------

/**
 * Unwrap `pick_list_params` values copied straight out of a schema.
 *
 * A field own `pick_list_params` holds FORMULA expressions, not literals: the
 * schema shows the value for sobject_name as a quoted string because that is
 * the formula, which the editor evaluates before sending. Passing it through
 * verbatim reaches Salesforce quoted and fails with
 * `bad URI (is not URI?): "sobjects/..."` - verified live 2026-08-26.
 *
 * A real pick-list parameter is never itself a quoted string, so a value
 * wrapped in double quotes is taken as that mistake and unwrapped. The caller
 * is told rather than having it happen silently.
 */
export function normalisePickListParams(params: Record<string, unknown>): {
  params: Record<string, unknown>;
  unwrapped: string[];
} {
  const out: Record<string, unknown> = {};
  const unwrapped: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (
      typeof value === 'string' &&
      value.length >= 2 &&
      value.startsWith('"') &&
      value.endsWith('"') &&
      !value.slice(1, -1).includes('"')
    ) {
      out[key] = value.slice(1, -1);
      unwrapped.push(key);
    } else {
      out[key] = value;
    }
  }
  return { params: out, unwrapped };
}

/**
 * Normalise Workato's `[[label, value], ...]` into `{value, label}`.
 *
 * Label first, value second. Reading it the other way round produces a step
 * that writes the display text where the id belongs, which Workato accepts
 * without complaint.
 */
export function normalisePickOptions(raw: unknown): PickOption[] {
  if (!Array.isArray(raw)) return [];
  const out: PickOption[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      if (entry.length >= 2) out.push({ value: entry[1], label: String(entry[0]) });
      else if (entry.length === 1) out.push({ value: entry[0] });
    } else if (entry !== null && typeof entry !== 'object') {
      out.push({ value: entry });
    }
  }
  return out;
}

/** Case-insensitive filter over label and value. */
export function filterPickOptions(options: PickOption[], query: string): PickOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return options;
  return options.filter(
    (o) =>
      String(o.value ?? '')
        .toLowerCase()
        .includes(needle) || (o.label ?? '').toLowerCase().includes(needle),
  );
}

class WorkatoPickListTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.PICK_LIST;

  async execute(args: PickListArgs): Promise<ToolResult> {
    try {
      const connectionId = Number(args?.connection_id);
      if (!Number.isFinite(connectionId) || connectionId <= 0) {
        return createErrorResponse(
          'Param [connection_id] must be a numeric Workato connection id. A dynamic pick list ' +
            "is the customer's own data, so it only exists against a connection — find one with " +
            'workato_apps_list or workato_search_connections.',
        );
      }
      const rawField = args?.field;
      const fieldIsObject = !!rawField && typeof rawField === 'object';
      const fieldName = typeof rawField === 'string' ? rawField : null;
      if (!fieldIsObject && (fieldName === null || fieldName.length === 0)) {
        return createErrorResponse(
          'Param [field] must be a field name (with adapter and operation) or a raw field ' +
            'definition object from workato_adapter_meta.',
        );
      }
      if (!fieldIsObject && (!args.adapter || !args.operation)) {
        return createErrorResponse(
          'Params [adapter] and [operation] are required when [field] is a name, so the field ' +
            'definition can be read from /integrations/meta.',
        );
      }

      const normalisedParams = normalisePickListParams(args.pick_list_params ?? {});
      const limit = Math.min(Math.max(args.limit ?? 100, 1), 2000);
      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 45_000, 10_000), 110_000);

      const tab = await findWorkatoTab(args.tabId);
      const result = await runInWorkatoTab(
        tab.tabId,
        resolvePickListInPage,
        [
          connectionId,
          args.adapter ?? null,
          args.operation ?? null,
          fieldName,
          fieldIsObject ? JSON.stringify(rawField) : null,
          JSON.stringify(normalisedParams.params),
          typeof args.flow_id === 'number' ? args.flow_id : null,
        ],
        { timeoutMs },
      );

      if (!result.ok) {
        return createErrorResponse(
          `workato_pick_list (${result.failure?.stage}): ${result.failure?.message}`,
        );
      }

      const isStatic = Array.isArray(result.static_options);
      const all = normalisePickOptions(isStatic ? result.static_options : result.raw);
      const matched = args.query ? filterPickOptions(all, args.query) : all;
      const options = matched.slice(0, limit);

      const payload: Record<string, unknown> = {
        connection_id: connectionId,
        ...(args.adapter ? { adapter: args.adapter } : {}),
        ...(args.operation ? { operation: args.operation } : {}),
        field: fieldIsObject ? (rawField as Record<string, unknown>).name : fieldName,
        pick_list: result.pick_list,
        source: isStatic ? 'static' : 'connection',
        total: all.length,
        count: options.length,
        options,
      };
      if (matched.length > options.length) payload.truncated = matched.length - options.length;
      if (normalisedParams.unwrapped.length > 0) {
        payload.params_unwrapped = normalisedParams.unwrapped;
        payload.params_note =
          'A field pick_list_params holds formula expressions, so the schema shows the value ' +
          'wrapped in quotes where the value itself is unquoted. Those quotes were stripped ' +
          'before sending; passing them through fails with a bad-URI error.';
      }
      if (args.query && matched.length === 0 && all.length > 0) {
        payload.note = `None of the ${all.length} values match "${args.query}". Drop query to see them.`;
      }
      payload.write_hint =
        "Write options[].value into step.input, and the SAME value into the step's " +
        'dynamicPickListSelection under the same field name. A step that sets only input ' +
        'saves cleanly and shows an empty picker in the editor.';

      return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_pick_list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoPickListTool = new WorkatoPickListTool();
