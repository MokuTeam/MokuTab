/**
 * Small readers for tool results, shared by the router and the modules.
 *
 * The context block is a core convention: a module's extension side may append
 * one trailing `{"context":{...}}` text block naming the tab a call ran in.
 * The router stamps the routed profile into it (only the bridge knows that)
 * and auto-file keeps it out of spilled files.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type JsonObject = Record<string, any>;

export const CONTEXT_BLOCK_PREFIX = '{"context":';

/** The first text block of a result, or ''. */
export function firstText(result: CallToolResult | undefined): string {
  const block = Array.isArray(result?.content)
    ? result.content.find((item: any) => item?.type === 'text')
    : undefined;
  return typeof (block as any)?.text === 'string' ? (block as any).text : '';
}

/** Parse the last JSON object line of a `summary\nJSON` tool response. */
export function parseLastJsonObject(text: string): JsonObject | null {
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next line */
    }
  }
  return null;
}

/** Index of the trailing context block, if any. */
function contextBlockIndex(result: CallToolResult | undefined): number {
  if (!result || !Array.isArray(result.content) || result.content.length === 0) return -1;
  const last = result.content.length - 1;
  const block: any = result.content[last];
  if (block?.type !== 'text' || typeof block.text !== 'string') return -1;
  return block.text.startsWith(CONTEXT_BLOCK_PREFIX) ? last : -1;
}

/** The trailing context block, parsed. Null when there is none. */
export function readContextBlock(result: CallToolResult | undefined): JsonObject | null {
  const index = contextBlockIndex(result);
  if (index < 0) return null;
  try {
    const parsed = JSON.parse((result!.content[index] as any).text);
    const context = parsed?.context;
    return context && typeof context === 'object' && !Array.isArray(context) ? context : null;
  } catch {
    return null;
  }
}

/**
 * Add the routed profile to the context block. The extension knows the tab
 * (and a module its own fields); only the bridge knows which profile the call
 * went to.
 */
export function stampContextBlock(result: CallToolResult, profile: string | null): CallToolResult {
  const index = contextBlockIndex(result);
  if (index < 0) return result;
  const context = readContextBlock(result);
  if (!context) return result;
  const content = [...result.content];
  content[index] = {
    type: 'text',
    text: JSON.stringify({ context: { ...context, profile: profile ?? null } }),
  };
  return { ...result, content };
}

// ---------------------------------------------------------------------------
// One JSON object per result
// ---------------------------------------------------------------------------
//
// Tools answer in several text shapes: a JSON object, a JSON array, a headline
// then JSON on the next line, and any of those followed by the context block.
// A client that runs tools from a script gets a parsed object only when the
// result is a single JSON text block, so the router folds every result into
// that on the way out: the headline under `headline`, an array under `items`,
// the tab under `context`, a failure under `error: {code, message}`.
// Results with no JSON and no context (a snapshot, page text) and results with
// an image stay as they are. Only the router's exit calls this: orchestrators
// that call extension tools themselves still read the shapes above.

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function startsJson(text: string, at: number): boolean {
  const char = text[at];
  return char === '{' || char === '[';
}

export interface SplitText {
  /** Text ahead of the JSON, or the whole text when there is no JSON. */
  summary?: string;
  /** The JSON object or array as it was written. */
  json?: string;
  value?: unknown;
}

/**
 * Split one text into its headline and its JSON object or array: the whole
 * text, or the `${summary}\n${JSON}` form, where the JSON starts a line and
 * runs to the end.
 */
export function splitSummaryAndJson(text: string): SplitText {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  if (startsJson(trimmed, 0)) {
    const whole = parseJsonText(trimmed);
    if (whole.ok) return { json: trimmed, value: whole.value };
  }
  let newline = trimmed.indexOf('\n');
  while (newline >= 0) {
    if (startsJson(trimmed, newline + 1)) {
      const json = trimmed.slice(newline + 1);
      const parsed = parseJsonText(json);
      if (parsed.ok) {
        const summary = trimmed.slice(0, newline).trim();
        return { ...(summary ? { summary } : {}), json, value: parsed.value };
      }
    }
    newline = trimmed.indexOf('\n', newline + 1);
  }
  return { summary: trimmed };
}

/**
 * JSON text is reused as written rather than re-serialized, so a number a
 * server sent (a long id, 1.0) reads the same in the result. A raw newline can
 * only be formatting, never part of a string, so pretty-printed text is the
 * one case that is written again.
 */
function compactJson(json: string, value: unknown): string {
  return json.includes('\n') ? JSON.stringify(value) : json;
}

/** `name`, or `_name` when the payload has a key of that name already. */
function freeKey(payload: JsonObject, name: string): string {
  return Object.prototype.hasOwnProperty.call(payload, name) ? `_${name}` : name;
}

/**
 * The texts of one result as a single JSON object, or null when they hold no
 * JSON and there is no context: that result is plain text and stays text.
 */
export function foldTexts(texts: string[], context?: JsonObject | null): string | null {
  const summaries: string[] = [];
  const payloads: { json: string; value: unknown }[] = [];
  for (const text of texts) {
    const split = splitSummaryAndJson(text);
    // Two JSON documents in one text: the one in front is data, not a headline.
    const lead =
      split.summary !== undefined && split.json !== undefined && startsJson(split.summary, 0)
        ? parseJsonText(split.summary)
        : undefined;
    if (lead?.ok) payloads.push({ json: split.summary!, value: lead.value });
    else if (split.summary) summaries.push(split.summary);
    if (split.json !== undefined) payloads.push({ json: split.json, value: split.value });
  }
  if (payloads.length === 0 && !context) return null;

  let body = '{}';
  let own: JsonObject = {};
  if (payloads.length === 1 && isRecord(payloads[0].value)) {
    own = payloads[0].value;
    body = compactJson(payloads[0].json, own);
  } else if (payloads.length === 1) {
    own = { items: true };
    body = `{"items":${compactJson(payloads[0].json, payloads[0].value)}}`;
  } else if (payloads.length > 1) {
    own = { results: true };
    body = `{"results":[${payloads.map((p) => compactJson(p.json, p.value)).join(',')}]}`;
  }

  const members: string[] = [];
  if (summaries.length > 0) {
    // Text ahead of data is its headline; text that is the whole result is text.
    // Not `summary`: several payloads have a summary of their own.
    const key = payloads.length > 0 ? freeKey(own, 'headline') : 'text';
    members.push(`${JSON.stringify(key)}:${JSON.stringify(summaries.join('\n'))}`);
  }
  const inner = body.slice(1, -1).trim();
  if (inner) members.push(inner);
  if (context) {
    members.push(`${JSON.stringify(freeKey(own, 'context'))}:${JSON.stringify(context)}`);
  }
  return `{${members.join(',')}}`;
}

/** Code of a failure that names none. */
export const DEFAULT_ERROR_CODE = 'ToolError';

const ERROR_PREFIX = /^(?:Error calling tool:\s*|Error:\s*)+/;
/**
 * `TabNotFound: ...`, `VersionConflict: ...`, `WorkatoApiError (meta): ...`: the
 * code a refusal starts with, and the stage some of them name after it. A
 * tool may put its own name first (`workato_whoami failed: TabNotFound: ...`);
 * that stays in the message.
 */
const ERROR_CODE =
  /^((?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?: failed)?:\s+)?)([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)(?: \(([^)]*)\))?:\s+/;
/** A `--- body excerpt ---` line that only introduced the JSON under it. */
const TRAILING_RULE = /\n-{3}[^\n]*-{3}\s*$/;

/**
 * A failed result as `{"error":{"code","message"}, ...}`. A failure that was
 * one JSON object keeps its other fields beside the error; JSON that followed
 * a message (a response body, say) goes under `details`.
 */
function foldErrorTexts(texts: string[]): string {
  const joined = texts.join('\n').trim();
  const split = splitSummaryAndJson(joined);
  let details: JsonObject = {};
  let message = joined;
  if (split.json !== undefined) {
    if (isRecord(split.value)) {
      details = { ...split.value };
      const own = details.error;
      if (isRecord(own) && typeof own.code === 'string' && typeof own.message === 'string') {
        return JSON.stringify(split.summary ? { headline: split.summary, ...details } : details);
      }
      const named =
        typeof own === 'string'
          ? own
          : typeof details.message === 'string'
            ? details.message
            : undefined;
      if (split.summary !== undefined) {
        message = split.summary.replace(TRAILING_RULE, '');
        details = { details: split.value };
      } else {
        message = named ?? 'The call failed; the other fields say how.';
        if (typeof own === 'string') delete details.error;
        else if (own !== undefined) {
          details.error_detail = own;
          delete details.error;
        }
        if (named !== undefined && named === details.message) delete details.message;
      }
    } else {
      details = { details: split.value };
      message = (split.summary ?? 'The call failed; details holds what it returned.').replace(
        TRAILING_RULE,
        '',
      );
    }
  }
  message = message.replace(ERROR_PREFIX, '');
  const coded = ERROR_CODE.exec(message);
  let code = DEFAULT_ERROR_CODE;
  if (coded) {
    code = coded[2];
    message = coded[1] + (coded[3] ? `(${coded[3]}) ` : '') + message.slice(coded[0].length);
  } else if (typeof details.code === 'string' && details.code !== '') {
    code = details.code;
    delete details.code;
  }
  return JSON.stringify({ error: { code, message }, ...details });
}

/** The context of a result's last block, when that block is only the context. */
function trailingContext(texts: string[]): JsonObject | null {
  const last = texts[texts.length - 1];
  if (!last.startsWith(CONTEXT_BLOCK_PREFIX)) return null;
  const parsed = parseJsonText(last);
  if (!parsed.ok || !isRecord(parsed.value)) return null;
  const keys = Object.keys(parsed.value);
  return keys.length === 1 && isRecord(parsed.value.context) ? parsed.value.context : null;
}

/**
 * Fold a tool result into one JSON text block (see the note above). Returns
 * the same result when it is already one compact JSON object, when it is plain
 * text, or when it carries anything but text.
 */
export function foldToolResult(result: CallToolResult): CallToolResult {
  const content = result?.content;
  if (!Array.isArray(content) || content.length === 0) return result;
  const texts: string[] = [];
  for (const block of content as any[]) {
    if (block?.type !== 'text' || typeof block.text !== 'string') return result;
    texts.push(block.text);
  }

  let folded: string | null;
  if (result.isError) {
    folded = foldErrorTexts(texts);
  } else {
    const context = trailingContext(texts);
    folded = foldTexts(context ? texts.slice(0, -1) : texts, context);
  }
  if (folded === null) return result;
  if (texts.length === 1 && texts[0] === folded) return result;
  return { ...result, content: [{ type: 'text', text: folded }] };
}
