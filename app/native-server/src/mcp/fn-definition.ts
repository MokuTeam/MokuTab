/**
 * Browser functions: the definition format.
 *
 * A function is a named, versioned sequence of browser steps that an agent
 * runs with parameters instead of re-deriving the same chrome_javascript calls
 * every session. This module owns the shape: validation of a definition (at
 * save), of the params a run passes (at run), and the {placeholder} templates
 * that carry values into URLs and tool arguments. Nothing here touches the
 * browser or the disk.
 *
 * Values reach page code only as one JSON literal (`args`, `prev`), never by
 * splicing them into the code text, so a param cannot change what runs.
 */

import { createHash } from 'crypto';
import { NETSUITE_FN_TOOL_NAMES } from '@mokuhub/mokutab-shared';

export type FnKind = 'read' | 'write' | 'send';
export const FN_KINDS: readonly FnKind[] = ['read', 'write', 'send'];

export type FnStepType =
  | 'navigate'
  | 'wait_for'
  | 'js'
  | 'verify'
  | 'tool'
  | 'pause'
  | 'finish'
  | 'fail';
const STEP_TYPES: readonly FnStepType[] = [
  'navigate',
  'wait_for',
  'js',
  'verify',
  'tool',
  'pause',
  'finish',
  'fail',
];

/**
 * Browser tools a `tool` step may call in the function's own tab. All of them
 * reach the page through the tabs or scripting APIs, so they keep working on
 * pages CDP cannot attach to (an extension iframe on a login page). Tools that
 * open, close or switch tabs are left out: the runner owns the window.
 */
export const FN_TOOL_ALLOWLIST: readonly string[] = [
  'chrome_computer',
  'chrome_click_element',
  'chrome_find_elements',
  'chrome_fill_or_select',
  'chrome_keyboard',
  'chrome_snapshot_wait_for',
  'chrome_handle_dialog',
  'chrome_search_page',
];

/**
 * Bridge tools a `tool` step may call. They run in the bridge, not in the
 * function's tab (no tabId is added): the NetSuite session store tools, so a
 * login function can take a shared session first and publish the new one.
 */
export const FN_BRIDGE_TOOL_ALLOWLIST: readonly string[] = NETSUITE_FN_TOOL_NAMES;

/** A page or step condition, checked by `when`, `wait_for` and `verify`. */
export interface FnCondition {
  /** Regex tested against the tab URL (tabs API: works on any page). */
  url?: string;
  /** CSS selector that must match (chrome_find_elements). */
  exists?: string;
  /** CSS selector that must not match. */
  missing?: string;
  /** JS expression evaluated in the page with args, prev and h. */
  js?: string;
  /**
   * With equals / in: compare the value of an earlier step, or one field of
   * it (`store.state`: the state field of step store's value).
   */
  step?: string;
  equals?: unknown;
  in?: unknown[];
  /** Label a wait_for `any` reports for the condition that matched. */
  name?: string;
}

export interface FnStep {
  id: string;
  type: FnStepType;
  /** Skip the step unless this holds. */
  when?: FnCondition;
  /** The step changes something outside the page: the preview stops before it. */
  commit?: boolean;
  timeout_ms?: number;
  /** navigate: URL template. */
  url?: string;
  /** wait_for: a JS expression, or one condition. */
  until?: string | FnCondition;
  /** wait_for: the first of several conditions; its name becomes the value. */
  any?: FnCondition[];
  /** js / verify: body of an async function with args, prev and h in scope. */
  code?: string;
  /** tool: an allowlisted browser or bridge tool and its arguments (string values are templates). */
  tool?: string;
  args?: Record<string, unknown>;
  /**
   * tool, navigate, wait_for: a failure becomes the step value
   * {state: 'error', error} instead of failing the run.
   */
  optional?: boolean;
  /** pause: params the caller supplies when it resumes. */
  needs?: string[];
  /** pause / fail: text for the caller (a template). */
  message?: string;
  /** finish: the run's result (string values are templates). */
  value?: unknown;
}

export interface ParamSchema {
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: unknown[];
  default?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: ParamSchema;
  properties?: Record<string, ParamSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface FnTarget {
  /** URL template the function's window opens on. */
  url: string;
  /** Chrome profile to run in, unless the call names one. */
  profile?: string;
  /** Own unfocused window (default) or a tab in the shared agents window. */
  own_window?: boolean;
  /**
   * Host template the page must be on when the window opens and before every
   * commit step (catches a logged-out redirect before anything is written).
   * Required for write and send.
   */
  host?: string;
}

export interface FnDefinition {
  name: string;
  description: string;
  tags?: string[];
  kind: FnKind;
  /** Managed by the registry: the saved version number. */
  version?: number;
  params?: ParamSchema;
  target: FnTarget;
  /** Helper libraries (registry `_helpers.<name>`) loaded into `h`. */
  helpers?: string[];
  steps: FnStep[];
  /** Step whose value is the preview of a write/send. Default: the last value before the first commit. */
  preview?: string;
  /** Step whose value is the result. Default: the last step that produced a value. */
  result?: string;
  /** Template; a commit with the same rendered key within 24 h is refused. */
  dedupe_key?: string;
  /** Template returned with an unknown outcome: how to check whether the write landed. */
  verify_hint?: string;
  notes?: string;
  /**
   * Bitwarden values the function types (fn-vault.ts): name -> {item, field}.
   * Usable only as the whole `value` of a fill tool step: `"{vault.password}"`.
   * chrome_fn_save never saves a definition with this; a person commits it.
   */
  vault?: Record<string, { item: string; field: string }>;
}

/** Tool steps whose `value` argument may be a vault value. */
export function isVaultFillStep(step: FnStep): boolean {
  return (
    (step.tool === 'chrome_computer' && step.args?.action === 'fill') ||
    step.tool === 'chrome_fill_or_select'
  );
}

/** `"{vault.password}"` -> "password"; anything else -> null. */
export function vaultRef(value: unknown): string | null {
  const match = typeof value === 'string' ? /^\{vault\.([a-z_][a-z0-9_]*)\}$/.exec(value) : null;
  return match ? match[1] : null;
}

export interface HelperDefinition {
  name: string;
  description: string;
  version?: number;
  code: string;
}

export const HELPER_PREFIX = '_helpers.';
const FN_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const HELPER_NAME = /^_helpers\.[a-z][a-z0-9_]*$/;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const MAX_DEFINITION_BYTES = 256 * 1024;
export const MAX_STEP_TIMEOUT_MS = 120_000;

export function isHelperName(name: string): boolean {
  return HELPER_NAME.test(name);
}

/** Names Windows will not create as a file or directory, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export function isFunctionName(name: string): boolean {
  return FN_NAME.test(name) && !name.split('.').some((part) => WINDOWS_RESERVED.test(part));
}

// ---------------------------------------------------------------------------
// Code checks (compile without running)
// ---------------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => unknown;

/** A syntax error in a step body, or null. Constructing the function does not run it. */
export function syntaxError(body: string): string | null {
  try {
    new AsyncFunction('args', 'prev', 'h', body);
    return null;
  } catch (err: any) {
    return err?.message || String(err);
  }
}

export function expressionBody(expression: string): string {
  return `return (${expression}\n);`;
}

// ---------------------------------------------------------------------------
// Secret literals
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/],
  ['a JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a basic-auth URL', /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const CREDENTIAL_ASSIGNMENT =
  /\b(password|passwd|pwd|secret|api_?key|access_?token|refresh_?token|client_?secret|token)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi;

/**
 * A quoted value assigned to a credential-named key that looks generated: it
 * has a digit or is long. Fixed protocol words stay allowed, e.g. Atlassian's
 * `'X-Atlassian-Token': 'no-check'`.
 */
function hasCredentialAssignment(text: string): boolean {
  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
    const value = match[2];
    if (/\d/.test(value) || value.length >= 20) return true;
  }
  return false;
}

/** Where a definition embeds what looks like a credential, e.g. "steps[2].code: a JWT". */
export function findSecretLiterals(value: unknown, at = ''): string[] {
  const hits: string[] = [];
  if (typeof value === 'string') {
    for (const [label, re] of SECRET_PATTERNS) {
      if (re.test(value)) hits.push(`${at || 'value'}: ${label}`);
    }
    if (hasCredentialAssignment(value)) hits.push(`${at || 'value'}: a credential literal`);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findSecretLiterals(item, `${at}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      hits.push(...findSecretLiterals(item, at ? `${at}.${key}` : key));
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{|\}\}|\{([a-zA-Z_][\w.]*)(?:\|([a-z_]+))?\}/g;
const FILTERS = new Set(['url', 'raw', 'lower', 'upper', 'json', 'ns_host']);

export interface TemplateRef {
  path: string;
  filter?: string;
}

/** The {placeholders} of a template ({{ and }} are literal braces). */
export function templateRefs(template: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (match[1]) refs.push({ path: match[1], ...(match[2] ? { filter: match[2] } : {}) });
  }
  return refs;
}

export interface TemplateScope {
  args: Record<string, unknown>;
  prev: Record<string, unknown>;
}

function lookup(scope: TemplateScope, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown;
  if (parts[0] === 'prev') {
    cur = scope.prev;
    parts.shift();
  } else {
    cur = scope.args;
  }
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function filtered(value: unknown, filter: string | undefined): string {
  switch (filter) {
    case 'lower':
      return asText(value).toLowerCase();
    case 'upper':
      return asText(value).toUpperCase();
    case 'json':
      return JSON.stringify(value);
    case 'ns_host': {
      // NetSuite account id -> host label: 7654321_SB1 -> 7654321-sb1
      const label = asText(value).toLowerCase().replace(/_/g, '-');
      if (!/^[a-z0-9-]+$/.test(label))
        throw new Error(`{|ns_host} got "${asText(value)}", not an account id`);
      return label;
    }
    default:
      return asText(value);
  }
}

function applyFilter(value: unknown, filter: string | undefined, encode: boolean): string {
  if (filter === 'raw') return asText(value);
  if (filter === 'url') return encodeURIComponent(asText(value));
  // In a URL every value is encoded after its filter: "{q|lower}" must not inject "&b=c".
  const text = filtered(value, filter);
  return encode ? encodeURIComponent(text) : text;
}

/**
 * Render a template. `encode` URL-encodes every value unless its filter is
 * raw (for URLs). A missing value is an error, not an empty string: an empty
 * id in a record URL opens a new record instead of the intended one.
 */
export function renderTemplate(template: string, scope: TemplateScope, encode: boolean): string {
  return template.replace(PLACEHOLDER, (whole, path?: string, filter?: string) => {
    if (whole === '{{') return '{';
    if (whole === '}}') return '}';
    const value = lookup(scope, path as string);
    if (value === undefined || value === null) {
      throw new Error(`template value {${path}} is missing`);
    }
    return applyFilter(value, filter, encode);
  });
}

/**
 * Render a JSON value whose strings are templates. A string that is exactly one
 * placeholder keeps the value's type ("{hours}" stays a number).
 */
export function renderValue(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') {
    const only = /^\{([a-zA-Z_][\w.]*)\}$/.exec(value);
    if (only) {
      const found = lookup(scope, only[1]);
      if (found === undefined) throw new Error(`template value {${only[1]}} is missing`);
      return found;
    }
    return renderTemplate(value, scope, false);
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, scope));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = renderValue(item, scope);
    return out;
  }
  return value;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface ParamCheck {
  ok: boolean;
  value: Record<string, unknown>;
  errors: string[];
}

function typeOk(type: ParamSchema['type'], value: unknown): boolean {
  switch (type) {
    case undefined:
      return true;
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

function checkValue(schema: ParamSchema, value: unknown, at: string, errors: string[]): unknown {
  if (!typeOk(schema.type, value)) {
    errors.push(`${at}: expected ${schema.type}, got ${JSON.stringify(value)}`);
    return value;
  }
  if (schema.enum && !schema.enum.some((option) => stableJson(option) === stableJson(value))) {
    errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${at}: below the minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${at}: above the maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    return value.map((item, i) =>
      checkValue(schema.items as ParamSchema, item, `${at}[${i}]`, errors),
    );
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    return checkObject(schema, value as Record<string, unknown>, at, errors);
  }
  return value;
}

function checkObject(
  schema: ParamSchema,
  input: Record<string, unknown>,
  at: string,
  errors: string[],
  skipRequired: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const prop = properties[key];
    if (!prop) {
      if (schema.additionalProperties === false || at === '') {
        errors.push(`${at ? `${at}.` : ''}${key}: unknown parameter`);
      } else {
        out[key] = value;
      }
      continue;
    }
    out[key] = checkValue(prop, value, at ? `${at}.${key}` : key, errors);
  }
  for (const [key, prop] of Object.entries(properties)) {
    if (out[key] === undefined && prop.default !== undefined) {
      out[key] = JSON.parse(JSON.stringify(prop.default));
    }
  }
  for (const key of schema.required ?? []) {
    if (out[key] === undefined && !skipRequired.has(key)) {
      errors.push(`${at ? `${at}.` : ''}${key}: required`);
    }
  }
  return out;
}

/**
 * Check run params against the function's schema and fill defaults. Unknown
 * top-level params are errors (a typo must not silently fall back to a
 * default). `later` names params a pause step asks for, so they may be absent.
 */
export function checkParams(
  schema: ParamSchema | undefined,
  input: unknown,
  later: ReadonlySet<string> = new Set(),
): ParamCheck {
  const errors: string[] = [];
  if (
    input !== undefined &&
    (input === null || typeof input !== 'object' || Array.isArray(input))
  ) {
    return { ok: false, value: {}, errors: ['params must be an object'] };
  }
  const value = checkObject(
    schema ?? { type: 'object', properties: {} },
    (input as Record<string, unknown>) ?? {},
    '',
    errors,
    later,
  );
  return { ok: errors.length === 0, value, errors };
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as any)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Definition validation
// ---------------------------------------------------------------------------

/** Regexes from definitions run in the bridge: keep them short. */
const MAX_REGEX_CHARS = 300;

/**
 * A key nobody reads is a typo that silently drops a safeguard (`comit`,
 * `dedup_key`, `target.hots`): every object of a definition is closed.
 */
function unknownKeys(
  value: object,
  allowed: readonly string[],
  at: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${at ? `${at}.` : ''}${key}: unknown key (allowed: ${allowed.join(', ')})`);
    }
  }
}

function checkRegex(source: unknown, at: string, errors: string[]): void {
  if (typeof source !== 'string') {
    errors.push(`${at}: a regex string`);
    return;
  }
  if (source.length > MAX_REGEX_CHARS) {
    errors.push(`${at}: regex longer than ${MAX_REGEX_CHARS} characters`);
    return;
  }
  try {
    new RegExp(source);
  } catch {
    errors.push(`${at}: not a valid regex`);
  }
}

const TOP_KEYS = [
  'name',
  'description',
  'tags',
  'kind',
  'version',
  'params',
  'target',
  'helpers',
  'vault',
  'steps',
  'preview',
  'result',
  'dedupe_key',
  'verify_hint',
  'notes',
] as const;
const TARGET_KEYS = ['url', 'profile', 'own_window', 'host'] as const;
const SCHEMA_KEYS = [
  'type',
  'description',
  'enum',
  'default',
  'pattern',
  'minimum',
  'maximum',
  'items',
  'properties',
  'required',
  'additionalProperties',
] as const;
const CONDITION_KEYS = ['url', 'exists', 'missing', 'js', 'step', 'equals', 'in', 'name'] as const;
const STEP_COMMON_KEYS = ['id', 'type', 'when', 'commit', 'timeout_ms'];
const STEP_KEYS: Record<FnStepType, readonly string[]> = {
  navigate: [...STEP_COMMON_KEYS, 'url', 'optional'],
  wait_for: [...STEP_COMMON_KEYS, 'until', 'any', 'optional'],
  js: [...STEP_COMMON_KEYS, 'code'],
  verify: [...STEP_COMMON_KEYS, 'code'],
  tool: [...STEP_COMMON_KEYS, 'tool', 'args', 'optional'],
  pause: [...STEP_COMMON_KEYS, 'needs', 'message'],
  finish: [...STEP_COMMON_KEYS, 'value'],
  fail: [...STEP_COMMON_KEYS, 'message'],
};

function checkSchemaShape(schema: unknown, at: string, errors: string[]): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`${at}: must be a JSON Schema object`);
    return;
  }
  // Unsupported keywords (minLength, format) would be ignored, not enforced.
  unknownKeys(schema, SCHEMA_KEYS, at, errors);
  const s = schema as ParamSchema;
  const types = ['string', 'integer', 'number', 'boolean', 'array', 'object'];
  if (s.type !== undefined && !types.includes(s.type)) {
    errors.push(`${at}.type: one of ${types.join(', ')}`);
  }
  if (s.pattern !== undefined) checkRegex(s.pattern, `${at}.pattern`, errors);
  if (s.items !== undefined) checkSchemaShape(s.items, `${at}.items`, errors);
  if (s.properties !== undefined) {
    if (typeof s.properties !== 'object' || Array.isArray(s.properties)) {
      errors.push(`${at}.properties: must be an object`);
    } else {
      for (const [key, prop] of Object.entries(s.properties)) {
        checkSchemaShape(prop, `${at}.properties.${key}`, errors);
      }
    }
  }
  if (s.required !== undefined && !Array.isArray(s.required)) {
    errors.push(`${at}.required: must be an array`);
  }
}

function checkCondition(
  cond: unknown,
  at: string,
  earlier: ReadonlySet<string>,
  errors: string[],
): void {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
    errors.push(`${at}: must be a condition object`);
    return;
  }
  unknownKeys(cond, CONDITION_KEYS, at, errors);
  const c = cond as FnCondition;
  const kinds = ['url', 'exists', 'missing', 'js', 'step'].filter(
    (key) => (c as any)[key] !== undefined,
  );
  if (kinds.length !== 1) {
    errors.push(`${at}: give exactly one of url, exists, missing, js, step`);
    return;
  }
  if (c.url !== undefined) checkRegex(c.url, `${at}.url`, errors);
  for (const key of ['exists', 'missing'] as const) {
    if (c[key] !== undefined && (typeof c[key] !== 'string' || !c[key])) {
      errors.push(`${at}.${key}: a CSS selector`);
    }
  }
  if (c.js !== undefined) {
    const err = typeof c.js === 'string' ? syntaxError(expressionBody(c.js)) : 'not a string';
    if (err) errors.push(`${at}.js: ${err}`);
  }
  if (c.step !== undefined) {
    const head = typeof c.step === 'string' ? c.step.split('.')[0] : '';
    if (!earlier.has(head)) errors.push(`${at}.step: "${c.step}" is not an earlier step`);
    if (c.equals === undefined && !Array.isArray(c.in)) {
      errors.push(`${at}: step needs equals or in`);
    }
  }
}

function checkRefs(
  template: string,
  at: string,
  params: ReadonlySet<string>,
  earlier: ReadonlySet<string>,
  errors: string[],
): void {
  for (const ref of templateRefs(template)) {
    if (ref.filter && !FILTERS.has(ref.filter)) {
      errors.push(`${at}: unknown filter |${ref.filter}`);
    }
    const head = ref.path.split('.');
    if (head[0] === 'vault') {
      errors.push(`${at}: {${ref.path}} can only be the whole value of a fill tool step`);
    } else if (head[0] === 'prev') {
      if (!head[1] || !earlier.has(head[1])) {
        errors.push(`${at}: {${ref.path}} does not name an earlier step`);
      }
    } else if (!params.has(head[0])) {
      errors.push(`${at}: {${ref.path}} is not a param`);
    }
  }
}

/**
 * Validate a definition before it is saved. Returns the problems found, each
 * naming the field, so an agent can fix them all in one pass.
 */
export function validateDefinition(def: unknown): string[] {
  const errors: string[] = [];
  if (!def || typeof def !== 'object' || Array.isArray(def))
    return ['definition must be an object'];
  const d = def as FnDefinition;
  unknownKeys(d, TOP_KEYS, '', errors);

  if (typeof d.name !== 'string' || !isFunctionName(d.name)) {
    errors.push('name: dotted lower-case words, e.g. "netsuite.case.read_messages"');
  }
  if (typeof d.description !== 'string' || d.description.trim() === '') {
    errors.push('description: required');
  }
  if (!FN_KINDS.includes(d.kind)) errors.push(`kind: one of ${FN_KINDS.join(', ')}`);
  if (
    d.tags !== undefined &&
    (!Array.isArray(d.tags) || d.tags.some((t) => typeof t !== 'string'))
  ) {
    errors.push('tags: an array of strings');
  }

  const params = new Set<string>();
  if (d.params !== undefined) {
    checkSchemaShape(d.params, 'params', errors);
    if (d.params.type !== undefined && d.params.type !== 'object') {
      errors.push('params.type: must be "object"');
    }
    for (const key of Object.keys(d.params.properties ?? {})) {
      if (!IDENT.test(key)) errors.push(`params.properties.${key}: use lower_snake_case`);
      params.add(key);
    }
    for (const key of d.params.required ?? []) {
      if (!params.has(key)) errors.push(`params.required: "${key}" is not a property`);
    }
  }

  const none = new Set<string>();
  if (!d.target || typeof d.target !== 'object') {
    errors.push('target: required, with at least url');
  } else {
    unknownKeys(d.target, TARGET_KEYS, 'target', errors);
    if ((d.kind === 'write' || d.kind === 'send') && d.target.host === undefined) {
      errors.push(
        `target.host: required for kind ${d.kind}, so a redirect (a login page) stops the run before it commits`,
      );
    }
    if (typeof d.target.url !== 'string' || !/^(https?:\/\/|\{)/i.test(d.target.url)) {
      errors.push('target.url: an http(s) URL template');
    } else {
      checkRefs(d.target.url, 'target.url', params, none, errors);
    }
    if (d.target.host !== undefined) {
      if (typeof d.target.host !== 'string') errors.push('target.host: a host template');
      else checkRefs(d.target.host, 'target.host', params, none, errors);
    }
    if (d.target.profile !== undefined && typeof d.target.profile !== 'string') {
      errors.push('target.profile: a profile name');
    }
    if (d.target.own_window !== undefined && typeof d.target.own_window !== 'boolean') {
      errors.push('target.own_window: true or false');
    }
  }

  if (d.helpers !== undefined) {
    if (
      !Array.isArray(d.helpers) ||
      d.helpers.some((h) => typeof h !== 'string' || !IDENT.test(h))
    ) {
      errors.push('helpers: names of registry helpers, e.g. ["netsuite"]');
    }
  }

  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (steps.length === 0) errors.push('steps: at least one step');
  const earlier = new Set<string>();
  let commits = 0;
  steps.forEach((step, i) => {
    const at = `steps[${i}]${step && typeof step.id === 'string' ? ` (${step.id})` : ''}`;
    if (!step || typeof step !== 'object') {
      errors.push(`${at}: must be an object`);
      return;
    }
    if (typeof step.id !== 'string' || !IDENT.test(step.id)) {
      errors.push(`${at}.id: lower_snake_case, unique`);
    } else if (earlier.has(step.id)) {
      errors.push(`${at}.id: duplicate`);
    }
    if (!STEP_TYPES.includes(step.type)) {
      errors.push(`${at}.type: one of ${STEP_TYPES.join(', ')}`);
    } else {
      unknownKeys(step, STEP_KEYS[step.type], at, errors);
    }
    if (step.when !== undefined) checkCondition(step.when, `${at}.when`, earlier, errors);
    if (step.timeout_ms !== undefined) {
      if (
        typeof step.timeout_ms !== 'number' ||
        step.timeout_ms <= 0 ||
        step.timeout_ms > MAX_STEP_TIMEOUT_MS
      ) {
        errors.push(`${at}.timeout_ms: 1..${MAX_STEP_TIMEOUT_MS}`);
      }
    }
    if (step.commit !== undefined) {
      if (step.commit !== true && step.commit !== false) errors.push(`${at}.commit: true or false`);
      if (step.commit === true) {
        if (step.type !== 'js' && step.type !== 'tool') {
          errors.push(`${at}.commit: only a js or tool step commits`);
        }
        commits += 1;
      }
    }
    if (step.optional !== undefined && typeof step.optional !== 'boolean') {
      errors.push(`${at}.optional: true or false`);
    }
    switch (step.type) {
      case 'navigate':
        if (typeof step.url !== 'string' || !/^(https?:\/\/|\{)/i.test(step.url)) {
          errors.push(`${at}.url: an http(s) URL template`);
        } else {
          checkRefs(step.url, `${at}.url`, params, earlier, errors);
        }
        break;
      case 'wait_for': {
        const hasUntil = step.until !== undefined;
        const hasAny = step.any !== undefined;
        if (hasUntil === hasAny) {
          errors.push(`${at}: give until or any`);
        } else if (hasUntil) {
          if (typeof step.until === 'string') {
            const err = syntaxError(expressionBody(step.until));
            if (err) errors.push(`${at}.until: ${err}`);
          } else {
            checkCondition(step.until, `${at}.until`, earlier, errors);
          }
        } else if (!Array.isArray(step.any) || step.any.length === 0) {
          errors.push(`${at}.any: a non-empty array of conditions`);
        } else {
          step.any.forEach((cond, j) => {
            checkCondition(cond, `${at}.any[${j}]`, earlier, errors);
            if (typeof cond?.name !== 'string' || !cond.name) {
              errors.push(`${at}.any[${j}].name: required (it becomes the step value)`);
            }
          });
        }
        break;
      }
      case 'js':
      case 'verify': {
        const err =
          typeof step.code === 'string' && step.code.trim() !== ''
            ? syntaxError(step.code)
            : 'required';
        if (err) errors.push(`${at}.code: ${err}`);
        break;
      }
      case 'tool':
        if (
          typeof step.tool !== 'string' ||
          !(FN_TOOL_ALLOWLIST.includes(step.tool) || FN_BRIDGE_TOOL_ALLOWLIST.includes(step.tool))
        ) {
          errors.push(
            `${at}.tool: one of ${[...FN_TOOL_ALLOWLIST, ...FN_BRIDGE_TOOL_ALLOWLIST].join(', ')}`,
          );
        }
        if (
          step.args !== undefined &&
          (typeof step.args !== 'object' || Array.isArray(step.args))
        ) {
          errors.push(`${at}.args: an object`);
        } else {
          if (
            step.args &&
            ('tabId' in step.args || 'lease' in step.args || 'profile' in step.args)
          ) {
            errors.push(`${at}.args: tabId, lease and profile are set by the runner`);
          }
          const fromVault = vaultRef(step.args?.value);
          if (fromVault !== null) {
            if (!isVaultFillStep(step)) {
              errors.push(
                `${at}.args.value: a vault value only goes into a fill (chrome_computer action fill, or chrome_fill_or_select)`,
              );
            } else if (!d.vault || !Object.prototype.hasOwnProperty.call(d.vault, fromVault)) {
              errors.push(`${at}.args.value: {vault.${fromVault}} is not declared under vault`);
            }
          }
          // The vault value itself is not a template; every other string is.
          const { value: _vaultValue, ...otherArgs } = step.args ?? {};
          for (const text of stringsIn(fromVault !== null ? otherArgs : (step.args ?? {})))
            checkRefs(text, `${at}.args`, params, earlier, errors);
        }
        break;
      case 'pause':
        if (!Array.isArray(step.needs) || step.needs.length === 0) {
          errors.push(`${at}.needs: the params the caller supplies on resume`);
        } else {
          for (const need of step.needs) {
            if (!params.has(need)) errors.push(`${at}.needs: "${need}" is not a param`);
            else if ((d.params?.required ?? []).includes(need)) {
              errors.push(`${at}.needs: "${need}" is required up front; make it optional`);
            }
          }
        }
        if (step.message !== undefined)
          checkRefs(String(step.message), `${at}.message`, params, earlier, errors);
        break;
      case 'finish':
        for (const text of stringsIn(step.value))
          checkRefs(text, `${at}.value`, params, earlier, errors);
        break;
      case 'fail':
        if (typeof step.message !== 'string' || !step.message)
          errors.push(`${at}.message: required`);
        else checkRefs(step.message, `${at}.message`, params, earlier, errors);
        break;
      default:
        break;
    }
    if (typeof step.id === 'string') earlier.add(step.id);
  });

  if (d.kind === 'read' && commits > 0) {
    errors.push('kind read: no step may commit (use write or send)');
  }
  if ((d.kind === 'write' || d.kind === 'send') && commits === 0 && steps.length > 0) {
    errors.push(`kind ${d.kind}: mark the step that changes data with commit: true`);
  }
  for (const key of ['preview', 'result'] as const) {
    if (d[key] !== undefined && !earlier.has(d[key] as string)) {
      errors.push(`${key}: "${d[key]}" is not a step id`);
    }
  }
  // The dedupe key is checked before the window opens, so it can only use params.
  for (const key of ['dedupe_key', 'verify_hint'] as const) {
    if (d[key] !== undefined) {
      if (typeof d[key] !== 'string') errors.push(`${key}: a template string`);
      else checkRefs(d[key] as string, key, params, key === 'dedupe_key' ? none : earlier, errors);
    }
  }

  if (d.vault !== undefined) {
    // A typed secret must not outlive the call or meet code nobody reviewed:
    // no helpers, no pause or preview (the window would wait with the value in it).
    if (d.kind !== 'read') errors.push('vault: a function that types vault values is kind read');
    if (d.helpers?.length)
      errors.push('vault: a function that types vault values loads no helpers');
    if (steps.some((step) => step?.type === 'pause')) {
      errors.push('vault: a function that types vault values has no pause step');
    }
    if (d.target?.own_window === false) errors.push('vault: runs in a window of its own');
    if (!d.vault || typeof d.vault !== 'object' || Array.isArray(d.vault)) {
      errors.push('vault: name -> {item, field}');
    } else {
      for (const [key, entry] of Object.entries(d.vault)) {
        if (!IDENT.test(key)) errors.push(`vault.${key}: use lower_snake_case`);
        if (entry && typeof entry === 'object')
          unknownKeys(entry, ['item', 'field'], `vault.${key}`, errors);
        if (!entry || typeof entry.item !== 'string' || !entry.item) {
          errors.push(
            `vault.${key}.item: the vault item id, usually a param template like "{bw_item}"`,
          );
        } else {
          checkRefs(entry.item, `vault.${key}.item`, params, none, errors);
        }
        if (!['username', 'password', 'totp'].includes(entry?.field)) {
          errors.push(`vault.${key}.field: username, password or totp`);
        }
      }
    }
  }

  for (const hit of findSecretLiterals(d)) {
    errors.push(`${hit}: definitions must not embed credentials`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(d) ?? '', 'utf8');
  if (bytes > MAX_DEFINITION_BYTES) {
    errors.push(`definition is ${bytes} bytes; the limit is ${MAX_DEFINITION_BYTES}`);
  }
  return errors;
}

export function validateHelper(def: unknown): string[] {
  const errors: string[] = [];
  if (!def || typeof def !== 'object' || Array.isArray(def)) return ['helper must be an object'];
  const h = def as HelperDefinition;
  unknownKeys(h, ['name', 'description', 'version', 'code'], '', errors);
  if (typeof h.name !== 'string' || !isHelperName(h.name)) {
    errors.push('name: "_helpers.<word>", e.g. "_helpers.netsuite"');
  }
  if (typeof h.description !== 'string' || h.description.trim() === '') {
    errors.push('description: required');
  }
  if (typeof h.code !== 'string' || h.code.trim() === '') {
    errors.push('code: required (statements that add members to h)');
  } else {
    // The runner wraps helper code in a plain function: no top-level await.
    let err: string | null = null;
    try {
      new Function('h', h.code);
    } catch (e: any) {
      err = e?.message || String(e);
    }
    if (err)
      errors.push(
        `code: ${err} (helper code runs synchronously; await belongs inside its functions)`,
      );
  }
  for (const hit of findSecretLiterals(h)) {
    errors.push(`${hit}: helpers must not embed credentials`);
  }
  return errors;
}

/** The steps before the first commit step, i.e. what a preview runs. */
export function firstCommitIndex(def: FnDefinition): number {
  const idx = def.steps.findIndex((step) => step.commit === true);
  return idx === -1 ? def.steps.length : idx;
}

/** Params a pause step asks for: they may be missing when the run starts. */
export function pausedParams(def: FnDefinition): Set<string> {
  const out = new Set<string>();
  for (const step of def.steps) {
    if (step.type === 'pause') for (const need of step.needs ?? []) out.add(need);
  }
  return out;
}
