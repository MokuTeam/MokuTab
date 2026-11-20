/**
 * Generic out_file / auto-file post-processing for large tool results.
 *
 * Some module tools own a hand-written out_file hook (the Workato module's
 * recipe pull, LCAP page get, api_request and adapter_meta). Everything else
 * that can return a large result had no way out: a 200 KB job trace or a broad
 * step search went into the model's context whole.
 *
 * This module adds the same escape hatch to the rest of the read surface,
 * without a per-tool kind switch:
 *
 *   <read tool>(out_file)   -> writes the full text, returns a summary
 *   <read tool>(auto_file)  -> same, but only once the result crosses a
 *                              character threshold (on by default for reads)
 *   chrome_screenshot(out_file) -> writes the decoded image bytes
 *   chrome_javascript(out_file) -> writes the returned value itself, unredacted
 *                              (inline results and auto_file spills stay redacted)
 *
 * It runs in the native-server (a Node process with `fs`); the Chrome
 * extension never sees the file params. See register-tools.ts for the wiring.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { foldTexts } from './tool-result';

export const SCREENSHOT_TOOL = 'chrome_screenshot';
export const JAVASCRIPT_TOOL = 'chrome_javascript';

/**
 * Internal arg the bridge adds to a chrome_javascript call with an explicit
 * out_file: the extension then returns the value unredacted, for the file only.
 * Never accepted from the caller.
 */
export const RAW_OUTPUT_ARG = 'rawOutput';

/** Default spill threshold, in characters of response text. */
export const DEFAULT_AUTO_FILE_THRESHOLD_CHARS = 60000;

export const OUT_FILE_ARG = 'out_file';
export const AUTO_FILE_ARG = 'auto_file';
export const AUTO_FILE_THRESHOLD_ARG = 'auto_file_threshold_chars';
export const NO_INLINE_ARG = 'no_inline';

/**
 * Which tools auto-file serves. Core has its own rules; a module contributes
 * its read tools (and the tools that accept an explicit out_file) through
 * BridgeModule.autoFile, and the router combines them.
 */
export interface AutoFileRules {
  /** Spill on their own once a result gets large; their schema gains the file params. */
  readTools: ReadonlySet<string>;
  /** Also gain out_file / auto_file in the served schema, but spill only when asked. */
  advertised?: ReadonlySet<string>;
  /** Also accept an explicit out_file / auto_file, without advertising it. */
  accepts?(name: string): boolean;
  /** Stem of an auto-generated file name (default: the tool name). */
  fileStem?(name: string): string | undefined;
}

/**
 * Core read tools that spill to a file on their own once a result gets large:
 * browser reads whose output grows with the page. A big snapshot, page text,
 * script result or match list spills to a file instead of the context.
 */
export const CORE_READ_TOOLS = new Set<string>([
  'chrome_snapshot',
  'chrome_get_web_content',
  'chrome_javascript',
  'chrome_search_page',
  'chrome_find_elements',
  // chrome_act is deliberately absent: its step results and page report
  // ("the action opened a dialog", "stopped: the page navigated") must reach
  // the agent inline, never as a summary of a file.
]);

export const CORE_AUTO_FILE_RULES: AutoFileRules = {
  readTools: CORE_READ_TOOLS,
  advertised: new Set([SCREENSHOT_TOOL]),
};

/** One rule set from core plus every module's. */
export function combineAutoFileRules(rules: AutoFileRules[]): AutoFileRules {
  const readTools = new Set<string>();
  const advertised = new Set<string>();
  for (const rule of rules) {
    for (const name of rule.readTools) readTools.add(name);
    for (const name of rule.advertised ?? []) advertised.add(name);
  }
  return {
    readTools,
    advertised,
    accepts: (name) => rules.some((rule) => rule.accepts?.(name) === true),
    fileStem: (name) => {
      for (const rule of rules) {
        const stem = rule.fileStem?.(name);
        if (stem !== undefined) return stem;
      }
      return undefined;
    },
  };
}

function advertisesFileParams(name: string, rules: AutoFileRules): boolean {
  return rules.readTools.has(name) || rules.advertised?.has(name) === true;
}

export interface AutoFilePlan {
  tool: string;
  /** Explicit destination, already resolved and checked. */
  outFile?: string;
  /** Spill automatically once the result crosses `thresholdChars`. */
  auto: boolean;
  thresholdChars: number;
  /** For image results: leave the image block out of the response. */
  noInline: boolean;
  /** chrome_javascript with an explicit out_file: write the unredacted value itself. */
  raw?: boolean;
  /** Recipe/job/table id used to name an auto-generated file. */
  idHint?: string;
  /** Stem of an auto-generated file name, when it is not the tool name. */
  fileStem?: string;
}

export interface PreparedAutoFileCall {
  args: Record<string, unknown>;
  plan?: AutoFilePlan;
}

const OUT_FILE_PROPERTY = {
  type: 'string',
  description:
    'Absolute path for the full result (the directory must exist). The reply becomes a summary: saved_to, bytes, keys, item counts.',
};

const AUTO_FILE_PROPERTY = {
  type: 'boolean',
  description:
    'false: always inline. true: a large result goes to a temp file and the reply is its summary (saved_to). Default true, chrome_screenshot false.',
};

const AUTO_FILE_THRESHOLD_PROPERTY = {
  type: 'number',
  description: `auto_file threshold in characters (default ${DEFAULT_AUTO_FILE_THRESHOLD_CHARS}).`,
};

/**
 * Serve out_file / auto_file on every tool that supports them, so the per-tool
 * schema entries do not each have to repeat the three properties.
 */
export function withOutFileToolSchemas(
  tools: Tool[],
  rules: AutoFileRules = CORE_AUTO_FILE_RULES,
): Tool[] {
  return tools.map((tool) => {
    if (!advertisesFileParams(tool.name, rules)) return tool;

    const inputSchema = (tool.inputSchema || { type: 'object' }) as Record<string, any>;
    if (inputSchema.type !== 'object') return tool;

    const properties = { ...(inputSchema.properties || {}) };
    if (!properties[OUT_FILE_ARG]) properties[OUT_FILE_ARG] = OUT_FILE_PROPERTY;
    if (!properties[AUTO_FILE_ARG]) properties[AUTO_FILE_ARG] = AUTO_FILE_PROPERTY;
    if (!properties[AUTO_FILE_THRESHOLD_ARG]) {
      properties[AUTO_FILE_THRESHOLD_ARG] = AUTO_FILE_THRESHOLD_PROPERTY;
    }

    return {
      ...tool,
      inputSchema: {
        ...inputSchema,
        type: 'object',
        properties,
        required: Array.isArray(inputSchema.required) ? inputSchema.required : [],
      },
    };
  });
}

/** Tools this post-processor may write files for. */
export function isAutoFileEligible(
  name: string,
  rules: AutoFileRules = CORE_AUTO_FILE_RULES,
): boolean {
  return advertisesFileParams(name, rules) || rules.accepts?.(name) === true;
}

/** Tools that spill without being asked. */
export function autoFileDefaultsOn(
  name: string,
  rules: AutoFileRules = CORE_AUTO_FILE_RULES,
): boolean {
  return rules.readTools.has(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resolveOutFile(raw: string): string {
  const outFile = path.resolve(raw);
  const dir = path.dirname(outFile);
  if (!fs.existsSync(dir)) {
    throw new Error(`${OUT_FILE_ARG} directory does not exist: ${dir}`);
  }
  // Caught here, before any browser work: a write onto a directory fails only
  // after the result came back, and a job result is not read again for long.
  if (fs.existsSync(outFile) && fs.statSync(outFile).isDirectory()) {
    throw new Error(`${OUT_FILE_ARG} is a directory, not a file path: ${outFile}`);
  }
  return outFile;
}

/** Atomic write: temp file then rename, so a crash cannot leave half a file. */
function writeAtomic(target: string, data: string | Buffer): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data as any);
  fs.renameSync(tmp, target);
}

const ID_HINT_KEYS = [
  'recipe_id',
  'job_id',
  'job',
  'table_id',
  'page_id',
  'connection_id',
  'folder_id',
  'app_id',
  'id',
  'tabId',
];

function readIdHint(args: Record<string, unknown>): string | undefined {
  for (const key of ID_HINT_KEYS) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim().length > 0) return sanitizeSegment(value);
  }
  return undefined;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40) || 'result';
}

const SESSION_STAMP = `${process.pid}-${Date.now().toString(36)}`;

/** Where auto-mode files go: one directory per bridge process. */
export function autoFileSessionDir(): string {
  return path.join(os.tmpdir(), 'mokutab-results', `session-${SESSION_STAMP}`);
}

function autoFilePath(plan: AutoFilePlan, extension: string): string {
  const dir = autoFileSessionDir();
  fs.mkdirSync(dir, { recursive: true });
  const slug = sanitizeSegment(plan.fileStem ?? plan.tool) || 'tool';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${slug}-${plan.idHint || 'result'}-${stamp}${extension}`);
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  return '.bin';
}

function readBoolean(value: unknown, argName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${argName} must be a boolean`);
  }
  return value;
}

function readThreshold(value: unknown): number {
  if (value === undefined) return DEFAULT_AUTO_FILE_THRESHOLD_CHARS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${AUTO_FILE_THRESHOLD_ARG} must be a non-negative number of characters`);
  }
  return value;
}

/**
 * Resolve the file params before the call leaves for the extension, the way
 * prepareWorkatoCall does: the extension never learns about paths, and a bad
 * out_file directory fails before any browser work happens.
 */
export function prepareAutoFileCall(
  name: string,
  rawArgs: Record<string, unknown>,
  rules: AutoFileRules = CORE_AUTO_FILE_RULES,
): PreparedAutoFileCall {
  if (!isAutoFileEligible(name, rules)) return { args: rawArgs };

  const hasOutFile = rawArgs[OUT_FILE_ARG] !== undefined;
  const hasAuto = rawArgs[AUTO_FILE_ARG] !== undefined;
  const hasThreshold = rawArgs[AUTO_FILE_THRESHOLD_ARG] !== undefined;
  const hasNoInline = rawArgs[NO_INLINE_ARG] !== undefined;
  const defaultsOn = autoFileDefaultsOn(name, rules);
  if (!hasOutFile && !hasAuto && !hasThreshold && !hasNoInline && !defaultsOn) {
    return { args: rawArgs };
  }

  let outFile: string | undefined;
  if (hasOutFile) {
    const raw = rawArgs[OUT_FILE_ARG];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new Error(`${OUT_FILE_ARG} must be a non-empty absolute path`);
    }
    outFile = resolveOutFile(raw);
  }

  const auto = readBoolean(rawArgs[AUTO_FILE_ARG], AUTO_FILE_ARG) ?? defaultsOn;
  const noInline = readBoolean(rawArgs[NO_INLINE_ARG], NO_INLINE_ARG) ?? false;
  const thresholdChars = readThreshold(rawArgs[AUTO_FILE_THRESHOLD_ARG]);

  const args = { ...rawArgs };
  delete args[OUT_FILE_ARG];
  delete args[AUTO_FILE_ARG];
  delete args[AUTO_FILE_THRESHOLD_ARG];
  // no_inline is read here, like the rest: the extension never sees a file param.
  delete args[NO_INLINE_ARG];
  // Unredacted output is only ever produced for a file the caller named.
  delete args[RAW_OUTPUT_ARG];
  const raw = name === JAVASCRIPT_TOOL && outFile !== undefined;
  if (raw) args[RAW_OUTPUT_ARG] = true;
  const fileStem = rules.fileStem?.(name);

  return {
    args,
    plan: {
      tool: name,
      outFile,
      auto,
      thresholdChars,
      noInline,
      idHint: readIdHint(rawArgs),
      ...(fileStem !== undefined && fileStem !== name ? { fileStem } : {}),
      ...(raw ? { raw: true } : {}),
    },
  };
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface ImageBlock {
  type: 'image';
  data: string;
  mimeType?: string;
}

function textBlocks(result: CallToolResult): TextBlock[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.filter(
    (block: any) => block && block.type === 'text' && typeof block.text === 'string',
  ) as unknown as TextBlock[];
}

function firstImageBlock(result: CallToolResult): ImageBlock | undefined {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.find(
    (block: any) =>
      block && block.type === 'image' && typeof block.data === 'string' && block.data.length > 0,
  ) as unknown as ImageBlock | undefined;
}

/**
 * Parse a response payload. Handles the plain-JSON form and the
 * `${summary}\n${JSON.stringify(payload)}` form several Workato tools use.
 */
export function parseResultPayload(text: string): unknown {
  const attempt = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };
  const whole = attempt(text.trim());
  if (whole !== undefined) return whole;

  const braceAt = text.indexOf('{');
  const bracketAt = text.indexOf('[');
  const candidates = [braceAt, bracketAt].filter((index) => index > 0).sort((a, b) => a - b);
  for (const index of candidates) {
    const parsed = attempt(text.slice(index).trim());
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** Keys copied verbatim into the summary so a partial result cannot read as complete. */
const TRUNCATION_KEYS = [
  'truncated',
  'truncated_fields',
  'total_bytes',
  'total_items',
  'total_count',
  'has_more',
  'next_page',
  'next_cursor',
  'limit',
  'coverage',
  'search_mode',
  'warning',
];

function describePayload(payload: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  if (Array.isArray(payload)) {
    summary.top_level_keys = [];
    summary.item_counts = { items: payload.length };
    return summary;
  }
  if (!isRecord(payload)) {
    summary.top_level_keys = [];
    summary.item_counts = {};
    return summary;
  }

  const keys = Object.keys(payload);
  summary.top_level_keys = keys.slice(0, 100);
  const counts: Record<string, number> = {};
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) counts[key] = value.length;
  }
  summary.item_counts = counts;
  if (payload.version_no !== undefined) summary.version_no = payload.version_no;
  for (const key of TRUNCATION_KEYS) {
    // Preserve 0 and false: "truncated: false" is information, not noise.
    if (payload[key] !== undefined) summary[key] = payload[key];
  }
  return summary;
}

const SUMMARY_NOTE =
  'full result written to file; read it with your file tools or re-run with narrower projection';

function summaryBlock(payload: Record<string, unknown>): TextBlock {
  return { type: 'text', text: JSON.stringify(payload) };
}

/**
 * Post-process a response destined for disk: write the file and hand back a
 * summary. Returns the original result untouched when nothing needs writing,
 * when the call failed, or when the response carries nothing writable.
 *
 * A failed write in auto mode also returns the original result: the caller
 * asked for data, not for a file, so losing the data to a disk error would be
 * the worse outcome. An explicit out_file failure is raised.
 */
export function applyAutoFile(
  name: string,
  plan: AutoFilePlan | undefined,
  result: CallToolResult,
): CallToolResult {
  if (!plan) return result;
  if (result.isError) return result;
  if (!Array.isArray(result.content) || result.content.length === 0) return result;

  // The extension appends a small {"context":...} text block last; it describes
  // the tab the call ran in and must stay on the response, never in the file.
  const contextBlock = trailingContextBlock(result);
  const body: CallToolResult = contextBlock
    ? { ...result, content: result.content.slice(0, -1) }
    : result;
  const image = firstImageBlock(body);
  const texts = textBlocks(body);
  const measuredChars =
    texts.reduce((total, block) => total + block.text.length, 0) + (image ? image.data.length : 0);

  const explicit = plan.outFile !== undefined;
  const shouldWrite = explicit || (plan.auto && measuredChars > plan.thresholdChars);
  if (!shouldWrite) return result;

  try {
    const written = image
      ? writeImageResult(name, plan, image, texts)
      : plan.raw && explicit
        ? writeRawValueResult(name, plan, body, texts)
        : writeTextResult(name, plan, body, texts);
    if (written === body) return result;
    return contextBlock
      ? { ...written, content: [...written.content, contextBlock as any] }
      : written;
  } catch (err) {
    if (explicit) throw err;
    return result;
  }
}

/** The trailing actual-context block the extension appends, if present. */
function trailingContextBlock(result: CallToolResult): TextBlock | undefined {
  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length < 2) return undefined;
  const last: any = content[content.length - 1];
  if (last?.type !== 'text' || typeof last.text !== 'string') return undefined;
  return last.text.startsWith('{"context":') ? (last as TextBlock) : undefined;
}

function writeImageResult(
  name: string,
  plan: AutoFilePlan,
  image: ImageBlock,
  texts: TextBlock[],
): CallToolResult {
  const mimeType = image.mimeType || 'image/png';
  const bytes = Buffer.from(image.data, 'base64');
  const target = plan.outFile ?? autoFilePath(plan, extensionForMime(mimeType));
  writeAtomic(target, bytes);

  const payload = texts.length > 0 ? parseResultPayload(texts[0].text) : undefined;
  const summary: Record<string, unknown> = {
    tool: name,
    mode: plan.outFile ? 'out_file' : 'auto_file',
    saved_to: target,
    bytes: bytes.length,
    content_type: mimeType,
    ...describePayload(payload),
    image_returned: !plan.noInline,
    note: plan.noInline
      ? SUMMARY_NOTE
      : 'image written to file and returned inline; open the file for the full-resolution copy',
  };
  if (isRecord(payload)) summary.metadata = payload;

  const content: CallToolResult['content'] = [];
  if (!plan.noInline) content.push(image as any);
  content.push(summaryBlock(summary) as any);
  return { content, isError: false };
}

/**
 * Envelope fields of a chrome_javascript reply worth keeping next to the file.
 * warnings matters most: it says when the code ran in the isolated world (the
 * debugger was busy), which changes what the file contains.
 */
const RAW_ENVELOPE_KEYS = [
  'tabId',
  'engine',
  'job_id',
  'state',
  'job_ms',
  'truncated',
  'warnings',
  'message',
  'metrics',
];

/**
 * chrome_javascript(out_file): the file gets the returned value itself (the
 * `result` string), not the JSON envelope around it. A reply without a result
 * (a job poll that is still running) writes nothing and goes back as is.
 */
function writeRawValueResult(
  name: string,
  plan: AutoFilePlan,
  result: CallToolResult,
  texts: TextBlock[],
): CallToolResult {
  if (texts.length === 0 || !plan.outFile) return result;
  const payload = parseResultPayload(texts.map((block) => block.text).join('\n'));
  if (!isRecord(payload) || typeof payload.result !== 'string') return result;

  const text = payload.result;
  writeAtomic(plan.outFile, text);
  let isJson = false;
  try {
    JSON.parse(text);
    isJson = true;
  } catch {
    isJson = false;
  }

  // An extension build older than rawOutput still redacts: say so.
  const redacted = payload.redacted === true;
  const summary: Record<string, unknown> = {
    tool: name,
    mode: 'out_file',
    saved_to: plan.outFile,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    raw: !redacted,
    content_type: isJson ? 'application/json' : 'text/plain',
  };
  for (const key of RAW_ENVELOPE_KEYS) {
    if (payload[key] !== undefined) summary[key] = payload[key];
  }
  if (redacted) summary.redacted = true;
  summary.note = redacted
    ? 'returned value written to file, but the extension redacted it (reload the extension)'
    : 'returned value written to file unredacted; read it with your file tools';

  return { content: [summaryBlock(summary) as any], isError: false };
}

function writeTextResult(
  name: string,
  plan: AutoFilePlan,
  result: CallToolResult,
  texts: TextBlock[],
): CallToolResult {
  if (texts.length === 0) return result;
  // The file holds what the call would have returned inline: the same single
  // JSON object (minus the context), so it parses as it is. Text stays text.
  const folded = foldTexts(texts.map((block) => block.text));
  const isJson = folded !== null;
  const text = folded ?? texts.map((block) => block.text).join('\n');
  const payload = parseResultPayload(text);

  const target = plan.outFile ?? autoFilePath(plan, isJson ? '.json' : '.txt');
  writeAtomic(target, text);

  return {
    content: [
      summaryBlock({
        tool: name,
        mode: plan.outFile ? 'out_file' : 'auto_file',
        saved_to: target,
        bytes: Buffer.byteLength(text, 'utf8'),
        content_type: isJson ? 'application/json' : 'text/plain',
        ...describePayload(payload),
        note: SUMMARY_NOTE,
      }) as any,
    ],
    isError: false,
  };
}
