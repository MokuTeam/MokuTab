import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';

/**
 * workato_adapter_meta — the "what is this field actually called?" lookup.
 *
 * The recipe editor resolves every connector's config surface through
 * `/integrations/meta?name=<adapter>`. That response is the authority on
 * trigger/action input keys, output keys, and the behaviour flags that say
 * where a step's schema comes from (`extends_input_schema`, `depends_on`).
 *
 * Without it the only way to learn a key name is guess → save → pull → check,
 * and Workato silently drops keys it does not recognise, so a wrong guess
 * looks exactly like a successful save. One call here replaces that loop.
 *
 * Payload discipline: a single adapter's meta runs from ~10 KB
 * (workato_recipe_function) to several hundred KB (salesforce, netsuite). A
 * bare call therefore returns only the operation INDEX (names + titles); field
 * lists arrive when the caller narrows with `operation` or `field_grep`. Use
 * `out_file` when the raw document is genuinely wanted — that is resolved in
 * the native-server, so the JSON never crosses the context.
 */

interface AdapterMetaArgs {
  /** Adapter name, or a list of them (`workato_recipe_function`, `salesforce`, …). */
  adapter: string | string[];
  /** Return full field lists for this trigger/action name only. */
  operation?: string;
  /** Case-insensitive substring (or /regex/) matched against field name and label. */
  field_grep?: string;
  /** Include each operation's help text. Default true. */
  include_help?: boolean;
  /** Index mode: list operations Workato marks deprecated too. Default false. */
  include_deprecated?: boolean;
  /** Return the raw meta document instead of the slim view (capped; prefer out_file). */
  raw?: boolean;
  /** In-page script timeout. Default 30000, clamped 10000–110000. */
  timeout_ms?: number;
  tabId?: number;
  /**
   * Internal, set by the native-server when out_file is used, and absent from
   * the public inputSchema. Lifts the raw-mode character cap: the document is
   * going to a file, and capping it there would write a truncated meta
   * document while reporting the byte count as if it were whole.
   */
  __uncapped?: boolean;
}

/** One config field as the editor sees it. */
export interface SlimField {
  name: string;
  type?: string;
  control_type?: string;
  label?: string;
  optional?: boolean;
  /** True when picking this field re-derives the step's schema (schema-designer fields). */
  extends_schema?: boolean;
  hint?: string;
  /** Name of a DYNAMIC pick list, resolved server-side. Values are not known here. */
  pick_list?: string;
  /**
   * Allowed values of a STATIC select, as `value` — the string that goes into
   * step.input, not the label the UI shows. Workato accepts a wrong value
   * silently, so writing the label ("HTML" instead of "html") produces a step
   * that saves and then misbehaves. This is the single most load-bearing field
   * on a select and it must survive slimming.
   */
  options?: { value: unknown; label?: string }[];
  /** Set when `options` was capped; the remaining values are not shown. */
  options_truncated?: number;
  /** Value Workato applies when the field is omitted. */
  default?: unknown;
  /** Item type of an array field (`of: "object"` → items are objects). */
  of?: string;
  /** Fields of a nested object, or of each item of an object array. */
  properties?: SlimField[];
  /**
   * The alternative form of this field. Workato renders one input that toggles
   * between two shapes (binary content vs. a URL); either name is accepted in
   * step.input, and picking the wrong one silently writes nothing.
   */
  toggle_field?: SlimField;
}

/** Nesting depth for `properties`/`toggle_field`. Past this, children are dropped. */
const MAX_FIELD_DEPTH = 3;
/** Per-select cap on returned values — some pick lists run to hundreds of entries. */
const MAX_OPTIONS = 40;

/** One trigger or action, slimmed to what an agent needs to write a step. */
export interface SlimOperation {
  name: string;
  kind: 'trigger' | 'action';
  title?: string;
  /** The one-line purpose Workato shows under the title in the action picker. */
  title_hint?: string;
  /** Other names the picker's search matches this operation by. */
  aliases?: string[];
  help?: string;
  input?: SlimField[];
  output?: SlimField[];
  /** Field-count summary, present in index mode where the lists are omitted. */
  input_count?: number;
  output_count?: number;
  extends_input_schema?: boolean;
  extends_output_schema?: boolean;
  /** Machine-readable "my fields are declared on that other step". */
  depends_on?: unknown;
  deprecated?: boolean;
  batch?: boolean;
  realtime?: boolean;
}

interface InPageResult {
  ok: boolean;
  /** Raw parsed meta document, present when ok=true. */
  meta?: unknown;
  /** Byte length of the raw response — reported so a caller knows what it dodged. */
  bytes?: number;
  failure?: {
    stage: 'fetch' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based —
 * DO NOT add async/await (WXT/Vite rewrites it into a hoisted helper that does
 * not survive Function.prototype.toString; see pull-recipe.ts).
 */
export function fetchAdapterMetaInPage(names: string[]): Promise<InPageResult> {
  const url = `/integrations/meta?name=${encodeURIComponent(names.join(','))}&cacheKey=x`;
  return fetch(url, {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'fetch' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 512),
            message:
              `GET ${url} returned HTTP ${r.status}` +
              (r.status === 404
                ? '. A 404 here usually means the adapter name is wrong, or this tab is in a ' +
                  'workspace/environment where that connector is not available — it does not ' +
                  'prove the adapter does not exist.'
                : ''),
          },
        };
      }
      let json: unknown = null;
      try {
        json = JSON.parse(bodyText);
      } catch (e) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: bodyText.slice(0, 512),
            message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }
      return { ok: true, meta: json, bytes: bodyText.length };
    }),
  );
}

// ---------------------------------------------------------------------------
// Pure shaping helpers. Exported for unit tests — no browser needed.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Locate one adapter's `{triggers, actions}` node in the meta document.
 *
 * The response has been observed keyed by adapter name at the top level, but
 * Workato wraps some `/web_api` reads in `result`, so both are accepted rather
 * than betting on one and returning "adapter not found" for a document that is
 * right there. Falls back to the top level itself when it already looks like a
 * single adapter's node.
 */
export function pickAdapterNode(meta: unknown, adapter: string): Record<string, unknown> | null {
  const looksLikeAdapter = (v: unknown): v is Record<string, unknown> =>
    isRecord(v) && (isRecord(v.triggers) || isRecord(v.actions));

  const roots: unknown[] = [meta];
  if (isRecord(meta)) {
    if (meta.result !== undefined) roots.push(meta.result);
    if (meta.data !== undefined) roots.push(meta.data);
    if (isRecord(meta.adapters)) roots.push(meta.adapters);
  }

  for (const root of roots) {
    if (!isRecord(root)) continue;
    const direct = root[adapter];
    if (looksLikeAdapter(direct)) return direct;
  }
  // Single-adapter document with no name wrapper.
  for (const root of roots) {
    if (looksLikeAdapter(root)) return root;
  }
  return null;
}

/** Trim and flatten Workato's HTML help blob into one readable line. */
function slimHelp(help: unknown): string | undefined {
  const body = isRecord(help) ? help.body : help;
  if (typeof body !== 'string') return undefined;
  const text = body
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return undefined;
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/**
 * Read a static pick list into `{value, label}` pairs.
 *
 * Workato writes these as `[[label, value], ...]` — label first, which is the
 * opposite of what most schemas do and the reason a careless read produces a
 * step that writes the label. Entries can also be bare scalars, in which case
 * the value is its own label.
 */
export function slimPickList(raw: unknown): Pick<SlimField, 'options' | 'options_truncated'> {
  if (!Array.isArray(raw) || raw.length === 0) return {};
  const options: { value: unknown; label?: string }[] = [];
  for (const entry of raw.slice(0, MAX_OPTIONS)) {
    if (Array.isArray(entry)) {
      // [label, value] — value is index 1, and is what step.input must carry.
      if (entry.length >= 2) options.push({ value: entry[1], label: String(entry[0]) });
      else if (entry.length === 1) options.push({ value: entry[0] });
    } else if (entry !== null && typeof entry !== 'object') {
      options.push({ value: entry });
    }
  }
  if (options.length === 0) return {};
  const out: Pick<SlimField, 'options' | 'options_truncated'> = { options };
  if (raw.length > MAX_OPTIONS) out.options_truncated = raw.length - options.length;
  return out;
}

function slimField(raw: unknown, depth = 0): SlimField | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!name) return null;
  const out: SlimField = { name };
  if (typeof raw.type === 'string') out.type = raw.type;
  if (typeof raw.control_type === 'string') out.control_type = raw.control_type;
  if (typeof raw.label === 'string') out.label = raw.label;
  if (typeof raw.optional === 'boolean') out.optional = raw.optional;
  if (raw.extends_schema === true) out.extends_schema = true;
  if (typeof raw.hint === 'string') out.hint = slimHelp(raw.hint);
  if (typeof raw.pick_list === 'string') out.pick_list = raw.pick_list;
  else Object.assign(out, slimPickList(raw.pick_list));
  if (raw.default !== undefined) out.default = raw.default;
  if (typeof raw.of === 'string') out.of = raw.of;

  if (depth < MAX_FIELD_DEPTH) {
    const nested = slimFieldList(raw.properties, depth + 1);
    if (nested.length > 0) out.properties = nested;
    const toggle = slimField(raw.toggle_field, depth + 1);
    if (toggle) out.toggle_field = toggle;
  }
  return out;
}

function slimFieldList(raw: unknown, depth = 0): SlimField[] {
  if (!Array.isArray(raw)) return [];
  const out: SlimField[] = [];
  for (const entry of raw) {
    const field = slimField(entry, depth);
    if (field) out.push(field);
  }
  return out;
}

/** Build a matcher from `/regex/flags` or a plain case-insensitive substring. */
export function buildFieldMatcher(pattern: string): (field: SlimField) => boolean {
  let test: (s: string) => boolean;
  const asRegex = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  if (asRegex) {
    const re = new RegExp(asRegex[1], asRegex[2].includes('i') ? asRegex[2] : `${asRegex[2]}i`);
    test = (s) => re.test(s);
  } else {
    const needle = pattern.toLowerCase();
    test = (s) => s.toLowerCase().includes(needle);
  }
  const hit = (field: SlimField): boolean =>
    test(field.name) || (field.label !== undefined && test(field.label));
  // Nested fields are the ones hardest to find by reading, so a grep that
  // stopped at the top level would miss exactly the cases it exists for.
  const deep = (field: SlimField): boolean =>
    hit(field) ||
    (field.properties?.some(deep) ?? false) ||
    (field.toggle_field !== undefined && deep(field.toggle_field));
  return deep;
}

/** Shape one trigger/action entry. `detail=false` omits the field lists. */
export function slimOperation(
  name: string,
  kind: 'trigger' | 'action',
  raw: unknown,
  opts: { detail: boolean; includeHelp: boolean; matcher?: (field: SlimField) => boolean },
): SlimOperation {
  const src = isRecord(raw) ? raw : {};
  const op: SlimOperation = { name, kind };
  if (typeof src.title === 'string') op.title = src.title;
  if (typeof src.title_hint === 'string' && src.title_hint.trim().length > 0) {
    // Some hints carry the editor's <span class="provider"> markup; flatten it
    // the same way help text is flattened.
    const hint = slimHelp(src.title_hint);
    if (hint) op.title_hint = hint;
  }
  if (Array.isArray(src.aliases)) {
    const aliases = src.aliases.filter((a): a is string => typeof a === 'string' && a.length > 0);
    if (aliases.length > 0) op.aliases = aliases;
  }
  if (opts.includeHelp) {
    const help = slimHelp(src.help);
    if (help) op.help = help;
  }

  const input = slimFieldList(src.input);
  const output = slimFieldList(src.output);
  if (opts.detail) {
    op.input = opts.matcher ? input.filter(opts.matcher) : input;
    op.output = opts.matcher ? output.filter(opts.matcher) : output;
  } else {
    op.input_count = input.length;
    op.output_count = output.length;
  }

  // Behaviour flags. These answer "where do this step's fields come from?",
  // which is the question that costs the most time when it goes unanswered.
  if (src.extends_input_schema === true) op.extends_input_schema = true;
  if (src.extends_output_schema === true) op.extends_output_schema = true;
  if (src.depends_on !== undefined) op.depends_on = src.depends_on;
  if (src.deprecated === true) op.deprecated = true;
  if (src.batch === true) op.batch = true;
  if (src.realtime === true) op.realtime = true;
  return op;
}

export interface AdapterMetaView {
  adapter: string;
  found: boolean;
  mode: 'index' | 'detail' | 'grep';
  /** Human name, e.g. "Email by Workato". Confirms a guessed adapter name is the right app. */
  title?: string;
  /** Other names this connector answers to — the searchable surface of `title`. */
  aliases?: string[];
  categories?: string[];
  /**
   * False when the connector needs no connection at all (Email by Workato,
   * logger, py_eval). A step on such an adapter carries no `account_id`, and
   * looking for a connection that will never exist is a common dead end.
   */
  connection_required?: boolean;
  deprecated?: boolean;
  triggers?: SlimOperation[];
  actions?: SlimOperation[];
  /** Index mode: operations Workato marks deprecated that were left out of the lists. */
  deprecated_hidden?: number;
  /** Present in index mode: how to get the field lists. */
  hint?: string;
}

/**
 * Turn one adapter's raw meta node into the view the caller asked for.
 *
 * Three modes, chosen by how much the caller narrowed:
 *   index  — nothing specified. Operation names + titles only.
 *   detail — `operation` given. Full field lists for the matching operations.
 *   grep   — `field_grep` given. Every operation that has a matching field,
 *            carrying only the fields that matched.
 */
export function buildAdapterView(
  adapter: string,
  meta: unknown,
  opts: {
    operation?: string;
    fieldGrep?: string;
    includeHelp: boolean;
    /** Index mode only: keep deprecated operations in the lists. Default false. */
    includeDeprecated?: boolean;
  },
): AdapterMetaView {
  const node = pickAdapterNode(meta, adapter);
  if (!node) return { adapter, found: false, mode: 'index' };

  const mode: AdapterMetaView['mode'] = opts.operation
    ? 'detail'
    : opts.fieldGrep
      ? 'grep'
      : 'index';
  const matcher = opts.fieldGrep ? buildFieldMatcher(opts.fieldGrep) : undefined;
  const wanted = opts.operation?.toLowerCase();
  // The recipe editor's action picker hides deprecated operations; the index
  // does the same unless asked, because a retired action is noise in a search
  // for something to build with. Detail and grep modes never hide: a name the
  // caller typed, or a field the caller searched for, is answered as asked.
  const hideDeprecated = mode === 'index' && opts.includeDeprecated !== true;
  let deprecatedHidden = 0;

  const collect = (kind: 'trigger' | 'action', bag: unknown): SlimOperation[] => {
    if (!isRecord(bag)) return [];
    const out: SlimOperation[] = [];
    for (const [name, raw] of Object.entries(bag)) {
      if (wanted !== undefined && name.toLowerCase() !== wanted) continue;
      if (hideDeprecated && isRecord(raw) && raw.deprecated === true) {
        deprecatedHidden++;
        continue;
      }
      const op = slimOperation(name, kind, raw, {
        detail: mode !== 'index',
        includeHelp: opts.includeHelp,
        matcher,
      });
      // In grep mode an operation with no matching field is noise.
      if (mode === 'grep' && (op.input?.length ?? 0) === 0 && (op.output?.length ?? 0) === 0) {
        continue;
      }
      out.push(op);
    }
    return out;
  };

  const view: AdapterMetaView = {
    adapter,
    found: true,
    mode,
    triggers: collect('trigger', node.triggers),
    actions: collect('action', node.actions),
  };
  if (deprecatedHidden > 0) view.deprecated_hidden = deprecatedHidden;

  // Adapter-level identity. Tiny, and it is what turns a guessed name into a
  // confirmed one — so it is returned in every mode, index included.
  if (typeof node.title === 'string') view.title = node.title;
  if (Array.isArray(node.aliases)) {
    const aliases = node.aliases.filter((a): a is string => typeof a === 'string');
    if (aliases.length > 0) view.aliases = aliases;
  }
  if (Array.isArray(node.categories)) {
    const categories = node.categories.filter((c): c is string => typeof c === 'string');
    if (categories.length > 0) view.categories = categories;
  }
  if (isRecord(node.config) && typeof node.config.required === 'boolean') {
    view.connection_required = node.config.required;
  }
  if (node.deprecated === true) view.deprecated = true;

  if (mode === 'index') {
    view.hint =
      'Index only. Pass operation:"<name>" for that operation\'s full input/output field ' +
      'lists, or field_grep:"schema" to find fields by name/label across every operation.' +
      (deprecatedHidden > 0
        ? ` ${deprecatedHidden} deprecated operation(s) hidden; include_deprecated:true lists them.`
        : '');
  }
  return view;
}

/**
 * The static input fields one adapter operation declares, for a caller that
 * already holds a raw meta document.
 *
 * Used by `workato_pull_recipe` to answer "what can this step be given?" for a
 * step whose own `extended_input_schema` is empty. Returns null when the meta
 * does not describe that adapter or that operation at all, so the caller can
 * report the gap instead of an empty field list.
 */
export function findOperationInputFields(
  meta: unknown,
  adapter: string,
  operation: string,
): { fields: SlimField[]; extends_input_schema: boolean } | null {
  const view = buildAdapterView(adapter, meta, { operation, includeHelp: false });
  if (!view.found) return null;
  const wanted = operation.toLowerCase();
  const match = [...(view.actions ?? []), ...(view.triggers ?? [])].find(
    (op) => op.name.toLowerCase() === wanted,
  );
  if (!match) return null;
  return {
    fields: match.input ?? [],
    extends_input_schema: match.extends_input_schema === true,
  };
}

/** Raw-mode cap. Past this the caller is told to use out_file instead. */
const RAW_CHAR_CAP = 20_000;

class WorkatoAdapterMetaTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.ADAPTER_META;

  async execute(args: AdapterMetaArgs): Promise<ToolResult> {
    try {
      const names = Array.isArray(args?.adapter)
        ? args.adapter.filter((n): n is string => typeof n === 'string' && n.length > 0)
        : typeof args?.adapter === 'string' && args.adapter.length > 0
          ? args.adapter.split(',').map((n) => n.trim())
          : [];
      if (names.length === 0) {
        return createErrorResponse(
          'Param [adapter] must be a non-empty adapter name or array of names ' +
            '(e.g. "workato_recipe_function", ["salesforce","netsuite"]).',
        );
      }
      if (args.operation != null && typeof args.operation !== 'string') {
        return createErrorResponse('Param [operation] must be a string trigger/action name');
      }
      if (args.field_grep != null && typeof args.field_grep !== 'string') {
        return createErrorResponse('Param [field_grep] must be a string');
      }

      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 30_000, 10_000), 110_000);
      const tab = await findWorkatoTab(args.tabId);
      const result = await runInWorkatoTab(tab.tabId, fetchAdapterMetaInPage, [names], {
        timeoutMs,
      });

      if (!result.ok) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
            (result.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      // raw mode: hand back the document itself, capped. `out_file` (resolved
      // in the native-server) is the uncapped route.
      if (args.raw === true) {
        const rawText = JSON.stringify(result.meta);
        const capped = args.__uncapped !== true && rawText.length > RAW_CHAR_CAP;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                adapters: names,
                bytes: result.bytes,
                truncated: capped,
                ...(capped
                  ? {
                      note:
                        `Raw document is ${rawText.length} chars — truncated to ${RAW_CHAR_CAP}. ` +
                        'Pass out_file:"<path>.json" to write the whole thing to disk, or narrow ' +
                        'with operation/field_grep.',
                    }
                  : {}),
                raw: capped ? rawText.slice(0, RAW_CHAR_CAP) : result.meta,
              }),
            },
          ],
          isError: false,
        };
      }

      const includeHelp = args.include_help !== false;
      const views = names.map((adapter) =>
        buildAdapterView(adapter, result.meta, {
          operation: args.operation,
          fieldGrep: args.field_grep,
          includeHelp,
          includeDeprecated: args.include_deprecated === true,
        }),
      );

      const missing = views.filter((v) => !v.found).map((v) => v.adapter);
      if (missing.length === names.length) {
        const topKeys = isRecord(result.meta) ? Object.keys(result.meta).slice(0, 40) : [];
        return createErrorResponse(
          `workato_adapter_meta: no adapter node found for ${JSON.stringify(names)} in the ` +
            `meta response (${result.bytes} bytes). Top-level keys: ${JSON.stringify(topKeys)}. ` +
            'Check the adapter name — a custom connector uses its generated name ' +
            '(e.g. "netsuite_rest_connector_5105163_1745592003"), visible in a recipe step\'s ' +
            '`provider` field.',
        );
      }

      const payload: Record<string, unknown> = {
        adapters: views.length === 1 ? views[0] : views,
        bytes: result.bytes,
      };
      if (missing.length > 0) payload.not_found = missing;

      // An empty detail-mode result means the operation name was wrong; say so
      // rather than handing back an empty object that reads like "no fields".
      if (args.operation) {
        const hits = views.reduce(
          (n, v) => n + (v.triggers?.length ?? 0) + (v.actions?.length ?? 0),
          0,
        );
        if (hits === 0) {
          const index = views
            .filter((v) => v.found)
            .map((v) => v.adapter)
            .join(', ');
          return createErrorResponse(
            `workato_adapter_meta: no trigger or action named "${args.operation}" on ${index}. ` +
              'Call again without [operation] to list what this adapter actually exposes.',
          );
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_adapter_meta failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoAdapterMetaTool = new WorkatoAdapterMetaTool();
