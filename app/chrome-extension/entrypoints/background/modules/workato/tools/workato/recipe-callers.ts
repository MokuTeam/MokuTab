import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { stripConnectionSecrets } from './strip-secrets';
import { loadRecipeSnapshot } from './pull-recipe';
import { cachedRecipeVersions } from './recipe-snapshot';

/**
 * workato_recipe_callers: who calls this recipe, and how sure are we.
 *
 * Three independent sources, each with a different guarantee:
 *
 *   graph  GET /dependency_graphs/<id>.json?asset_type=recipe is what the
 *          Operations hub dependency page loads. Its Flow -> Flow edges ARE
 *          Workato's own answer to "which recipes call this one", plus the
 *          connections, lookup tables and workflow-app pages it touches. Cheap
 *          (one request) and workspace-wide, so it is on by default.
 *   code   Reads the candidate recipes' code and matches
 *          call_recipe / call_recipe_async input.flow_id against this recipe.
 *          This is the only source that can name the calling STEP, and the only
 *          one that can see a caller the graph has not caught up with. It is
 *          also the only one that can report a call whose flow_id is a datapill
 *          or a formula, which no static scan can resolve.
 *   jobs   Recent jobs of the callee carry calling_recipe_id. That is observed
 *          EXECUTION HISTORY, not a static dependency: it proves a caller ran,
 *          it never proves a caller does not exist.
 *
 * The code scan's folder scope is NOT server-side. /web_api/mixed_assets.json
 * accepts folder_id and ignores it (verified 2026-09-07: a single folder id
 * answered with recipes from four folders), so a folder, project or own-folder
 * scope resolves exact membership from GET
 * /dependency_graphs.json?asset_type=recipe&folder_id=<id> and intersects the
 * candidate listing with it. The listing itself stays workspace-wide with
 * adapters=workato_recipe_function, which is a real server-side filter and
 * keeps the candidate set to recipes that can call a recipe at all.
 *
 * Honesty rules baked into the response: the scan reports the folders it
 * listed, the pages it walked and whether it reached the end of each of them;
 * recipes it could not read are listed by id and reason; dynamic call targets
 * are listed separately; and `completeness` is 'partial' whenever any of those
 * apply, so a list of N callers is never presented as "there are only N".
 *
 * A version-aware index (recipe id -> call targets, keyed on the list's
 * updated_at) means the second call in a session re-reads only the recipes that
 * actually changed.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type CallerSource = 'graph' | 'code' | 'jobs';
export type ScopeMode = 'own' | 'folders' | 'project' | 'workspace';

/** One node of the dependency graph's `objects` array. */
export interface GraphObject {
  type?: string;
  id?: number | string;
  name?: string;
  active?: number | null;
  folder_id?: number | null;
  parent_id?: number | null;
  handle?: string | null;
  provider?: string | null;
  provider_id?: unknown;
  provider_type?: unknown;
  root?: boolean;
  [k: string]: unknown;
}

/** One edge of the dependency graph's `paths` array. */
export interface GraphPath {
  from_type?: string;
  from_id?: number | string;
  to_type?: string;
  to_id?: number | string;
  [k: string]: unknown;
}

export interface GraphResult {
  paths?: GraphPath[];
  objects?: GraphObject[];
}

/** A recipe the folder/project/workspace listing offered as a caller candidate. */
export interface CandidateRow {
  id: number;
  name?: string;
  folder_id?: number;
  project_id?: number;
  running?: boolean;
  state?: string;
  updated_at?: string;
}

/** The minimal call-step projection the page returns for one recipe. */
export interface SlimCallStep {
  as?: string;
  number?: number;
  name?: string;
  provider?: string;
  input?: { flow_id?: unknown };
}

export interface CodeReadResult {
  recipe_id: number;
  ok: boolean;
  steps?: SlimCallStep[];
  status?: number;
  message?: string;
}

export interface JobCallerRow {
  calling_recipe_id: number;
  started_at?: string;
}

// ---------------------------------------------------------------------------
// In-page functions
//
// MUST be plain function declarations built from promise chains, with every
// helper declared inside. WXT/Vite rewrites async/await into hoisted helpers
// that do not survive Function.prototype.toString (see pull-recipe.ts).
// ---------------------------------------------------------------------------

export interface ScanOptions {
  recipeId: number;
  wantGraph: boolean;
  wantCode: boolean;
  scopeMode: string;
  folderIds: number[];
  projectId: string;
  maxPages: number;
  maxRecipes: number;
}

export interface ScanInPageResult {
  ok: boolean;
  graph?: GraphResult;
  graph_error?: string;
  candidates?: CandidateRow[];
  folder_ids?: number[];
  pages?: number;
  recipes_listed?: number;
  listing_errors?: string[];
  listing_complete?: boolean;
  /** How folder membership was decided for the code scan. */
  membership_source?: 'dependency_graph' | 'workspace_list';
  /** Recipes the dependency-graph listing reported for the scoped folders. */
  folder_members?: number;
  failure?: { stage: string; status?: number; message: string };
}

/**
 * Fetch the dependency graph and list the caller candidates for the requested
 * scope. Everything here is I/O plus the pagination arithmetic; the matching
 * and shaping happen in the service worker, where they are unit-tested.
 */
export function fetchCallerScanInPage(opts: ScanOptions): Promise<ScanInPageResult> {
  const fetchOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };

  function getJson(url: string): Promise<{ status: number; body: string; json: unknown }> {
    return fetch(url, fetchOpts).then(
      (r) =>
        r
          .text()
          .then((body) => ({ status: r.status, body: body, json: safeParse(body) as unknown })),
      (e) => ({
        status: 0,
        body: e instanceof Error ? e.message : String(e),
        json: null as unknown,
      }),
    );
  }

  function safeParse(body: string): unknown {
    try {
      return JSON.parse(body);
    } catch (e) {
      return null;
    }
  }

  function loadGraph(): Promise<{ graph?: GraphResult; error?: string }> {
    if (!opts.wantGraph) return Promise.resolve({});
    const url = `/dependency_graphs/${opts.recipeId}.json?asset_type=recipe`;
    return getJson(url).then((res) => {
      if (res.status < 200 || res.status >= 300) {
        return { error: `GET ${url} returned HTTP ${res.status}` };
      }
      const result = res.json && (res.json as any).result;
      if (!result || typeof result !== 'object') {
        return { error: `GET ${url}: unexpected shape, missing result` };
      }
      return { graph: result as GraphResult };
    });
  }

  /** The recipe's own folder, used when no scope was given. */
  function ownFolder(graph?: GraphResult): Promise<{ folderIds: number[]; error?: string }> {
    const objects = graph && Array.isArray(graph.objects) ? graph.objects : [];
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i] as GraphObject;
      if (Number(obj.id) === opts.recipeId && obj.folder_id != null) {
        return Promise.resolve({ folderIds: [Number(obj.folder_id)] });
      }
    }
    const url = `/recipes/${opts.recipeId}.json?error_format=json`;
    return getJson(url).then((res) => {
      const flow = res.json && (res.json as any).result && (res.json as any).result.recipe_data;
      const folderId = flow && flow.flow ? flow.flow.folder_id : null;
      if (folderId == null || !Number.isFinite(Number(folderId))) {
        return {
          folderIds: [],
          error: `could not resolve the folder of recipe ${opts.recipeId} (GET ${url} -> HTTP ${res.status})`,
        };
      }
      return { folderIds: [Number(folderId)] };
    });
  }

  /** Every folder id under a project root, found in the projects folder tree. */
  function projectFolders(): Promise<{ folderIds: number[]; error?: string }> {
    const url = '/folders?projects_mode=true';
    return getJson(url).then((res) => {
      const result = res.json && (res.json as any).result;
      const roots = result && Array.isArray(result.folders) ? result.folders : null;
      if (!roots) {
        return {
          folderIds: [],
          error: `GET ${url} returned HTTP ${res.status} or an unknown shape`,
        };
      }
      const wanted = String(opts.projectId).toLowerCase();
      let root: any = null;
      for (let i = 0; i < roots.length; i++) {
        const node = roots[i];
        if (
          String(node.project_id == null ? '' : node.project_id).toLowerCase() === wanted ||
          String(node.id) === wanted ||
          String(node.name == null ? '' : node.name).toLowerCase() === wanted
        ) {
          root = node;
          break;
        }
      }
      if (!root) {
        const names: string[] = [];
        for (let i = 0; i < roots.length; i++) {
          names.push(`${roots[i].name} (project_id ${roots[i].project_id}, folder ${roots[i].id})`);
        }
        return {
          folderIds: [],
          error: `no project matched "${opts.projectId}". Available: ${names.join(', ')}`,
        };
      }
      const out: number[] = [];
      function collect(node: any): void {
        if (!node || typeof node !== 'object') return;
        if (Number.isFinite(Number(node.id))) out.push(Number(node.id));
        const children = Array.isArray(node.children) ? node.children : [];
        for (let i = 0; i < children.length; i++) collect(children[i]);
      }
      collect(root);
      return { folderIds: out };
    });
  }

  function resolveFolders(graph?: GraphResult): Promise<{ folderIds: number[]; error?: string }> {
    if (!opts.wantCode) return Promise.resolve({ folderIds: [] });
    if (opts.scopeMode === 'workspace') return Promise.resolve({ folderIds: [] });
    if (opts.scopeMode === 'folders') return Promise.resolve({ folderIds: opts.folderIds });
    if (opts.scopeMode === 'project') return projectFolders();
    return ownFolder(graph);
  }

  /**
   * Exact membership of one folder. The recipe list endpoint ignores
   * folder_id, so this top-level dependency graph listing is the only answer
   * to "which recipes live in this folder". It returns
   * {"result":[[recipe_id,"name"], ...]}.
   */
  function folderMembers(folderId: number): Promise<{ ids: number[]; error?: string }> {
    const url = `/dependency_graphs.json?asset_type=recipe&folder_id=${folderId}`;
    return getJson(url).then((res) => {
      if (res.status < 200 || res.status >= 300) {
        return { ids: [], error: `GET ${url} returned HTTP ${res.status}` };
      }
      const result = res.json && (res.json as any).result;
      if (!Array.isArray(result)) {
        return { ids: [], error: `GET ${url}: unexpected shape, expected result to be an array` };
      }
      const ids: number[] = [];
      for (let i = 0; i < result.length; i++) {
        const row = result[i];
        const id = Array.isArray(row) ? Number(row[0]) : Number(row);
        if (!Number.isFinite(id)) continue;
        if (ids.indexOf(id) < 0) ids.push(id);
      }
      return { ids: ids };
    });
  }

  /** Union of the membership of every scoped folder. */
  function collectMembers(folderIds: number[]): Promise<{ ids: number[]; errors: string[] }> {
    const ids: number[] = [];
    const errors: string[] = [];
    function next(index: number): Promise<{ ids: number[]; errors: string[] }> {
      if (index >= folderIds.length) return Promise.resolve({ ids: ids, errors: errors });
      return folderMembers(folderIds[index]).then((res) => {
        if (res.error) errors.push(res.error);
        for (let i = 0; i < res.ids.length; i++) {
          if (ids.indexOf(res.ids[i]) < 0) ids.push(res.ids[i]);
        }
        return next(index + 1);
      });
    }
    return next(0);
  }

  /**
   * Walk every page of the candidate listing. `count` from the response decides
   * when the end is reached, so a short page caused by server-side filtering
   * does not look like the end of the list.
   *
   * `memberIds` is the folder scope, applied here because Workato ignores
   * folder_id on this endpoint. null means workspace-wide.
   */
  function walkListing(
    memberIds: number[] | null,
    acc: CandidateRow[],
    errors: string[],
    pagesSoFar: number,
  ): Promise<{ pages: number; complete: boolean }> {
    function page(
      n: number,
      seen: number,
      pages: number,
    ): Promise<{ pages: number; complete: boolean }> {
      const url =
        '/web_api/mixed_assets.json?asset_type=recipe&adapters=workato_recipe_function' +
        `&sort_term=name&per_page=20&page=${n}`;
      return getJson(url).then((res) => {
        if (res.status < 200 || res.status >= 300) {
          errors.push(`GET ${url} returned HTTP ${res.status}`);
          return { pages: pages, complete: false };
        }
        const result = res.json && (res.json as any).result;
        const items = result && Array.isArray(result.items) ? result.items : null;
        if (!items) {
          errors.push(`GET ${url}: unexpected shape, missing result.items`);
          return { pages: pages, complete: false };
        }
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const id = Number(item.id);
          if (!Number.isFinite(id)) continue;
          if (memberIds !== null && memberIds.indexOf(id) < 0) continue;
          acc.push({
            id: id,
            name: item.name == null ? undefined : String(item.name),
            folder_id: item.folder_id == null ? undefined : Number(item.folder_id),
            project_id: item.project_id == null ? undefined : Number(item.project_id),
            running: typeof item.running === 'boolean' ? item.running : undefined,
            state: item.state == null ? undefined : String(item.state),
            updated_at: item.updated_at == null ? undefined : String(item.updated_at),
          });
        }
        const total = Number(result.count);
        const perPage = Number(result.per_page) > 0 ? Number(result.per_page) : items.length;
        const seenNow = seen + items.length;
        if (acc.length >= opts.maxRecipes) return { pages: pages, complete: false };
        // Every member of the scope has been located: nothing further in the
        // list can belong to it, so the walk is done and complete.
        if (memberIds !== null && acc.length >= memberIds.length) {
          return { pages: pages, complete: true };
        }
        if (items.length === 0) return { pages: pages, complete: true };
        if (Number.isFinite(total) && seenNow >= total) return { pages: pages, complete: true };
        if (!Number.isFinite(total) && items.length < perPage) {
          return { pages: pages, complete: true };
        }
        if (pages >= opts.maxPages) return { pages: pages, complete: false };
        return page(n + 1, seenNow, pages + 1);
      });
    }
    return page(1, 0, pagesSoFar + 1);
  }

  function walkAll(folderIds: number[]): Promise<{
    candidates: CandidateRow[];
    pages: number;
    errors: string[];
    complete: boolean;
    members?: number;
    membershipSource: 'dependency_graph' | 'workspace_list';
  }> {
    const acc: CandidateRow[] = [];
    const errors: string[] = [];
    if (!opts.wantCode) {
      return Promise.resolve({
        candidates: acc,
        pages: 0,
        errors: errors,
        complete: true,
        membershipSource: 'workspace_list' as const,
      });
    }
    if (opts.scopeMode === 'workspace') {
      return walkListing(null, acc, errors, 0).then((res) => ({
        candidates: acc,
        pages: res.pages,
        errors: errors,
        complete: res.complete,
        membershipSource: 'workspace_list' as const,
      }));
    }
    return collectMembers(folderIds).then((membership) => {
      for (let i = 0; i < membership.errors.length; i++) errors.push(membership.errors[i]);
      if (membership.ids.length === 0) {
        // An empty (or unreadable) folder needs no listing walk at all.
        return {
          candidates: acc,
          pages: 0,
          errors: errors,
          complete: membership.errors.length === 0,
          members: 0,
          membershipSource: 'dependency_graph' as const,
        };
      }
      return walkListing(membership.ids, acc, errors, 0).then((res) => ({
        candidates: acc,
        pages: res.pages,
        errors: errors,
        complete: res.complete && membership.errors.length === 0,
        members: membership.ids.length,
        membershipSource: 'dependency_graph' as const,
      }));
    });
  }

  return loadGraph().then((graphOut) =>
    resolveFolders(graphOut.graph).then((folderOut) => {
      if (folderOut.error && opts.wantCode) {
        // Scope resolution failed: the graph may still be usable, so this is
        // reported as an incomplete listing rather than a hard failure.
        const result: ScanInPageResult = {
          ok: true,
          candidates: [],
          folder_ids: [],
          pages: 0,
          recipes_listed: 0,
          listing_errors: [folderOut.error],
          listing_complete: false,
        };
        if (graphOut.graph) result.graph = graphOut.graph;
        if (graphOut.error) result.graph_error = graphOut.error;
        return result;
      }
      return walkAll(folderOut.folderIds).then((listed) => {
        const result: ScanInPageResult = {
          ok: true,
          candidates: listed.candidates,
          folder_ids: folderOut.folderIds,
          pages: listed.pages,
          recipes_listed: listed.candidates.length,
          listing_errors: listed.errors,
          listing_complete: listed.complete,
          membership_source: listed.membershipSource,
        };
        if (listed.members !== undefined) result.folder_members = listed.members;
        if (graphOut.graph) result.graph = graphOut.graph;
        if (graphOut.error) result.graph_error = graphOut.error;
        return result;
      });
    }),
  );
}

export interface CodeReadInPageResult {
  ok: boolean;
  reads: CodeReadResult[];
  unread: number[];
  stopped_early: boolean;
}

/**
 * Read the call steps of each recipe id, sequentially, until the budget runs
 * out. Only the call_recipe / call_recipe_async nodes come back: a recipe's
 * code can be hundreds of kilobytes and none of the rest is wanted here.
 */
export function fetchRecipeCallStepsInPage(
  recipeIds: number[],
  budgetMs: number,
): Promise<CodeReadInPageResult> {
  const fetchOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };
  const deadline = Date.now() + (budgetMs > 0 ? budgetMs : 20000);
  const reads: CodeReadResult[] = [];

  function collectCallSteps(node: unknown, out: SlimCallStep[]): void {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) collectCallSteps(node[i], out);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (
      rec.provider === 'workato_recipe_function' &&
      (rec.name === 'call_recipe' || rec.name === 'call_recipe_async')
    ) {
      const input = rec.input && typeof rec.input === 'object' ? (rec.input as any) : null;
      const step: SlimCallStep = { name: String(rec.name), provider: 'workato_recipe_function' };
      if (typeof rec.as === 'string') step.as = rec.as;
      if (typeof rec.number === 'number') step.number = rec.number;
      step.input = { flow_id: input ? input.flow_id : undefined };
      out.push(step);
    }
    const keys = Object.keys(rec);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (key === 'input' || key === 'extended_input_schema') continue;
      if (key === 'extended_output_schema') continue;
      const child = rec[key];
      if (child && typeof child === 'object') collectCallSteps(child, out);
    }
  }

  function readOne(recipeId: number): Promise<void> {
    const url = `/recipes/${recipeId}/code.json?mode=view`;
    return fetch(url, fetchOpts).then(
      (r) =>
        r.text().then((body) => {
          if (r.status < 200 || r.status >= 300) {
            reads.push({
              recipe_id: recipeId,
              ok: false,
              status: r.status,
              message: `GET ${url} returned HTTP ${r.status}`,
            });
            return;
          }
          let parsed: unknown = null;
          try {
            const json = JSON.parse(body) as { result?: unknown };
            parsed = typeof json.result === 'string' ? JSON.parse(json.result) : json.result;
          } catch (e) {
            reads.push({
              recipe_id: recipeId,
              ok: false,
              status: r.status,
              message: `GET ${url}: JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
            });
            return;
          }
          const steps: SlimCallStep[] = [];
          collectCallSteps(parsed, steps);
          reads.push({ recipe_id: recipeId, ok: true, steps: steps });
        }),
      (e) => {
        reads.push({
          recipe_id: recipeId,
          ok: false,
          message: `GET ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      },
    );
  }

  function walk(index: number): Promise<CodeReadInPageResult> {
    if (index >= recipeIds.length) {
      return Promise.resolve({ ok: true, reads: reads, unread: [], stopped_early: false });
    }
    if (Date.now() >= deadline) {
      return Promise.resolve({
        ok: true,
        reads: reads,
        unread: recipeIds.slice(index),
        stopped_early: true,
      });
    }
    return readOne(recipeIds[index]).then(() => walk(index + 1));
  }

  return walk(0);
}

export interface JobsInPageResult {
  ok: boolean;
  jobs?: JobCallerRow[];
  scanned?: number;
  failure?: { status?: number; message: string };
}

/** Recent jobs of the callee, reduced to the caller ids they record. */
export function fetchCalleeJobCallersInPage(
  recipeId: number,
  perPage: number,
): Promise<JobsInPageResult> {
  const url = `/web_api/recipes/${recipeId}/jobs.json?per_page=${perPage}`;
  return fetch(url, {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  }).then(
    (r): Promise<JobsInPageResult> =>
      r.text().then((body): JobsInPageResult => {
        if (r.status < 200 || r.status >= 300) {
          return {
            ok: false,
            failure: { status: r.status, message: `GET ${url} returned HTTP ${r.status}` },
          };
        }
        let json: any = null;
        try {
          json = JSON.parse(body);
        } catch (e) {
          return {
            ok: false,
            failure: {
              status: r.status,
              message: `GET ${url}: JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
            },
          };
        }
        const raw = json && Array.isArray(json.jobs) ? json.jobs : [];
        const out: JobCallerRow[] = [];
        for (let i = 0; i < raw.length; i++) {
          const job = raw[i];
          const callerId = Number(job.calling_recipe_id);
          if (!Number.isFinite(callerId) || callerId === 0) continue;
          out.push({
            calling_recipe_id: callerId,
            started_at: job.started_at == null ? undefined : String(job.started_at),
          });
        }
        return { ok: true, jobs: out, scanned: raw.length };
      }),
    (e): JobsInPageResult => ({
      ok: false,
      failure: { message: `GET ${url} failed: ${e instanceof Error ? e.message : String(e)}` },
    }),
  );
}

// ---------------------------------------------------------------------------
// Pure helpers. Exported for unit tests: no browser needed.
// ---------------------------------------------------------------------------

/** A resolved, literal call target found in a recipe's code. */
export interface CallTarget {
  flow_id: string;
  step_as?: string;
  step_number?: number;
  async: boolean;
}

/** A call step whose target cannot be decided statically. */
export interface DynamicTarget {
  expression: string;
  step_as?: string;
  step_number?: number;
  async: boolean;
}

export interface CallerIndexEntry {
  recipe_id: number;
  name?: string;
  folder_id?: number;
  updated_at?: string;
  targets: CallTarget[];
  dynamic_targets: DynamicTarget[];
  scanned_at: string;
}

export type CallerIndex = Record<string, CallerIndexEntry>;

/**
 * A flow_id is usable only when it is a plain recipe id. Anything holding a
 * datapill (`#{_dp(...)}`), a formula (leading `=`) or a non-numeric string is
 * a target this scan cannot resolve, and saying so is the point.
 */
export function classifyFlowId(value: unknown): { literal?: string; dynamic?: string } {
  if (typeof value === 'number' && Number.isFinite(value)) return { literal: String(value) };
  if (typeof value !== 'string') {
    return { dynamic: value === undefined ? '<missing flow_id>' : JSON.stringify(value) };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return { dynamic: '<empty flow_id>' };
  if (/^\d+$/.test(trimmed)) return { literal: trimmed };
  return { dynamic: trimmed };
}

/**
 * Collect call_recipe / call_recipe_async targets from a recipe code tree, or
 * from the slim step projection the page returns. Recurses through any nested
 * structure, so a call inside if / repeat_each / try is found at any depth.
 */
export function extractCallTargets(node: unknown): {
  targets: CallTarget[];
  dynamic_targets: DynamicTarget[];
} {
  const targets: CallTarget[] = [];
  const dynamicTargets: DynamicTarget[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    const rec = value as Record<string, unknown>;
    const isCall =
      rec.provider === 'workato_recipe_function' &&
      (rec.name === 'call_recipe' || rec.name === 'call_recipe_async');
    if (isCall) {
      const input = rec.input && typeof rec.input === 'object' ? (rec.input as any) : null;
      const verdict = classifyFlowId(input ? input.flow_id : undefined);
      const stepAs = typeof rec.as === 'string' ? rec.as : undefined;
      const stepNumber = typeof rec.number === 'number' ? rec.number : undefined;
      const isAsync = rec.name === 'call_recipe_async';
      if (verdict.literal !== undefined) {
        const target: CallTarget = { flow_id: verdict.literal, async: isAsync };
        if (stepAs !== undefined) target.step_as = stepAs;
        if (stepNumber !== undefined) target.step_number = stepNumber;
        targets.push(target);
      } else {
        const target: DynamicTarget = { expression: verdict.dynamic ?? '', async: isAsync };
        if (stepAs !== undefined) target.step_as = stepAs;
        if (stepNumber !== undefined) target.step_number = stepNumber;
        dynamicTargets.push(target);
      }
    }
    for (const [key, child] of Object.entries(rec)) {
      if (key === 'extended_input_schema' || key === 'extended_output_schema') continue;
      if (isCall && key === 'input') continue;
      if (child && typeof child === 'object') visit(child);
    }
  };

  visit(node);
  return { targets, dynamic_targets: dynamicTargets };
}

export interface IndexPlan {
  to_read: number[];
  hits: number[];
  misses: number[];
}

/**
 * Decide which candidates still need their code read. A candidate is a hit
 * only when the index holds the same `updated_at` the listing just reported:
 * a recipe with no updated_at cannot be verified and is always re-read.
 */
export function planIndexReads(
  candidates: CandidateRow[],
  index: CallerIndex,
  refresh: boolean,
): IndexPlan {
  const hits: number[] = [];
  const misses: number[] = [];
  for (const candidate of candidates) {
    const entry = index[String(candidate.id)];
    const fresh =
      !refresh &&
      entry !== undefined &&
      typeof candidate.updated_at === 'string' &&
      candidate.updated_at.length > 0 &&
      entry.updated_at === candidate.updated_at;
    if (fresh) hits.push(candidate.id);
    else misses.push(candidate.id);
  }
  return { to_read: misses.slice(), hits, misses };
}

export interface TransitiveResult {
  edges: Array<[number, number]>;
  cycles: number[][];
  indirect_callers: Array<{ recipe_id: number; depth: number }>;
}

/**
 * Transitive closure over the caller edges this scan actually saw. `edges` are
 * caller -> callee pairs; the result names every recipe that reaches
 * `calleeId` through one or more hops, with the shortest hop count, plus any
 * cycle in the edge set (a callable that ends up calling itself would otherwise
 * make the walk loop forever).
 */
export function computeTransitive(
  edges: Array<[number, number]>,
  calleeId: number,
  limits?: { edges?: number; cycles?: number },
): TransitiveResult {
  const edgeCap = limits?.edges ?? 500;
  const cycleCap = limits?.cycles ?? 25;

  const callersOf = new Map<number, number[]>();
  const calleesOf = new Map<number, number[]>();
  const uniqueEdges: Array<[number, number]> = [];
  const edgeSeen = new Set<string>();
  for (const [from, to] of edges) {
    const key = `${from}->${to}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    uniqueEdges.push([from, to]);
    const cs = callersOf.get(to);
    if (cs) cs.push(from);
    else callersOf.set(to, [from]);
    const es = calleesOf.get(from);
    if (es) es.push(to);
    else calleesOf.set(from, [to]);
  }

  // Breadth-first over the reversed edges: depth 1 is a direct caller.
  const depth = new Map<number, number>();
  let frontier = [calleeId];
  let level = 0;
  const visited = new Set<number>([calleeId]);
  while (frontier.length > 0) {
    level += 1;
    const next: number[] = [];
    for (const node of frontier) {
      for (const caller of callersOf.get(node) ?? []) {
        if (visited.has(caller)) continue;
        visited.add(caller);
        depth.set(caller, level);
        next.push(caller);
      }
    }
    frontier = next;
  }

  // Cycle detection over the forward edges, iterative so a deep chain cannot
  // blow the stack in a service worker.
  const cycles: number[][] = [];
  const state = new Map<number, number>(); // 0 unvisited, 1 on stack, 2 done
  const nodes = new Set<number>();
  for (const [from, to] of uniqueEdges) {
    nodes.add(from);
    nodes.add(to);
  }
  for (const start of nodes) {
    if (state.get(start) === 2) continue;
    const stack: Array<{ node: number; index: number }> = [{ node: start, index: 0 }];
    const path: number[] = [];
    state.set(start, 1);
    path.push(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const children = calleesOf.get(frame.node) ?? [];
      if (frame.index >= children.length) {
        state.set(frame.node, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const child = children[frame.index];
      frame.index += 1;
      const childState = state.get(child) ?? 0;
      if (childState === 1) {
        const at = path.indexOf(child);
        if (at >= 0 && cycles.length < cycleCap) cycles.push(path.slice(at).concat([child]));
        continue;
      }
      if (childState === 2) continue;
      state.set(child, 1);
      path.push(child);
      stack.push({ node: child, index: 0 });
    }
  }

  const indirect: Array<{ recipe_id: number; depth: number }> = [];
  for (const [recipeId, d] of depth) {
    if (d > 1) indirect.push({ recipe_id: recipeId, depth: d });
  }
  indirect.sort((a, b) => a.depth - b.depth || a.recipe_id - b.recipe_id);

  return { edges: uniqueEdges.slice(0, edgeCap), cycles, indirect_callers: indirect };
}

export interface CallerEntry {
  recipe_id: number;
  name?: string;
  running?: boolean | null;
  folder_id?: number;
  step?: { as?: string; number?: number; async?: boolean };
  sources: CallerSource[];
  observed_at?: string;
}

export interface FailedRead {
  recipe_id: number;
  name?: string;
  reason: string;
  status?: number;
}

export interface ScopeInfo {
  mode: ScopeMode;
  folder_ids: number[];
  /** Candidates in scope: for a folder scope this IS the folder membership. */
  recipes_listed: number;
  recipes_read: number;
  pages: number;
  complete: boolean;
  /**
   * 'dependency_graph' when folder membership came from
   * /dependency_graphs.json (the recipe list endpoint ignores folder_id).
   */
  membership?: 'dependency_graph' | 'workspace_list';
  /** Recipes the dependency-graph listing reported for the scoped folders. */
  folder_members?: number;
}

export interface BuildInput {
  recipe_id: number;
  sources: CallerSource[];
  graph?: GraphResult;
  graph_error?: string;
  graph_fetched_at?: string;
  candidates: CandidateRow[];
  index: CallerIndex;
  hits: number[];
  failed_reads: FailedRead[];
  jobs?: JobCallerRow[];
  jobs_error?: string;
  scope: ScopeInfo;
  include_callees: boolean;
  include_transitive: boolean;
  extra_reasons?: string[];
  /** Candidates whose code came from the version-pinned snapshot cache. */
  snapshot_reads?: number;
}

/** Per-collection caps. A response never returns an unbounded list. */
export const CALLER_LIMITS = {
  callers: 200,
  callees: 100,
  connections: 50,
  lookup_tables: 100,
  lcap_pages: 50,
  unresolved_dynamic_targets: 100,
  failed_reads: 100,
  edges: 500,
  cycles: 25,
} as const;

function cap<T>(
  items: T[],
  limit: number,
): { list: T[]; truncated?: { returned: number; total: number; limit: number } } {
  if (items.length <= limit) return { list: items };
  return {
    list: items.slice(0, limit),
    truncated: { returned: limit, total: items.length, limit },
  };
}

function graphActiveToRunning(active: unknown): boolean | null {
  if (active === 1 || active === true) return true;
  if (active === 0 || active === false) return false;
  return null;
}

/**
 * Merge the three evidence sources into one answer and say plainly how far the
 * scan actually reached.
 */
export function buildCallersPayload(input: BuildInput): Record<string, unknown> {
  const objects = new Map<number, GraphObject>();
  const graphPaths: GraphPath[] =
    input.graph && Array.isArray(input.graph.paths) ? input.graph.paths : [];
  const graphObjects: GraphObject[] =
    input.graph && Array.isArray(input.graph.objects) ? input.graph.objects : [];
  for (const obj of graphObjects) {
    const id = Number(obj.id);
    if (Number.isFinite(id)) objects.set(id, obj);
  }
  const candidateById = new Map<number, CandidateRow>();
  for (const candidate of input.candidates) candidateById.set(candidate.id, candidate);

  const callers = new Map<number, CallerEntry>();
  const addSource = (recipeId: number, source: CallerSource): CallerEntry => {
    let entry = callers.get(recipeId);
    if (!entry) {
      entry = { recipe_id: recipeId, sources: [] };
      callers.set(recipeId, entry);
    }
    if (entry.sources.indexOf(source) < 0) entry.sources.push(source);
    return entry;
  };

  // --- graph evidence ------------------------------------------------------
  for (const path of graphPaths) {
    if (path.from_type !== 'Flow' || path.to_type !== 'Flow') continue;
    if (Number(path.to_id) !== input.recipe_id) continue;
    const callerId = Number(path.from_id);
    if (!Number.isFinite(callerId) || callerId === input.recipe_id) continue;
    addSource(callerId, 'graph');
  }

  // --- code evidence -------------------------------------------------------
  const wanted = String(input.recipe_id);
  const edges: Array<[number, number]> = [];
  const dynamicRows: Array<Record<string, unknown>> = [];
  for (const candidate of input.candidates) {
    const entry = input.index[String(candidate.id)];
    if (!entry) continue;
    for (const target of entry.targets) {
      const targetId = Number(target.flow_id);
      if (Number.isFinite(targetId) && targetId !== candidate.id) {
        edges.push([candidate.id, targetId]);
      }
      if (target.flow_id !== wanted || candidate.id === input.recipe_id) continue;
      const caller = addSource(candidate.id, 'code');
      if (!caller.step) {
        caller.step = {};
        if (target.step_as !== undefined) caller.step.as = target.step_as;
        if (target.step_number !== undefined) caller.step.number = target.step_number;
        caller.step.async = target.async;
      }
    }
    for (const dynamic of entry.dynamic_targets) {
      const row: Record<string, unknown> = {
        recipe_id: candidate.id,
        expression: dynamic.expression,
        async: dynamic.async,
      };
      if (entry.name !== undefined || candidate.name !== undefined) {
        row.name = candidate.name ?? entry.name;
      }
      if (dynamic.step_as !== undefined) row.step_as = dynamic.step_as;
      if (dynamic.step_number !== undefined) row.step_number = dynamic.step_number;
      dynamicRows.push(row);
    }
  }
  for (const path of graphPaths) {
    if (path.from_type !== 'Flow' || path.to_type !== 'Flow') continue;
    const from = Number(path.from_id);
    const to = Number(path.to_id);
    if (Number.isFinite(from) && Number.isFinite(to)) edges.push([from, to]);
  }

  // --- jobs evidence -------------------------------------------------------
  for (const job of input.jobs ?? []) {
    if (job.calling_recipe_id === input.recipe_id) continue;
    const caller = addSource(job.calling_recipe_id, 'jobs');
    // Keep the most recent run: `observed_at` answers "when did this caller
    // last actually call it", which is the only thing job history proves.
    if (
      job.started_at &&
      (caller.observed_at === undefined || job.started_at > caller.observed_at)
    ) {
      caller.observed_at = job.started_at;
    }
  }

  // --- identity for every caller ------------------------------------------
  for (const entry of callers.values()) {
    const candidate = candidateById.get(entry.recipe_id);
    const obj = objects.get(entry.recipe_id);
    const indexed = input.index[String(entry.recipe_id)];
    const name =
      candidate?.name ?? (obj?.name == null ? undefined : String(obj.name)) ?? indexed?.name;
    if (name !== undefined) entry.name = name;
    const folderId =
      candidate?.folder_id ??
      (obj?.folder_id == null ? undefined : Number(obj.folder_id)) ??
      indexed?.folder_id;
    if (folderId !== undefined && Number.isFinite(folderId)) entry.folder_id = folderId;
    const running =
      typeof candidate?.running === 'boolean'
        ? candidate.running
        : graphActiveToRunning(obj?.active);
    entry.running = running;
  }

  const callerList = Array.from(callers.values()).sort((a, b) => a.recipe_id - b.recipe_id);

  // --- what this recipe itself depends on ----------------------------------
  const callees: Array<Record<string, unknown>> = [];
  if (input.include_callees) {
    const seenCallee = new Set<number>();
    const selfEntry = input.index[String(input.recipe_id)];
    const stepFor = new Map<string, CallTarget>();
    for (const target of selfEntry?.targets ?? []) {
      if (!stepFor.has(target.flow_id)) stepFor.set(target.flow_id, target);
    }
    const pushCallee = (calleeId: number): void => {
      if (!Number.isFinite(calleeId) || calleeId === input.recipe_id) return;
      if (seenCallee.has(calleeId)) return;
      seenCallee.add(calleeId);
      const obj = objects.get(calleeId);
      const candidate = candidateById.get(calleeId);
      const row: Record<string, unknown> = { recipe_id: calleeId };
      const name = candidate?.name ?? (obj?.name == null ? undefined : String(obj.name));
      if (name !== undefined) row.name = name;
      const folderId =
        candidate?.folder_id ?? (obj?.folder_id == null ? undefined : Number(obj.folder_id));
      if (folderId !== undefined && Number.isFinite(folderId)) row.folder_id = folderId;
      row.running =
        typeof candidate?.running === 'boolean'
          ? candidate.running
          : graphActiveToRunning(obj?.active);
      const target = stepFor.get(String(calleeId));
      if (target) {
        const step: Record<string, unknown> = { async: target.async };
        if (target.step_as !== undefined) step.as = target.step_as;
        if (target.step_number !== undefined) step.number = target.step_number;
        row.step = step;
      }
      callees.push(row);
    };
    for (const path of graphPaths) {
      if (path.from_type !== 'Flow' || path.to_type !== 'Flow') continue;
      if (Number(path.from_id) !== input.recipe_id) continue;
      pushCallee(Number(path.to_id));
    }
    for (const target of selfEntry?.targets ?? []) pushCallee(Number(target.flow_id));
  }

  // --- other assets from the graph -----------------------------------------
  const connections: Array<Record<string, unknown>> = [];
  const lookupTables: Array<Record<string, unknown>> = [];
  const lcapPages: Array<Record<string, unknown>> = [];
  const touchedByRecipe = new Set<number>();
  for (const path of graphPaths) {
    if (Number(path.from_id) === input.recipe_id) touchedByRecipe.add(Number(path.to_id));
    if (Number(path.to_id) === input.recipe_id) touchedByRecipe.add(Number(path.from_id));
  }
  for (const obj of graphObjects) {
    const id = Number(obj.id);
    if (!Number.isFinite(id) || !touchedByRecipe.has(id)) continue;
    if (obj.type === 'SharedAccount') {
      connections.push(
        stripConnectionSecrets({
          id,
          name: obj.name == null ? undefined : String(obj.name),
          provider: obj.provider == null ? undefined : String(obj.provider),
          active: graphActiveToRunning(obj.active),
        }) as Record<string, unknown>,
      );
    } else if (obj.type === 'LookupTable') {
      lookupTables.push({ id, name: obj.name == null ? undefined : String(obj.name) });
    } else if (obj.type === 'LCAP::Models::Page') {
      lcapPages.push({ id, name: obj.name == null ? undefined : String(obj.name) });
    }
  }

  // --- completeness --------------------------------------------------------
  const reasons: string[] = [];
  if (input.graph_error) reasons.push(`dependency graph unavailable: ${input.graph_error}`);
  if (!input.scope.complete) {
    reasons.push(
      'the candidate listing did not cover the whole scope (page cap, recipe cap, a failed ' +
        'page, or a folder whose membership listing could not be read)',
    );
  }
  if (input.failed_reads.length > 0) {
    reasons.push(
      `${input.failed_reads.length} recipe(s) could not be read (see failed_reads); a caller ` +
        'hiding in one of them would not appear here',
    );
  }
  if (dynamicRows.length > 0) {
    reasons.push(
      `${dynamicRows.length} call step(s) target a flow_id built at runtime (see ` +
        'unresolved_dynamic_targets); no static scan can say whether they call this recipe',
    );
  }
  if (input.sources.indexOf('code') < 0) {
    reasons.push(
      'the code scan was not run, so a caller the dependency graph has not indexed would be missed',
    );
  }
  if (input.jobs_error) reasons.push(`job history unavailable: ${input.jobs_error}`);
  for (const extra of input.extra_reasons ?? []) reasons.push(extra);

  const cappedCallers = cap(callerList, CALLER_LIMITS.callers);
  const cappedCallees = cap(callees, CALLER_LIMITS.callees);
  const cappedConnections = cap(connections, CALLER_LIMITS.connections);
  const cappedTables = cap(lookupTables, CALLER_LIMITS.lookup_tables);
  const cappedPages = cap(lcapPages, CALLER_LIMITS.lcap_pages);
  const cappedDynamic = cap(dynamicRows, CALLER_LIMITS.unresolved_dynamic_targets);
  const cappedFailed = cap(input.failed_reads, CALLER_LIMITS.failed_reads);

  const truncated: Record<string, unknown> = {};
  if (cappedCallers.truncated) truncated.callers = cappedCallers.truncated;
  if (cappedCallees.truncated) truncated.callees = cappedCallees.truncated;
  if (cappedConnections.truncated) truncated.connections = cappedConnections.truncated;
  if (cappedTables.truncated) truncated.lookup_tables = cappedTables.truncated;
  if (cappedPages.truncated) truncated.lcap_pages = cappedPages.truncated;
  if (cappedDynamic.truncated) truncated.unresolved_dynamic_targets = cappedDynamic.truncated;
  if (cappedFailed.truncated) truncated.failed_reads = cappedFailed.truncated;
  if (Object.keys(truncated).length > 0) {
    reasons.push('one or more collections hit their response limit (see truncated)');
  }

  const payload: Record<string, unknown> = {
    recipe_id: input.recipe_id,
    sources: input.sources,
    callers: cappedCallers.list,
    unresolved_dynamic_targets: cappedDynamic.list,
    failed_reads: cappedFailed.list,
    scope: input.scope,
    freshness: {
      index_hits: input.hits.length,
      index_misses: input.candidates.length - input.hits.length,
      snapshot_reads: input.snapshot_reads ?? 0,
      graph_fetched_at: input.graph_fetched_at ?? null,
    },
    limits: CALLER_LIMITS,
    completeness: reasons.length === 0 ? 'complete' : 'partial',
    completeness_reasons: reasons,
  };
  if (input.include_callees) payload.callees = cappedCallees.list;
  if (input.graph !== undefined || input.graph_error !== undefined) {
    payload.connections = cappedConnections.list;
    payload.lookup_tables = cappedTables.list;
    payload.lcap_pages = cappedPages.list;
  }
  if (Object.keys(truncated).length > 0) payload.truncated = truncated;
  if (input.jobs !== undefined) {
    payload.jobs_evidence = {
      note: 'observed execution history: a caller listed here ran at least once, absence proves nothing',
      jobs_scanned: input.jobs.length,
    };
  }
  if (input.include_transitive) {
    const transitive = computeTransitive(edges, input.recipe_id, {
      edges: CALLER_LIMITS.edges,
      cycles: CALLER_LIMITS.cycles,
    });
    payload.transitive = transitive;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Index storage: memory first, chrome.storage.session when the browser has it.
// ---------------------------------------------------------------------------

const INDEX_STORAGE_KEY = 'workato_caller_index_v1';
const INDEX_MAX_ENTRIES = 2000;
const memoryIndex = new Map<string, CallerIndex>();

interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * chrome.storage.session is MV3-only and can be missing (older Chrome, a test
 * runner, a stripped stub). The index degrades to memory when it is.
 */
function sessionArea(): SessionArea | null {
  const session = (globalThis as any)?.chrome?.storage?.session;
  if (!session || typeof session.get !== 'function' || typeof session.set !== 'function') {
    return null;
  }
  return session as SessionArea;
}

export async function loadCallerIndex(namespace: string): Promise<CallerIndex> {
  const cached = memoryIndex.get(namespace);
  if (cached) return cached;
  let loaded: CallerIndex = {};
  const session = sessionArea();
  if (session) {
    try {
      const stored = await session.get(INDEX_STORAGE_KEY);
      const all = stored?.[INDEX_STORAGE_KEY] as Record<string, unknown> | undefined;
      const forNamespace = all && typeof all === 'object' ? all[namespace] : null;
      if (forNamespace && typeof forNamespace === 'object') loaded = forNamespace as CallerIndex;
    } catch {
      /* a session store that refuses to read is not a reason to fail the call */
    }
  }
  memoryIndex.set(namespace, loaded);
  return loaded;
}

/** Keep the newest scans and drop the rest, so a long session cannot grow without bound. */
export function trimCallerIndex(index: CallerIndex, maxEntries: number): CallerIndex {
  const keys = Object.keys(index);
  if (keys.length <= maxEntries) return index;
  keys.sort((a, b) => String(index[b].scanned_at).localeCompare(String(index[a].scanned_at)));
  const trimmed: CallerIndex = {};
  for (const key of keys.slice(0, maxEntries)) trimmed[key] = index[key];
  return trimmed;
}

export async function saveCallerIndex(namespace: string, index: CallerIndex): Promise<void> {
  const trimmed = trimCallerIndex(index, INDEX_MAX_ENTRIES);
  memoryIndex.set(namespace, trimmed);
  const session = sessionArea();
  if (!session) return;
  try {
    const stored = await session.get(INDEX_STORAGE_KEY);
    const existing = stored?.[INDEX_STORAGE_KEY];
    const all: Record<string, unknown> =
      existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : {};
    all[namespace] = trimmed;
    await session.set({ [INDEX_STORAGE_KEY]: all });
  } catch {
    /* the index is an optimisation; a failed write only costs a re-read */
  }
}

/** Test seam: drop the in-memory index so a test starts from a known state. */
export function resetCallerIndexCache(): void {
  memoryIndex.clear();
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

interface RecipeCallersArgs {
  recipe_id: number;
  sources?: CallerSource[];
  folder_ids?: number[];
  project_id?: string | number;
  scope?: 'folders' | 'project' | 'workspace';
  max_recipes?: number;
  max_pages?: number;
  include_transitive?: boolean;
  include_callees?: boolean;
  refresh?: boolean;
  jobs_limit?: number;
  timeout_ms?: number;
  tabId?: number;
  windowId?: number;
}

const VALID_SOURCES: CallerSource[] = ['graph', 'code', 'jobs'];

class WorkatoRecipeCallersTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.RECIPE_CALLERS;

  async execute(args: RecipeCallersArgs): Promise<ToolResult> {
    try {
      const recipeId = args?.recipe_id;
      if (typeof recipeId !== 'number' || !Number.isFinite(recipeId)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }

      let sources: CallerSource[] = ['graph', 'code'];
      if (args.sources !== undefined) {
        if (!Array.isArray(args.sources) || args.sources.length === 0) {
          return createErrorResponse(
            'Param [sources] must be a non-empty array of "graph", "code", "jobs"',
          );
        }
        const unknown = args.sources.filter((s) => VALID_SOURCES.indexOf(s) < 0);
        if (unknown.length > 0) {
          return createErrorResponse(
            `Param [sources] contains unknown value(s) ${JSON.stringify(unknown)}. ` +
              'Allowed: "graph", "code", "jobs".',
          );
        }
        sources = VALID_SOURCES.filter((s) => args.sources!.indexOf(s) >= 0);
      }
      const wantGraph = sources.indexOf('graph') >= 0;
      const wantCode = sources.indexOf('code') >= 0;
      const wantJobs = sources.indexOf('jobs') >= 0;

      const folderIds = Array.isArray(args.folder_ids)
        ? args.folder_ids.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [];
      const projectId =
        args.project_id === undefined || args.project_id === null ? '' : String(args.project_id);

      let scopeMode: ScopeMode;
      if (args.scope === 'workspace') scopeMode = 'workspace';
      else if (args.scope === 'project') scopeMode = 'project';
      else if (args.scope === 'folders') scopeMode = 'folders';
      else if (folderIds.length > 0) scopeMode = 'folders';
      else if (projectId.length > 0) scopeMode = 'project';
      else scopeMode = 'own';

      if (scopeMode === 'folders' && folderIds.length === 0) {
        return createErrorResponse(
          'scope "folders" needs [folder_ids]. Use workato_list_folders to find them, or pass ' +
            'scope:"project" with project_id, or scope:"workspace".',
        );
      }
      if (scopeMode === 'project' && projectId.length === 0) {
        return createErrorResponse(
          'scope "project" needs [project_id] (the project id or its root folder id from ' +
            'workato_list_folders).',
        );
      }

      const maxRecipes = Math.min(Math.max(args.max_recipes ?? 200, 1), 2000);
      const maxPages = Math.min(Math.max(args.max_pages ?? 25, 1), 200);
      const jobsLimit = Math.min(Math.max(args.jobs_limit ?? 50, 1), 100);
      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 60_000, 10_000), 110_000);
      const includeCallees = args.include_callees !== false;
      const includeTransitive = args.include_transitive === true;
      const refresh = args.refresh === true;

      const tab = await findWorkatoTab(args.tabId);
      const deadline = Date.now() + timeoutMs;

      // --- 1. graph + candidate listing -----------------------------------
      const scan = await runInWorkatoTab(
        tab.tabId,
        fetchCallerScanInPage,
        [
          {
            recipeId,
            wantGraph,
            wantCode,
            scopeMode,
            folderIds,
            projectId,
            maxPages,
            maxRecipes,
          },
        ],
        { timeoutMs },
      );

      if (!scan.ok) {
        return createErrorResponse(
          `WorkatoApiError (${scan.failure?.stage}): ${scan.failure?.message ?? 'unknown failure'}`,
        );
      }
      const graphFetchedAt = wantGraph && scan.graph ? new Date().toISOString() : undefined;
      if (wantGraph && !scan.graph && !wantCode && !wantJobs) {
        return createErrorResponse(
          `workato_recipe_callers: the dependency graph could not be read (${scan.graph_error ?? 'unknown error'}) ` +
            'and it was the only requested source. Add "code" to sources, or check that the tab is ' +
            'signed in to the workspace that owns this recipe.',
        );
      }

      // The callee itself is listed too (its own trigger is a recipe function);
      // it is never treated as its own caller, but reading it is what gives the
      // callees[] their step identity.
      const candidates = scan.candidates ?? [];
      const extraReasons: string[] = [];
      for (const listingError of scan.listing_errors ?? []) extraReasons.push(listingError);

      // --- 2. code reads for the candidates the index cannot vouch for -----
      const index = { ...(await loadCallerIndex(tab.origin)) };
      const plan = planIndexReads(candidates, index, refresh);
      const failedReads: FailedRead[] = [];
      let readCount = 0;

      let snapshotReads = 0;
      if (wantCode && plan.to_read.length > 0) {
        const remaining = deadline - Date.now();
        if (remaining < 5_000) {
          extraReasons.push(
            `the ${timeoutMs} ms budget ran out before any recipe code was read; ` +
              `${plan.to_read.length} candidate(s) were left unread. Raise timeout_ms or narrow the scope.`,
          );
        } else {
          const nameById = new Map<number, CandidateRow>();
          for (const candidate of candidates) nameById.set(candidate.id, candidate);

          // A candidate this session already pulled is held in the version-
          // pinned snapshot cache. Reading it through loadRecipeSnapshot costs
          // one cheap metadata request and skips the code body entirely, and
          // the version check means a save since the pull is picked up rather
          // than served stale. Candidates with no snapshot keep the batched
          // in-page read, which is one dispatch for the whole list.
          const toRead: number[] = [];
          for (const candidateId of plan.to_read) {
            if (cachedRecipeVersions(tab.host, candidateId).length === 0) {
              toRead.push(candidateId);
              continue;
            }
            const left = deadline - Date.now();
            if (left < 5_000) {
              toRead.push(candidateId);
              continue;
            }
            let snapshot: Awaited<ReturnType<typeof loadRecipeSnapshot>>;
            try {
              snapshot = await loadRecipeSnapshot(tab, candidateId, {
                timeoutMs: Math.min(left - 2_000, 30_000),
              });
            } catch {
              // Transport trouble on one recipe must not sink the scan; let
              // the batched reader try it and report its own failure.
              toRead.push(candidateId);
              continue;
            }
            if (!snapshot.ok) {
              toRead.push(candidateId);
              continue;
            }
            snapshotReads += 1;
            readCount += 1;
            const fromSnapshot = extractCallTargets(snapshot.code);
            const candidate = nameById.get(candidateId);
            const cachedEntry: CallerIndexEntry = {
              recipe_id: candidateId,
              targets: fromSnapshot.targets,
              dynamic_targets: fromSnapshot.dynamic_targets,
              scanned_at: new Date().toISOString(),
            };
            if (candidate?.name !== undefined) cachedEntry.name = candidate.name;
            if (candidate?.folder_id !== undefined) cachedEntry.folder_id = candidate.folder_id;
            if (candidate?.updated_at !== undefined) cachedEntry.updated_at = candidate.updated_at;
            index[String(candidateId)] = cachedEntry;
          }

          const codeResult =
            toRead.length > 0
              ? await runInWorkatoTab(
                  tab.tabId,
                  fetchRecipeCallStepsInPage,
                  [toRead, Math.max(deadline - Date.now() - 2_000, 1_000)],
                  { timeoutMs: Math.max(deadline - Date.now(), 5_000) },
                )
              : { ok: true, reads: [], unread: [], stopped_early: false };
          for (const read of codeResult.reads) {
            const candidate = nameById.get(read.recipe_id);
            if (!read.ok) {
              const reason =
                read.status === 404
                  ? 'not found (deleted, or moved out of this scope), its index entry was dropped'
                  : read.status === 403 || read.status === 401
                    ? 'not readable with this session (permissions)'
                    : (read.message ?? 'read failed');
              const failure: FailedRead = { recipe_id: read.recipe_id, reason };
              if (candidate?.name !== undefined) failure.name = candidate.name;
              if (read.status !== undefined) failure.status = read.status;
              failedReads.push(failure);
              delete index[String(read.recipe_id)];
              continue;
            }
            readCount += 1;
            const extracted = extractCallTargets(read.steps ?? []);
            const entry: CallerIndexEntry = {
              recipe_id: read.recipe_id,
              targets: extracted.targets,
              dynamic_targets: extracted.dynamic_targets,
              scanned_at: new Date().toISOString(),
            };
            if (candidate?.name !== undefined) entry.name = candidate.name;
            if (candidate?.folder_id !== undefined) entry.folder_id = candidate.folder_id;
            if (candidate?.updated_at !== undefined) entry.updated_at = candidate.updated_at;
            index[String(read.recipe_id)] = entry;
          }
          if (codeResult.stopped_early) {
            extraReasons.push(
              `the read budget ran out with ${codeResult.unread.length} candidate(s) unread ` +
                `(${codeResult.unread.slice(0, 10).join(', ')}${codeResult.unread.length > 10 ? ', ...' : ''}). ` +
                'Raise timeout_ms or narrow the scope.',
            );
          }
          await saveCallerIndex(tab.origin, index);
        }
      }

      // --- 3. observed execution history ----------------------------------
      let jobs: JobCallerRow[] | undefined;
      let jobsError: string | undefined;
      if (wantJobs) {
        const remaining = deadline - Date.now();
        if (remaining < 3_000) {
          jobsError = 'the timeout budget ran out before the job history could be read';
        } else {
          const jobsResult = await runInWorkatoTab(
            tab.tabId,
            fetchCalleeJobCallersInPage,
            [recipeId, jobsLimit],
            { timeoutMs: Math.min(remaining, 30_000) },
          );
          if (jobsResult.ok) jobs = jobsResult.jobs ?? [];
          else jobsError = jobsResult.failure?.message ?? 'job history read failed';
        }
      }

      // --- 4. answer -------------------------------------------------------
      const scopeComplete =
        (!wantCode || (scan.listing_complete !== false && extraReasons.length === 0)) &&
        failedReads.length === 0;
      const scope: ScopeInfo = {
        mode: scopeMode,
        folder_ids: scan.folder_ids ?? [],
        recipes_listed: candidates.length,
        recipes_read: readCount,
        pages: scan.pages ?? 0,
        complete: scopeComplete,
      };
      if (scan.membership_source !== undefined) scope.membership = scan.membership_source;
      if (scan.folder_members !== undefined) scope.folder_members = scan.folder_members;

      const payload = buildCallersPayload({
        recipe_id: recipeId,
        sources,
        graph: scan.graph,
        graph_error: scan.graph_error,
        graph_fetched_at: graphFetchedAt,
        snapshot_reads: snapshotReads,
        candidates,
        index,
        hits: plan.hits,
        failed_reads: failedReads,
        jobs,
        jobs_error: jobsError,
        scope,
        include_callees: includeCallees,
        include_transitive: includeTransitive,
        extra_reasons: extraReasons,
      });

      const callerCount = (payload.callers as unknown[]).length;
      const scopeLabel =
        scopeMode === 'workspace'
          ? 'workspace'
          : scopeMode === 'project'
            ? `project ${projectId}`
            : `folder(s) ${(scan.folder_ids ?? []).join(', ') || 'none'}`;
      const partial = payload.completeness === 'partial';
      const summary =
        `${callerCount} caller(s) of recipe ${recipeId} via ${sources.join('+')} in ${scopeLabel}` +
        (partial
          ? '. PARTIAL scan: this is NOT proof that no other caller exists (see completeness_reasons)'
          : '. Scan complete for this scope');

      return {
        content: [{ type: 'text', text: `${summary}\n${JSON.stringify(payload)}` }],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_recipe_callers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoRecipeCallersTool = new WorkatoRecipeCallersTool();
