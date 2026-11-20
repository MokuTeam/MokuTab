import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { buildSlimRecipe, extractHighlights, type RecipeListItem } from './slim-asset';

/**
 * workato_search_recipes.
 *
 * `text` is NOT a name substring: Workato runs a full-text search over the
 * recipe name, its description AND its trigger/action titles, which is why
 * "ECO" answers with "New/updated records". The name-only modes here are
 * applied client-side over walked pages, and every response says how much of
 * the workspace was actually looked at.
 *
 * folder_id is NOT server-side either. /web_api/mixed_assets.json accepts it
 * and ignores it (verified 2026-09-07: folder_id=30573643 answered with 20
 * recipes across four folders), so the folder filter is applied here. Exact
 * membership comes from GET
 * /dependency_graphs.json?asset_type=recipe&folder_id=<id>, which answers
 * {"result":[[recipe_id,"name"], ...]}; the page walk then only supplies the
 * item metadata and stops as soon as every member has been seen. When that
 * listing cannot be read the walk falls back to filtering on item.folder_id.
 */

type MatchMode = 'fulltext' | 'name_substring' | 'name_word' | 'name_exact' | 'name_regex';

const MATCH_MODES: readonly MatchMode[] = [
  'fulltext',
  'name_substring',
  'name_word',
  'name_exact',
  'name_regex',
];

interface SearchRecipesArgs {
  text?: string;
  match?: MatchMode;
  /** Adapter technical name(s), e.g. "salesforce". One name uses the server filter. */
  app?: string | string[];
  /** Client-side running-state filter. */
  running?: boolean;
  folder_id?: number;
  page?: number;
  /** Pages walked from `page`. Default 5, clamped 1-50. 20 recipes per page. */
  max_pages?: number;
  /** Max recipes returned. Default 20, clamped 1-100. */
  limit?: number;
  sort?: 'latest_activity' | 'name' | 'updated_at' | 'created_at' | 'relevance';
  full?: boolean;
  timeout_ms?: number;
  tabId?: number;
}

export interface SearchRecipesWalkOptions {
  text: string;
  folderId: number | null;
  startPage: number;
  maxPages: number;
  sort: string;
  /** Single adapter for the server-side `adapters=` filter, or null. */
  adapter: string | null;
  /** Keep the per-item `highlights` block. Meaningless (and huge) without text. */
  keepHighlights: boolean;
  budgetMs: number;
}

export interface SearchRecipesWalkResult {
  ok: boolean;
  items?: unknown[];
  count?: number;
  per_page?: number;
  pages_scanned?: number;
  last_page?: number;
  /** True when a short page proved the list ended. */
  end_of_list?: boolean;
  /** True when a page after the first failed: coverage is unknown, not finished. */
  incomplete?: boolean;
  incomplete_reason?: string;
  /** How the folder scope was applied. Absent when no folder_id was given. */
  folder_filter?: 'dependency_graph' | 'item_folder_id';
  /** Recipes the dependency-graph listing reported for the folder. */
  folder_members?: number;
  /** How many of those the walk actually saw in the list pages. */
  folder_members_seen?: number;
  /** Why the membership listing could not be used, when it could not. */
  folder_membership_error?: string;
  /** Recipes the pages returned before the folder filter dropped them. */
  scanned_before_filter?: number;
  failure?: {
    stage: 'search' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * Runs in the Workato tab's MAIN world. Plain function returning a Promise
 * chain. DO NOT add async/await (see scripts/check-bundle.mjs).
 */
export function searchRecipesInPage(
  opts: SearchRecipesWalkOptions,
): Promise<SearchRecipesWalkResult> {
  const PER_PAGE = 20;
  const deadline =
    Date.now() + (typeof opts.budgetMs === 'number' && opts.budgetMs > 0 ? opts.budgetMs : 22000);
  const fetchOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };

  function buildUrl(page: number): string {
    const params = new URLSearchParams();
    params.set('asset_type', 'recipe');
    params.set('sort_term', opts.sort);
    params.set('page', String(page));
    if (opts.text) params.set('text', opts.text);
    if (opts.folderId !== null && opts.folderId !== undefined) {
      params.set('folder_id', String(opts.folderId));
    }
    if (opts.adapter) params.set('adapters', opts.adapter);
    return `/web_api/mixed_assets.json?${params.toString()}`;
  }

  function fetchPage(page: number): Promise<{
    ok: boolean;
    items?: unknown[];
    count?: number;
    per_page?: number;
    failure?: SearchRecipesWalkResult['failure'];
  }> {
    const url = buildUrl(page);
    return fetch(url, fetchOpts).then((r) =>
      r.text().then((bodyText) => {
        if (r.status < 200 || r.status >= 300) {
          return {
            ok: false,
            failure: {
              stage: 'search' as const,
              status: r.status,
              body_excerpt: bodyText.slice(0, 1024),
              message: `GET ${url} returned HTTP ${r.status}`,
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
              body_excerpt: bodyText.slice(0, 1024),
              message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
            },
          };
        }
        const result = (
          json as { result?: { items?: unknown[]; count?: number; per_page?: number } }
        ).result;
        if (!result || !Array.isArray(result.items)) {
          return {
            ok: false,
            failure: {
              stage: 'shape' as const,
              body_excerpt: bodyText.slice(0, 1024),
              message: 'Unexpected response shape: missing result.items array.',
            },
          };
        }
        return { ok: true, items: result.items, count: result.count, per_page: result.per_page };
      }),
    );
  }

  /**
   * With no `text`, Workato returns a highlights block with a span between
   * every character (10-17 KB per item) that says nothing. Drop it there.
   */
  function trimItem(item: unknown): unknown {
    if (!item || typeof item !== 'object' || opts.keepHighlights) return item;
    const copy: Record<string, unknown> = {};
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key === 'highlights') continue;
      copy[key] = record[key];
    }
    return copy;
  }

  const state = {
    items: [] as unknown[],
    count: 0,
    perPage: PER_PAGE,
    pagesScanned: 0,
    scannedBeforeFilter: 0,
    lastPage: opts.startPage,
    endOfList: false,
    incomplete: false,
    incompleteReason: undefined as string | undefined,
    /** Exact folder membership, or null when it could not be established. */
    memberIds: null as Record<string, boolean> | null,
    memberCount: 0,
    membersSeen: 0,
    membershipError: undefined as string | undefined,
  };

  /**
   * Exact membership of the scoped folder. The recipe list endpoint ignores
   * folder_id, so this top-level dependency graph listing is the only answer
   * to "which recipes live in this folder".
   */
  function loadMembership(folderId: number): Promise<void> {
    const url = `/dependency_graphs.json?asset_type=recipe&folder_id=${folderId}`;
    return fetch(url, fetchOpts).then(
      (r) =>
        r.text().then((body) => {
          if (r.status < 200 || r.status >= 300) {
            state.membershipError = `GET ${url} returned HTTP ${r.status}`;
            return;
          }
          try {
            const json = JSON.parse(body) as { result?: unknown };
            const list = Array.isArray(json.result) ? json.result : [];
            const ids: Record<string, boolean> = {};
            let count = 0;
            for (let i = 0; i < list.length; i++) {
              const row = list[i];
              const id = Array.isArray(row) ? Number(row[0]) : Number(row);
              if (!Number.isFinite(id)) continue;
              if (ids[String(id)]) continue;
              ids[String(id)] = true;
              count++;
            }
            state.memberIds = ids;
            state.memberCount = count;
          } catch (e) {
            state.membershipError = `GET ${url}: JSON.parse failed: ${
              e instanceof Error ? e.message : String(e)
            }`;
          }
        }),
      (e) => {
        state.membershipError = `GET ${url} failed: ${e instanceof Error ? e.message : String(e)}`;
      },
    );
  }

  /** Client-side folder filter: by exact membership when known, else by item.folder_id. */
  function inFolder(item: unknown): boolean {
    if (opts.folderId === null || opts.folderId === undefined) return true;
    const rec = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const id = rec ? Number(rec.id) : NaN;
    if (state.memberIds !== null) {
      if (!Number.isFinite(id) || !state.memberIds[String(id)]) return false;
      state.membersSeen++;
      return true;
    }
    return rec != null && Number(rec.folder_id) === Number(opts.folderId);
  }

  function loop(page: number): Promise<SearchRecipesWalkResult> {
    return fetchPage(page).then((res) => {
      if (!res.ok) {
        // A first-page failure is a real error; a later page failing means the
        // scan stopped early and MUST NOT read as the end of the list.
        if (state.pagesScanned === 0) return { ok: false, failure: res.failure };
        state.incomplete = true;
        state.incompleteReason = res.failure ? res.failure.message : 'page fetch failed';
        return finish();
      }
      state.pagesScanned++;
      state.lastPage = page;
      state.count = Number(res.count || 0);
      if (typeof res.per_page === 'number' && res.per_page > 0) state.perPage = res.per_page;
      const items = res.items || [];
      state.scannedBeforeFilter += items.length;
      for (let i = 0; i < items.length; i++) {
        if (!inFolder(items[i])) continue;
        state.items.push(trimItem(items[i]));
      }
      if (items.length < state.perPage) {
        state.endOfList = true;
        return finish();
      }
      // Every recipe of the folder has been seen: nothing later in the list
      // can belong to this scope, so the walk is done and complete.
      if (state.memberIds !== null && state.membersSeen >= state.memberCount) {
        state.endOfList = true;
        return finish();
      }
      if (state.pagesScanned >= opts.maxPages) return finish();
      if (Date.now() >= deadline) {
        state.incomplete = true;
        state.incompleteReason = 'in-page time budget ran out';
        return finish();
      }
      return loop(page + 1);
    });
  }

  function finish(): SearchRecipesWalkResult {
    const out: SearchRecipesWalkResult = {
      ok: true,
      items: state.items,
      count: state.count,
      per_page: state.perPage,
      pages_scanned: state.pagesScanned,
      last_page: state.lastPage,
      end_of_list: state.endOfList,
      incomplete: state.incomplete,
      incomplete_reason: state.incompleteReason,
    };
    if (opts.folderId !== null && opts.folderId !== undefined) {
      out.folder_filter = state.memberIds !== null ? 'dependency_graph' : 'item_folder_id';
      out.scanned_before_filter = state.scannedBeforeFilter;
      if (state.memberIds !== null) {
        out.folder_members = state.memberCount;
        out.folder_members_seen = state.membersSeen;
      }
      if (state.membershipError !== undefined) {
        out.folder_membership_error = state.membershipError;
      }
    }
    return out;
  }

  if (opts.folderId === null || opts.folderId === undefined) return loop(opts.startPage);
  return loadMembership(opts.folderId).then(() => {
    // An empty folder needs no walk at all.
    if (state.memberIds !== null && state.memberCount === 0) {
      state.endOfList = true;
      return finish();
    }
    return loop(opts.startPage);
  });
}

/** Does this recipe's name satisfy the client-side match mode? */
export function nameMatches(name: string, text: string, mode: MatchMode): boolean {
  if (mode === 'fulltext' || text === '') return true;
  const haystack = String(name ?? '');
  if (mode === 'name_exact') return haystack.toLowerCase() === text.toLowerCase();
  if (mode === 'name_substring') return haystack.toLowerCase().includes(text.toLowerCase());
  if (mode === 'name_word') {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i').test(haystack);
  }
  try {
    return new RegExp(text, 'i').test(haystack);
  } catch {
    return false;
  }
}

/** A recipe uses an app when it is its trigger app or one of its action apps. */
export function usesApps(item: RecipeListItem, apps: readonly string[]): boolean {
  if (apps.length === 0) return true;
  const actions = Array.isArray(item.action_applications)
    ? item.action_applications.map(String)
    : [];
  const trigger = String(item.trigger_application ?? '');
  return apps.every((app) => trigger === app || actions.includes(app));
}

class WorkatoSearchRecipesTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.SEARCH_RECIPES;

  async execute(args: SearchRecipesArgs): Promise<ToolResult> {
    try {
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      const match: MatchMode = args?.match ?? 'fulltext';
      if (!MATCH_MODES.includes(match)) {
        return createErrorResponse(`Param [match] must be one of ${MATCH_MODES.join(', ')}.`);
      }
      if (match !== 'fulltext' && text === '') {
        return createErrorResponse(
          `Param [match]='${match}' needs [text] to match against. Omit match to list recipes.`,
        );
      }
      if (match === 'name_regex') {
        try {
          new RegExp(text, 'i');
        } catch (e) {
          return createErrorResponse(
            `Param [text] is not a valid regular expression: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }

      const apps: string[] = [];
      if (args?.app !== undefined) {
        const raw = Array.isArray(args.app) ? args.app : [args.app];
        for (const app of raw) {
          if (typeof app !== 'string' || app.trim() === '') {
            return createErrorResponse(
              'Param [app] must be an adapter technical name, or an array of them. Find names ' +
                'with workato_apps_list.',
            );
          }
          apps.push(app.trim());
        }
      }
      if (args?.running !== undefined && typeof args.running !== 'boolean') {
        return createErrorResponse('Param [running] must be a boolean.');
      }

      const folderId =
        typeof args?.folder_id === 'number' && Number.isFinite(args.folder_id)
          ? args.folder_id
          : null;
      const page =
        typeof args?.page === 'number' && Number.isFinite(args.page) && args.page >= 1
          ? Math.floor(args.page)
          : 1;
      const maxPages =
        typeof args?.max_pages === 'number' && Number.isFinite(args.max_pages)
          ? Math.min(Math.max(Math.floor(args.max_pages), 1), 50)
          : 5;
      const limit =
        typeof args?.limit === 'number' && Number.isFinite(args.limit)
          ? Math.min(Math.max(Math.floor(args.limit), 1), 100)
          : 20;
      const sort = args?.sort ?? 'latest_activity';
      const full = args?.full === true;
      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 45_000, 10_000), 110_000);

      // Server-side `text` is a full-text prefilter. A name-only mode must not
      // use it: the two searches do not agree (a regex can match a name the
      // full-text index never returns), so those modes walk pages instead.
      const serverText = match === 'fulltext' ? text : '';
      // adapters= is exact and server-side for ONE app; several are filtered
      // client-side, where "uses all of them" is unambiguous.
      const serverAdapter = apps.length === 1 ? apps[0] : null;

      const tab = await findWorkatoTab(args.tabId);
      const result = await runInWorkatoTab(
        tab.tabId,
        searchRecipesInPage,
        [
          {
            text: serverText,
            folderId,
            startPage: page,
            maxPages,
            sort,
            adapter: serverAdapter,
            keepHighlights: serverText !== '',
            budgetMs: Math.max(timeoutMs - 8_000, 8_000),
          },
        ],
        { timeoutMs },
      );

      if (!result.ok) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
            (result.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      const scanned = (result.items ?? []) as RecipeListItem[];
      const clientApps = serverAdapter === null ? apps : [];
      const filtered = scanned.filter((item) => {
        if (!nameMatches(String(item?.name ?? ''), text, match)) return false;
        if (!usesApps(item, clientApps)) return false;
        if (args?.running !== undefined && Boolean(item?.running) !== args.running) return false;
        return true;
      });
      const kept = filtered.slice(0, limit);

      const pagesScanned = result.pages_scanned ?? 0;
      const complete = result.end_of_list === true && result.incomplete !== true;
      const nextPage = complete ? undefined : (result.last_page ?? page) + 1;

      const coverage = {
        pages_scanned: pagesScanned,
        pages_requested: maxPages,
        recipes_scanned: scanned.length,
        matched: filtered.length,
        returned: kept.length,
        complete,
        next_page: nextPage,
        ...(result.incomplete ? { incomplete_reason: result.incomplete_reason } : {}),
        ...(folderId === null
          ? {}
          : {
              folder_id: folderId,
              folder_filter: 'client-side: Workato ignores folder_id on the recipe list endpoint',
              folder_membership:
                result.folder_filter === 'dependency_graph'
                  ? 'exact, from GET /dependency_graphs.json?asset_type=recipe&folder_id=<id>'
                  : 'best effort, from item.folder_id on each listed recipe',
              folder_members: result.folder_members,
              recipes_listed_before_folder_filter: result.scanned_before_filter,
              ...(result.folder_membership_error
                ? { folder_membership_error: result.folder_membership_error }
                : {}),
            }),
      };

      const payload = {
        count: Number(result.count ?? 0),
        page,
        per_page: Number(result.per_page ?? 20),
        limit,
        match,
        ...(apps.length ? { app: apps, app_filter: serverAdapter ? 'server' : 'client' } : {}),
        coverage,
        next_page: nextPage,
        recipes: full
          ? kept
          : kept.map((item) => {
              const slim = buildSlimRecipe(item);
              const matched = match === 'fulltext' ? extractHighlights(item) : null;
              return matched ? { ...slim, matched } : slim;
            }),
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
        `workato_search_recipes failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoSearchRecipesTool = new WorkatoSearchRecipesTool();
