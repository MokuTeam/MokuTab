import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import type { RecipeVersionEntry } from './recipe-versions';

/**
 * workato_recipe_version_diff — compare two saved versions of a recipe and
 * return ONLY the changed steps, in a compact shape.
 *
 * Endpoint (live-verified 2026-07-14): GET /recipes/<id>/code.json?mode=view&version_no=<N>
 * returns the code tree exactly as of that version (the param is honored;
 * requesting the current version returns bytes identical to no param).
 *
 * The two full trees never enter agent context — they are diffed here in the
 * background worker and only the changed-step summary is returned.
 */

interface VersionDiffArgs {
  recipe_id: number;
  from: number;
  to: number;
  /** Max characters for each old/new value excerpt. Default 200, clamped 40–2000. */
  value_excerpt_chars?: number;
  /** In-page script timeout. Default 40000, clamped 10000–110000. */
  timeout_ms?: number;
  tabId?: number;
}

interface DiffInPageResult {
  ok: boolean;
  from_code?: unknown;
  to_code?: unknown;
  versions?: RecipeVersionEntry[];
  failure?: {
    stage: 'from' | 'to' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based
 * (see pull-recipe.ts for why async/await is forbidden here).
 */
function fetchVersionCodesInPage(
  recipeId: number,
  fromV: number,
  toV: number,
): Promise<DiffInPageResult> {
  const fetchOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };

  function fetchCode(
    versionNo: number,
    stage: 'from' | 'to',
  ): Promise<{ ok: true; code: unknown } | { ok: false; failure: DiffInPageResult['failure'] }> {
    return fetch(
      `/recipes/${recipeId}/code.json?mode=view&version_no=${versionNo}`,
      fetchOpts,
    ).then((r) =>
      r.text().then((bodyText) => {
        if (r.status < 200 || r.status >= 300) {
          return {
            ok: false as const,
            failure: {
              stage,
              status: r.status,
              body_excerpt: bodyText.slice(0, 512),
              message: `GET code.json?version_no=${versionNo} returned HTTP ${r.status}`,
            },
          };
        }
        let json: unknown = null;
        try {
          json = JSON.parse(bodyText);
        } catch (e) {
          return {
            ok: false as const,
            failure: {
              stage: 'shape' as const,
              body_excerpt: bodyText.slice(0, 512),
              message: `JSON.parse failed for version ${versionNo}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            },
          };
        }
        const codeStr = (json as any)?.result;
        let code: unknown;
        if (typeof codeStr === 'string') {
          try {
            code = JSON.parse(codeStr);
          } catch (e) {
            return {
              ok: false as const,
              failure: {
                stage: 'shape' as const,
                message: `JSON.parse(result) failed for version ${versionNo}: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              },
            };
          }
        } else if (codeStr && typeof codeStr === 'object') {
          code = codeStr;
        } else {
          return {
            ok: false as const,
            failure: {
              stage: 'shape' as const,
              body_excerpt: JSON.stringify(json).slice(0, 512),
              message: `code.json?version_no=${versionNo} response missing result.`,
            },
          };
        }
        return { ok: true as const, code };
      }),
    );
  }

  return fetchCode(fromV, 'from').then((fromRes) => {
    if (!fromRes.ok) return { ok: false, failure: fromRes.failure };
    return fetchCode(toV, 'to').then((toRes) => {
      if (!toRes.ok) return { ok: false, failure: toRes.failure };
      // Best-effort version metadata (comments/authors) from page 1.
      return fetch(`/recipes/${recipeId}/versions.json?page=1`, fetchOpts)
        .then((r) => (r.ok ? r.json().catch(() => null) : null))
        .catch(() => null)
        .then((versionsJson: any) => ({
          ok: true,
          from_code: fromRes.code,
          to_code: toRes.code,
          versions: Array.isArray(versionsJson?.versions) ? versionsJson.versions : undefined,
        }));
    });
  });
}

// ---------------------------------------------------------------------------
// Diffing (background worker — full trees never reach the agent)
// ---------------------------------------------------------------------------

export interface StepEntry {
  /**
   * Identity used to match this node across the two versions. It is the node's
   * `as` when it has one, else `uuid:<uuid>`, else a walk-order counter.
   */
  key: string;
  /** The node's own `as`, when it has one. */
  as?: string;
  uuid?: string;
  number?: number;
  keyword?: string;
  provider?: string;
  name?: string;
  title?: string | null;
  description?: string | null;
  node: Record<string, unknown>;
}

/**
 * Index every node of a version's tree by a STABLE identity.
 *
 * Most nodes carry an `as` and that is the identity. Control nodes and older
 * steps often do not, and the previous fallback was a walk-order counter:
 * inserting one anonymous node near the top of the recipe shifted every later
 * anonymous node's counter by one, so a diff reported them all as removed and
 * re-added. Workato writes a `uuid` on those nodes, and unlike the counter it
 * survives an insertion above, so it is preferred. The counter remains for a
 * node that has neither, where nothing better exists.
 */
export function collectSteps(root: unknown): Map<string, StepEntry> {
  const steps = new Map<string, StepEntry>();
  let anonCounter = 0;

  function visit(node: unknown): void {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const n = node as Record<string, unknown>;
    const as = typeof n.as === 'string' && n.as.length > 0 ? n.as : undefined;
    const uuid = typeof n.uuid === 'string' && n.uuid.length > 0 ? n.uuid : undefined;
    const key = as ?? (uuid !== undefined ? `uuid:${uuid}` : `__anon_${anonCounter++}`);
    steps.set(key, {
      key,
      as,
      uuid,
      number: typeof n.number === 'number' ? n.number : undefined,
      keyword: typeof n.keyword === 'string' ? n.keyword : undefined,
      provider: typeof n.provider === 'string' ? n.provider : undefined,
      name: typeof n.name === 'string' ? n.name : undefined,
      title: typeof n.title === 'string' ? n.title : null,
      description: typeof n.description === 'string' ? n.description : null,
      node: n,
    });
    if (Array.isArray(n.block)) for (const child of n.block) visit(child);
  }

  visit(root);
  return steps;
}

/** Keys that are structural or churn on every save — excluded from field diffs. */
const DIFF_IGNORED_KEYS = new Set(['block', 'number', 'uuid']);

function excerpt(value: unknown, max: number): string {
  // JSON.stringify returns undefined at runtime for undefined/functions,
  // despite its string-typed signature.
  let s: string | undefined;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = 'undefined';
  return s.length <= max ? s : s.slice(0, max) + `…(+${s.length - max} chars)`;
}

interface FieldChange {
  path: string;
  from?: string;
  to?: string;
}

function diffValues(
  a: unknown,
  b: unknown,
  path: string,
  out: FieldChange[],
  max: number,
  depth: number,
): void {
  if (out.length >= 100) return; // safety cap per step
  if (a === b) return;
  const aObj = a !== null && typeof a === 'object' && !Array.isArray(a);
  const bObj = b !== null && typeof b === 'object' && !Array.isArray(b);
  if (aObj && bObj && depth < 12) {
    const keys = new Set([
      ...Object.keys(a as Record<string, unknown>),
      ...Object.keys(b as Record<string, unknown>),
    ]);
    for (const k of keys) {
      if (path === '' && DIFF_IGNORED_KEYS.has(k)) continue;
      diffValues(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        path === '' ? k : `${path}.${k}`,
        out,
        max,
        depth + 1,
      );
    }
    return;
  }
  // Arrays and mixed types: compare serialized; report as one change.
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr === bStr) return;
  const change: FieldChange = { path: path === '' ? '(root)' : path };
  if (a !== undefined) change.from = excerpt(a, max);
  if (b !== undefined) change.to = excerpt(b, max);
  out.push(change);
}

export function stepHeader(s: StepEntry): Record<string, unknown> {
  return {
    // A node with no `as` is still identified: `key` names what matched it.
    as: s.as ?? s.key,
    uuid: s.uuid,
    number: s.number,
    keyword: s.keyword,
    provider: s.provider,
    name: s.name,
    title: s.title ?? undefined,
    description: s.description ?? undefined,
  };
}

class WorkatoRecipeVersionDiffTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.VERSION_DIFF;

  async execute(args: VersionDiffArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }
      if (typeof args?.from !== 'number' || !Number.isFinite(args.from)) {
        return createErrorResponse('Param [from] must be a finite version number');
      }
      if (typeof args?.to !== 'number' || !Number.isFinite(args.to)) {
        return createErrorResponse('Param [to] must be a finite version number');
      }
      const maxChars = Math.min(Math.max(args.value_excerpt_chars ?? 200, 40), 2000);

      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 40_000, 10_000), 110_000);
      const tab = await findWorkatoTab(args.tabId);
      const result = await runInWorkatoTab(
        tab.tabId,
        fetchVersionCodesInPage,
        [args.recipe_id, args.from, args.to],
        { timeoutMs, retryOnTimeout: true },
      );

      if (!result.ok) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
            (result.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      const fromSteps = collectSteps(result.from_code);
      const toSteps = collectSteps(result.to_code);

      const added: Record<string, unknown>[] = [];
      const removed: Record<string, unknown>[] = [];
      const changed: Record<string, unknown>[] = [];
      let moved = 0;

      for (const [key, toStep] of toSteps) {
        const fromStep = fromSteps.get(key);
        if (!fromStep) {
          added.push(stepHeader(toStep));
          continue;
        }
        const changes: FieldChange[] = [];
        diffValues(fromStep.node, toStep.node, '', changes, maxChars, 0);
        const wasMoved =
          fromStep.number !== undefined &&
          toStep.number !== undefined &&
          fromStep.number !== toStep.number;
        if (wasMoved) moved++;
        // Pure renumbering (a step inserted/removed above) is counted in
        // `summary.moved` but NOT listed — otherwise one insertion floods the
        // diff with every downstream step.
        if (changes.length > 0) {
          const entry: Record<string, unknown> = { ...stepHeader(toStep) };
          if (wasMoved) {
            entry.moved_from = fromStep.number;
            entry.moved_to = toStep.number;
          }
          entry.changes = changes;
          changed.push(entry);
        }
      }
      for (const [key, fromStep] of fromSteps) {
        if (!toSteps.has(key)) removed.push(stepHeader(fromStep));
      }

      const versionMeta = (v: number): Record<string, unknown> | undefined => {
        const entry = result.versions?.find((x: RecipeVersionEntry) => x.version_no === v);
        if (!entry) return undefined;
        return {
          user_name: entry.user_name,
          created_at: entry.created_at,
          comment: entry.comment ?? undefined,
        };
      };

      const payload = {
        recipe_id: args.recipe_id,
        from: { version_no: args.from, ...versionMeta(args.from) },
        to: { version_no: args.to, ...versionMeta(args.to) },
        summary: {
          steps_in_from: fromSteps.size,
          steps_in_to: toSteps.size,
          added: added.length,
          removed: removed.length,
          changed: changed.length,
          moved,
        },
        added,
        removed,
        changed,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_recipe_version_diff failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoRecipeVersionDiffTool = new WorkatoRecipeVersionDiffTool();
