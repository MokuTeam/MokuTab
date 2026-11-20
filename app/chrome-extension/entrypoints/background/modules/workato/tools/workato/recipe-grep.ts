/**
 * workato_recipe_grep: find a string inside one recipe without exporting it.
 *
 * The question "where is this field set?" used to cost a whole recipe: pull it
 * compact (94k characters on a real one), read it, scroll. The recipe is
 * already in the service worker after one fetch, so the search belongs here:
 * the tree is walked locally and ONLY the matches enter the response, each
 * with the step it belongs to, the exact path, and a bounded snippet.
 *
 * The path a match reports is the path `workato_pull_recipe(step, paths:[...])`
 * resolves, so a hit turns straight into a lossless read of that value, and
 * `workato_recipe_set_input_path` takes the same shape minus the `input.`
 * prefix.
 *
 * Regex is bounded on purpose: a service worker has no RegExp timeout, so a
 * catastrophic pattern would hang the extension until the dispatch timeout.
 * Patterns are length-limited, screened for nested quantifiers, and run
 * against a capped slice of each value.
 */

import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { loadRecipeSnapshot } from './pull-recipe';
import { decodeCursor, encodeCursor } from './recipe-projection';
import { stripHtml, type RawNode } from './recipe-view';
import { riskyRegexReason } from '@/entrypoints/background/tools/browser/regex-safety';

export {
  REGEX_MAX_PATTERN_CHARS,
  riskyRegexReason,
} from '@/entrypoints/background/tools/browser/regex-safety';

export type GrepMatchMode = 'substring' | 'word' | 'regex';
export type GrepScope = 'input' | 'all';

/** Characters of a single value a regex is run against. */
export const REGEX_INPUT_CAP_CHARS = 20_000;

/** Default and maximum matches returned. */
export const DEFAULT_MAX_MATCHES = 50;
export const MAX_MAX_MATCHES = 500;

/** Default and range of the snippet around a match. */
export const DEFAULT_SNIPPET_CHARS = 160;
export const MIN_SNIPPET_CHARS = 20;
export const MAX_SNIPPET_CHARS = 2_000;

/** Ceiling on matches counted, so a pathological query cannot run unbounded. */
const MAX_COUNTED_MATCHES = 100_000;

export interface GrepStepIdentity {
  number?: number;
  as?: string;
  keyword?: string;
  provider?: string;
  name?: string;
  title?: string;
}

export interface GrepMatch {
  step: GrepStepIdentity;
  path: string;
  snippet: string;
  value_chars: number;
  /** Set when only the first REGEX_INPUT_CAP_CHARS of the value were searched. */
  input_capped?: true;
}

export interface GrepResult {
  matches: GrepMatch[];
  total_matches: number;
  truncated: boolean;
  next_cursor?: string;
  steps_scanned: number;
  values_scanned: number;
}

export interface GrepOptions {
  scope?: GrepScope;
  maxMatches?: number;
  snippetChars?: number;
  offset?: number;
}

export interface GrepMatcher {
  /** Index of the first match in `value`, or -1. */
  find: (value: string) => { index: number; length: number } | null;
  /** True when values are truncated before matching (regex only). */
  capsInput: boolean;
}

export type MatcherResult = { ok: true; matcher: GrepMatcher } | { ok: false; error: string };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the matcher for one query/mode pair, or explain why it is refused. */
export function compileGrepMatcher(query: string, mode: GrepMatchMode): MatcherResult {
  if (query.length === 0) return { ok: false, error: 'Param [query] must not be empty' };

  if (mode === 'substring') {
    const needle = query.toLowerCase();
    return {
      ok: true,
      matcher: {
        capsInput: false,
        find: (value) => {
          const index = value.toLowerCase().indexOf(needle);
          return index === -1 ? null : { index, length: needle.length };
        },
      },
    };
  }

  const source = mode === 'word' ? `\\b${escapeRegExp(query)}\\b` : query;
  if (mode === 'regex') {
    const risky = riskyRegexReason(query);
    if (risky) return { ok: false, error: `Refused regex: ${risky}` };
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(source, 'i');
  } catch (err) {
    return {
      ok: false,
      error: `Invalid ${mode} pattern: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    matcher: {
      capsInput: mode === 'regex',
      find: (value) => {
        const hit = compiled.exec(value);
        return hit === null ? null : { index: hit.index, length: hit[0].length };
      },
    },
  };
}

/** A window of `snippetChars` around the match, with elision markers. */
export function buildSnippet(
  value: string,
  index: number,
  matchLength: number,
  snippetChars: number,
): string {
  if (value.length <= snippetChars) return value;
  const pad = Math.max(0, Math.floor((snippetChars - matchLength) / 2));
  let start = Math.max(0, index - pad);
  const end = Math.min(value.length, start + snippetChars);
  start = Math.max(0, Math.min(start, end - snippetChars));
  const body = value.slice(start, end);
  return `${start > 0 ? '…' : ''}${body}${end < value.length ? '…' : ''}`;
}

function identity(node: RawNode): GrepStepIdentity {
  const step: GrepStepIdentity = {};
  if (typeof node.number === 'number') step.number = node.number;
  if (typeof node.as === 'string') step.as = node.as;
  if (typeof node.keyword === 'string') step.keyword = node.keyword;
  if (typeof node.provider === 'string') step.provider = node.provider;
  if (typeof node.name === 'string') step.name = node.name;
  if (typeof node.title === 'string' && node.title !== '') step.title = node.title;
  return step;
}

/** Every string leaf under a value, with its dotted/bracketed path. */
function collectStrings(
  value: unknown,
  path: string,
  out: Array<{ path: string; value: string }>,
): void {
  if (typeof value === 'string') {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, path ? `${path}.${key}` : key, out);
    }
  }
}

/** The searchable values of one node, in a stable order. */
export function searchableValues(
  node: RawNode,
  scope: GrepScope,
): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  if (scope === 'all') {
    if (typeof node.title === 'string' && node.title !== '') {
      out.push({ path: 'title', value: node.title });
    }
    if (typeof node.description === 'string' && node.description !== '') {
      out.push({ path: 'description', value: stripHtml(node.description) });
    }
    if (typeof node.comment === 'string' && node.comment !== '') {
      out.push({ path: 'comment', value: node.comment });
    }
    if (node.source !== undefined) collectStrings(node.source, 'source', out);
    // The callee of a call_recipe step is an id in `input.flow_id`; its NAME
    // exists only here, so "which step calls <recipe name>" needs this key.
    if (node.dynamicPickListSelection !== undefined) {
      collectStrings(node.dynamicPickListSelection, 'dynamicPickListSelection', out);
    }
    // Job report columns live on the trigger node: the labels in
    // job_report_schema and the values (often datapills) in job_report_config.
    if (node.job_report_schema !== undefined) {
      collectStrings(node.job_report_schema, 'job_report_schema', out);
    }
    if (node.job_report_config !== undefined) {
      collectStrings(node.job_report_config, 'job_report_config', out);
    }
  }
  // `input` carries the mappings and, for if/elsif, the conditions.
  if (node.input !== undefined) collectStrings(node.input, 'input', out);
  if (scope === 'all') {
    if (node.extended_input_schema !== undefined) {
      collectStrings(node.extended_input_schema, 'extended_input_schema', out);
    }
    if (node.extended_output_schema !== undefined) {
      collectStrings(node.extended_output_schema, 'extended_output_schema', out);
    }
  }
  return out;
}

/**
 * Walk the raw tree and return the matches in the requested window. Matches
 * outside the window are counted but not built, so `total_matches` is honest
 * without the cost of every snippet.
 */
export function grepRecipeTree(
  code: RawNode,
  matcher: GrepMatcher,
  options: GrepOptions = {},
): GrepResult {
  const scope = options.scope ?? 'all';
  const maxMatches = Math.max(
    1,
    Math.min(options.maxMatches ?? DEFAULT_MAX_MATCHES, MAX_MAX_MATCHES),
  );
  const snippetChars = Math.max(
    MIN_SNIPPET_CHARS,
    Math.min(options.snippetChars ?? DEFAULT_SNIPPET_CHARS, MAX_SNIPPET_CHARS),
  );
  const offset = Math.max(0, options.offset ?? 0);

  const matches: GrepMatch[] = [];
  let total = 0;
  let steps = 0;
  let values = 0;

  const visit = (node: RawNode): void => {
    steps += 1;
    const step = identity(node);
    for (const candidate of searchableValues(node, scope)) {
      values += 1;
      const capped =
        matcher.capsInput && candidate.value.length > REGEX_INPUT_CAP_CHARS
          ? candidate.value.slice(0, REGEX_INPUT_CAP_CHARS)
          : candidate.value;
      const hit = matcher.find(capped);
      if (!hit) continue;
      if (total < MAX_COUNTED_MATCHES) total += 1;
      if (total > offset && matches.length < maxMatches) {
        const match: GrepMatch = {
          step,
          path: candidate.path,
          snippet: buildSnippet(capped, hit.index, hit.length, snippetChars),
          value_chars: candidate.value.length,
        };
        if (capped.length !== candidate.value.length) match.input_capped = true;
        matches.push(match);
      }
    }
    if (Array.isArray(node.block)) node.block.forEach(visit);
  };
  visit(code);

  const consumed = offset + matches.length;
  const truncated = consumed < total;
  const result: GrepResult = {
    matches,
    total_matches: total,
    truncated,
    steps_scanned: steps,
    values_scanned: values,
  };
  if (truncated) result.next_cursor = encodeCursor({ o: { matches: consumed } });
  return result;
}

interface RecipeGrepArgs {
  recipe_id: number;
  query: string;
  match?: GrepMatchMode;
  scope?: GrepScope;
  max_matches?: number;
  cursor?: string;
  snippet_chars?: number;
  timeout_ms?: number;
  tabId?: number;
  windowId?: number;
}

class WorkatoRecipeGrepTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.RECIPE_GREP;

  async execute(args: RecipeGrepArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }
      const query = typeof args.query === 'string' ? args.query : '';
      if (query.trim().length === 0) {
        return createErrorResponse('Param [query] must be a non-empty string');
      }
      const mode = args.match ?? 'substring';
      if (mode !== 'substring' && mode !== 'word' && mode !== 'regex') {
        return createErrorResponse("Param [match] must be 'substring', 'word', or 'regex'");
      }
      const scope = args.scope ?? 'all';
      if (scope !== 'input' && scope !== 'all') {
        return createErrorResponse("Param [scope] must be 'input' or 'all'");
      }

      const compiled = compileGrepMatcher(mode === 'substring' ? query : query.trim(), mode);
      if (!compiled.ok) return createErrorResponse(compiled.error);

      let offset = 0;
      if (args.cursor != null) {
        const state = decodeCursor(String(args.cursor));
        if (!state) {
          return createErrorResponse(
            'Param [cursor] is not a cursor this tool produced. Drop it to start over.',
          );
        }
        offset = state.o.matches ?? 0;
      }

      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 30_000, 10_000), 110_000);
      const tab = await findWorkatoTab(args.tabId);
      const snapshot = await loadRecipeSnapshot(tab, args.recipe_id, { timeoutMs });
      if (!snapshot.ok) return createErrorResponse(snapshot.error);

      const result = grepRecipeTree(snapshot.code, compiled.matcher, {
        scope,
        maxMatches: args.max_matches,
        snippetChars: args.snippet_chars,
        offset,
      });

      const payload = {
        recipe_id: args.recipe_id,
        version_no: snapshot.version.version_no,
        query,
        match: mode,
        scope,
        cache_hit: snapshot.cacheHit,
        ...result,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_recipe_grep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoRecipeGrepTool = new WorkatoRecipeGrepTool();
