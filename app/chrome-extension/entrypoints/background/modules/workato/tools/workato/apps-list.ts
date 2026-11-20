import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';

/**
 * workato_apps_list: "which apps can I build a step with, and what are they
 * called technically?"
 *
 * workato_adapter_meta answers everything about ONE connector, but only once
 * its technical name is known, and that name is the part nobody can guess for
 * a custom connector (`netsuite_rest_connector_5105163_1745592003`), for a
 * Workato tool ("HTTP" is `rest`, "Scheduler" is `clock`) or for a standard
 * connector the workspace has never connected. This tool is the step before it.
 *
 * Sources, all read-only, merged by adapter name:
 *   /web_api/dynamic_app_config/<sha256>.js          The catalogue. Every app
 *       page embeds this script; it sets window.Workato.config whose
 *       `providers` map holds all 338 standard connectors with title, aliases,
 *       categories, counts and whether a connection is needed. The hash is per
 *       Workato deployment (identical across workspaces), so it doubles as the
 *       cache key: the HTML of "/" is re-read on every call, the 320 KB file
 *       only when the hash changed. Captured 2026-09-08.
 *   /web_api/mixed_assets.json?asset_type=connection  Apps with a real
 *       connection, i.e. the ones a step can authenticate as today.
 *   /web_api/mixed_assets/adapters.json               Adapters already used by
 *       recipes here. Tiny, and the fastest read of "what is built with".
 *   /web_api/published_custom_adapters.json           This workspace's own SDK
 *       connectors: title -> generated name.
 *   /web_api/certified_custom_adapters.json           Workato's certified
 *       community catalogue (178 entries, ~70 KB), searched when asked.
 *
 * Before the catalogue was found this tool seeded 18 hard-coded built-in names
 * and told the caller that Workato serves no catalogue. That was wrong; the
 * recipe editor's app picker issues no request because the list is preloaded,
 * not because it does not exist.
 */

interface AppsListArgs {
  /** Case-insensitive substring matched against adapter name, title, aliases and categories. */
  query?: string;
  /** Case-insensitive exact match on one category, e.g. "CRM". */
  category?: string;
  /** Show catalogue entries Workato marks deprecated. Default false. */
  include_deprecated?: boolean;
  /** Only apps with a connection in this workspace. Default false. */
  only_connected?: boolean;
  /** Search the certified community catalogue too. Defaults to true when `query` is set. */
  include_certified?: boolean;
  /** Max apps returned. Default 50 when narrowed, 200 otherwise, clamped 1..1000. */
  limit?: number;
  /** In-page fetch timeout. Default 30000, clamped 10000..110000. */
  timeout_ms?: number;
  tabId?: number;
}

/** One source's outcome: a failed optional source must not sink the whole call. */
interface SourceResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  message?: string;
}

/** A catalogue entry as reduced in page. The 320 KB document never leaves the tab. */
export interface CatalogueEntry {
  name: string;
  title?: string;
  aliases?: string[];
  categories?: string[];
  connection_required?: boolean;
  actions_count?: number;
  triggers_count?: number;
  deprecated_actions_count?: number;
  deprecated_triggers_count?: number;
  deprecated?: boolean;
  secondary?: boolean;
  required_feature?: string;
  url_name?: string;
}

interface CatalogueSource extends SourceResult {
  /** The sha256 from the script tag; the deployment's version of the catalogue. */
  hash?: string;
  /** True when the page still names the hash the caller already holds. */
  unchanged?: boolean;
  entries?: CatalogueEntry[];
}

interface InPageResult {
  connections: SourceResult;
  usedAdapters: SourceResult;
  custom: SourceResult;
  certified: SourceResult;
  catalogue: CatalogueSource;
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based.
 * DO NOT add async/await (WXT/Vite rewrites it into a hoisted helper that does
 * not survive Function.prototype.toString; see pull-recipe.ts).
 */
function fetchAppSourcesInPage(
  includeCertified: boolean,
  connectionPages: number,
  knownCatalogueHash: string | null,
): Promise<InPageResult> {
  const opts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };

  function getJson(url: string): Promise<SourceResult> {
    return fetch(url, opts).then(
      (r) =>
        r.text().then((body) => {
          if (r.status < 200 || r.status >= 300) {
            return {
              ok: false,
              status: r.status,
              message: `GET ${url} returned HTTP ${r.status}: ${body.slice(0, 200)}`,
            };
          }
          try {
            return { ok: true, status: r.status, body: JSON.parse(body) };
          } catch (e) {
            return {
              ok: false,
              status: r.status,
              message: `GET ${url}: JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        }),
      (e) => ({
        ok: false,
        message: `GET ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
    );
  }

  // Connections paginate at 20; walk a bounded number of pages and concatenate.
  function fetchConnections(page: number, acc: unknown[]): Promise<SourceResult> {
    const url = `/web_api/mixed_assets.json?asset_type=connection&sort_term=name&page=${page}`;
    return getJson(url).then((res) => {
      if (!res.ok) return page === 1 ? res : { ok: true, body: { result: { items: acc } } };
      const result = (res.body as { result?: { items?: unknown[] } } | null)?.result;
      const items = result && Array.isArray(result.items) ? result.items : [];
      const next = acc.concat(items);
      if (items.length === 0 || page >= connectionPages) {
        return { ok: true, body: { result: { items: next } } };
      }
      return fetchConnections(page + 1, next);
    });
  }

  // Reduce one providers entry to the fields a caller can act on.
  function slimProvider(key: string, p: any): CatalogueEntry {
    const out: CatalogueEntry = { name: key };
    if (typeof p.title === 'string') out.title = p.title;
    if (Array.isArray(p.aliases)) {
      const aliases = p.aliases.filter((a: unknown) => typeof a === 'string');
      if (aliases.length > 0) out.aliases = aliases;
    }
    if (Array.isArray(p.categories)) {
      const categories = p.categories.filter((c: unknown) => typeof c === 'string');
      if (categories.length > 0) out.categories = categories;
    }
    if (p.config && typeof p.config.required === 'boolean') {
      out.connection_required = p.config.required;
    }
    if (typeof p.actions_count === 'number') out.actions_count = p.actions_count;
    if (typeof p.triggers_count === 'number') out.triggers_count = p.triggers_count;
    if (typeof p.deprecated_actions_count === 'number') {
      out.deprecated_actions_count = p.deprecated_actions_count;
    }
    if (typeof p.deprecated_triggers_count === 'number') {
      out.deprecated_triggers_count = p.deprecated_triggers_count;
    }
    if (p.deprecated === true) out.deprecated = true;
    if (p.secondary === true) out.secondary = true;
    if (typeof p.required_feature === 'string') out.required_feature = p.required_feature;
    if (typeof p.url_name === 'string' && p.url_name !== key) out.url_name = p.url_name;
    return out;
  }

  // The catalogue: hash from the HTML of "/", then the config script.
  function fetchCatalogue(): Promise<CatalogueSource> {
    return fetch('/', { credentials: 'include', headers: { accept: 'text/html' } })
      .then((r) =>
        r.text().then((html) => {
          if (r.status < 200 || r.status >= 300) {
            return {
              ok: false,
              status: r.status,
              message: `GET / returned HTTP ${r.status}; the catalogue hash could not be read`,
            } as CatalogueSource;
          }
          const m = /dynamic_app_config\/([0-9a-f]{64})\.js/.exec(html);
          if (!m) {
            return {
              ok: false,
              message:
                'The HTML of / names no dynamic_app_config script; Workato may have moved the ' +
                'catalogue. Falling back to the workspace sources only.',
            } as CatalogueSource;
          }
          const hash = m[1];
          if (knownCatalogueHash !== null && knownCatalogueHash === hash) {
            return { ok: true, hash: hash, unchanged: true } as CatalogueSource;
          }
          const url = `/web_api/dynamic_app_config/${hash}.js`;
          return fetch(url, { credentials: 'include' }).then((cr) =>
            cr.text().then((js) => {
              if (cr.status < 200 || cr.status >= 300) {
                return {
                  ok: false,
                  status: cr.status,
                  hash: hash,
                  message: `GET ${url} returned HTTP ${cr.status}`,
                } as CatalogueSource;
              }
              const startMarker = 'window.Workato.config = ';
              const start = js.indexOf(startMarker);
              const end = js.indexOf('};\nvar providers');
              if (start < 0 || end < 0) {
                return {
                  ok: false,
                  hash: hash,
                  message: `${url}: the window.Workato.config assignment was not where expected`,
                } as CatalogueSource;
              }
              let config: any = null;
              try {
                config = JSON.parse(js.slice(start + startMarker.length, end + 1));
              } catch (e) {
                return {
                  ok: false,
                  hash: hash,
                  message: `${url}: JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
                } as CatalogueSource;
              }
              const providers = config && config.providers;
              if (!providers || typeof providers !== 'object') {
                return {
                  ok: false,
                  hash: hash,
                  message: `${url}: no providers map in window.Workato.config`,
                } as CatalogueSource;
              }
              const entries: CatalogueEntry[] = [];
              const keys = Object.keys(providers);
              for (let i = 0; i < keys.length; i++) {
                const p = providers[keys[i]];
                if (p && typeof p === 'object') entries.push(slimProvider(keys[i], p));
              }
              return { ok: true, hash: hash, entries: entries } as CatalogueSource;
            }),
          );
        }),
      )
      .then(
        (res) => res,
        (e) =>
          ({
            ok: false,
            message: `catalogue fetch failed: ${e instanceof Error ? e.message : String(e)}`,
          }) as CatalogueSource,
      );
  }

  return Promise.all([
    fetchConnections(1, []),
    getJson('/web_api/mixed_assets/adapters.json'),
    getJson('/web_api/published_custom_adapters.json'),
    includeCertified
      ? getJson('/web_api/certified_custom_adapters.json')
      : Promise.resolve({ ok: true, body: null } as SourceResult),
    fetchCatalogue(),
  ]).then((r) => ({
    connections: r[0],
    usedAdapters: r[1],
    custom: r[2],
    certified: r[3],
    catalogue: r[4],
  }));
}

// ---------------------------------------------------------------------------
// Pure shaping helpers. Exported for unit tests, no browser needed.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** One connection, trimmed to what decides whether a step can use it. */
export interface AppConnection {
  id: number;
  name: string;
  /**
   * Workato's authorization_status, e.g. "success". Anything else means the
   * step will fail; "success" does NOT prove the connection works (two
   * Salesforce connections reported success and answered every call with
   * HTTP 420 on 2026-09-08). workato_step_schema with an empty input is the
   * cheap liveness probe.
   */
  status?: string;
}

export type AppSource = 'connection' | 'recipes' | 'builtin' | 'custom' | 'standard' | 'certified';

export interface AppEntry {
  /** The technical adapter name: what goes into step.provider. */
  name: string;
  title?: string;
  aliases?: string[];
  /**
   * Where this app was seen. Order of usefulness:
   *   connection  has a connection here, usable right now
   *   recipes     already used by a recipe here, so there are live examples
   *   builtin     one of Workato's own tools (categories Workato / Recipe Tools)
   *   custom      this workspace's own SDK connector
   *   standard    in Workato's standard catalogue, no connection here yet
   *   certified   in Workato's certified community catalogue, not installed here
   */
  source: AppSource[];
  connections?: AppConnection[];
  categories?: string[];
  /** False = no connection needed, and no `account_id` in the recipe config entry. */
  connection_required?: boolean;
  triggers_count?: number;
  actions_count?: number;
  deprecated_actions_count?: number;
  deprecated_triggers_count?: number;
  /** Workato marks the whole connector deprecated. Hidden unless asked for or in use here. */
  deprecated?: boolean;
  /** A "secondary" variant (a second connection of the same app in one recipe). */
  secondary?: boolean;
  /** Feature gate the workspace must have for this connector. */
  required_feature?: string;
}

/** Categories Workato puts its own tools under. Those entries are `builtin`. */
const WORKATO_TOOL_CATEGORIES = new Set(['Workato', 'Recipe Tools']);

/** Build the case-insensitive name/title/alias/category matcher. */
export function buildAppMatcher(query: string): (app: AppEntry) => boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return () => true;
  return (app) =>
    app.name.toLowerCase().includes(needle) ||
    (app.title?.toLowerCase().includes(needle) ?? false) ||
    (app.aliases?.some((a) => a.toLowerCase().includes(needle)) ?? false) ||
    (app.categories?.some((c) => c.toLowerCase().includes(needle)) ?? false);
}

/** Exact, case-insensitive category filter. */
export function buildCategoryMatcher(category: string): (app: AppEntry) => boolean {
  const wanted = category.trim().toLowerCase();
  if (wanted.length === 0) return () => true;
  return (app) => app.categories?.some((c) => c.toLowerCase() === wanted) ?? false;
}

/**
 * Whether a deprecated catalogue entry should still be listed.
 *
 * A connector Workato retired is noise in a search for something to build
 * with, unless this workspace already connected it or built with it: then it
 * is a fact about the workspace, and hiding it would hide a running recipe's
 * provider.
 */
export function isVisibleApp(app: AppEntry, includeDeprecated: boolean): boolean {
  if (includeDeprecated || app.deprecated !== true) return true;
  return app.source.includes('connection') || app.source.includes('recipes');
}

function upsert(map: Map<string, AppEntry>, name: string): AppEntry {
  const existing = map.get(name);
  if (existing) return existing;
  const created: AppEntry = { name, source: [] };
  map.set(name, created);
  return created;
}

function markSource(app: AppEntry, source: AppSource): void {
  if (!app.source.includes(source)) app.source.push(source);
}

/** Pull `{title, aliases, triggers_count, actions_count}` out of a custom-adapter record. */
function applyAdapterConfig(app: AppEntry, config: unknown): void {
  if (!isRecord(config)) return;
  if (typeof config.title === 'string' && !app.title) app.title = config.title;
  if (Array.isArray(config.aliases)) {
    const aliases = config.aliases.filter((a): a is string => typeof a === 'string');
    if (aliases.length > 0 && !app.aliases) app.aliases = aliases;
  }
  if (typeof config.triggers_count === 'number' && app.triggers_count === undefined) {
    app.triggers_count = config.triggers_count;
  }
  if (typeof config.actions_count === 'number' && app.actions_count === undefined) {
    app.actions_count = config.actions_count;
  }
}

function applyCatalogueEntry(app: AppEntry, raw: CatalogueEntry): void {
  if (raw.title && !app.title) app.title = raw.title;
  if (raw.aliases && raw.aliases.length > 0) app.aliases = raw.aliases;
  if (raw.categories && raw.categories.length > 0) app.categories = raw.categories;
  if (typeof raw.connection_required === 'boolean')
    app.connection_required = raw.connection_required;
  if (typeof raw.actions_count === 'number') app.actions_count = raw.actions_count;
  if (typeof raw.triggers_count === 'number') app.triggers_count = raw.triggers_count;
  if (typeof raw.deprecated_actions_count === 'number') {
    app.deprecated_actions_count = raw.deprecated_actions_count;
  }
  if (typeof raw.deprecated_triggers_count === 'number') {
    app.deprecated_triggers_count = raw.deprecated_triggers_count;
  }
  if (raw.deprecated === true) app.deprecated = true;
  if (raw.secondary === true) app.secondary = true;
  if (typeof raw.required_feature === 'string') app.required_feature = raw.required_feature;
}

/**
 * Merge the raw source bodies into one adapter-name-keyed list.
 *
 * Sorted so the immediately usable apps come first: connected, then used in
 * recipes, then Workato's own tools, then this workspace's SDK connectors,
 * then the standard catalogue, then the certified catalogue, alphabetical
 * within each band. An agent that reads only the head of a long list still
 * gets the ones it can actually build against.
 */
export function mergeAppSources(sources: {
  connections?: unknown;
  usedAdapters?: unknown;
  catalogue?: CatalogueEntry[];
  custom?: unknown;
  certified?: unknown;
}): AppEntry[] {
  const map = new Map<string, AppEntry>();

  const connItems = isRecord(sources.connections)
    ? (sources.connections.result as { items?: unknown[] } | undefined)?.items
    : undefined;
  if (Array.isArray(connItems)) {
    for (const raw of connItems) {
      if (!isRecord(raw)) continue;
      const provider = typeof raw.provider === 'string' ? raw.provider : '';
      if (!provider) continue;
      const app = upsert(map, provider);
      markSource(app, 'connection');
      const conn: AppConnection = {
        id: Number(raw.id ?? 0),
        name: String(raw.name ?? ''),
      };
      if (typeof raw.authorization_status === 'string') conn.status = raw.authorization_status;
      (app.connections ??= []).push(conn);
    }
  }

  const used = isRecord(sources.usedAdapters) ? sources.usedAdapters.result : undefined;
  if (Array.isArray(used)) {
    for (const name of used) {
      if (typeof name !== 'string' || name.length === 0) continue;
      markSource(upsert(map, name), 'recipes');
    }
  }

  if (Array.isArray(sources.catalogue)) {
    for (const raw of sources.catalogue) {
      if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.length === 0) continue;
      const app = upsert(map, raw.name);
      const isTool = raw.categories?.some((c) => WORKATO_TOOL_CATEGORIES.has(c)) ?? false;
      markSource(app, isTool ? 'builtin' : 'standard');
      applyCatalogueEntry(app, raw);
    }
  }

  const custom = isRecord(sources.custom) ? sources.custom.result : undefined;
  if (Array.isArray(custom)) {
    for (const raw of custom) {
      if (!isRecord(raw)) continue;
      const name = typeof raw.name === 'string' ? raw.name : '';
      if (!name) continue;
      const app = upsert(map, name);
      markSource(app, 'custom');
      applyAdapterConfig(app, raw.config);
    }
  }

  const certified = isRecord(sources.certified) ? sources.certified.result : undefined;
  if (Array.isArray(certified)) {
    for (const raw of certified) {
      if (!isRecord(raw)) continue;
      const name = typeof raw.name === 'string' ? raw.name : '';
      if (!name) continue;
      const app = upsert(map, name);
      markSource(app, 'certified');
      applyAdapterConfig(app, raw.config);
    }
  }

  const rank = (app: AppEntry): number => {
    if (app.source.includes('connection')) return 0;
    if (app.source.includes('recipes')) return 1;
    if (app.source.includes('builtin')) return 2;
    if (app.source.includes('custom')) return 3;
    if (app.source.includes('standard')) return 4;
    return 5;
  };
  return [...map.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export interface CatalogueSummary {
  standard: number;
  builtin: number;
  certified: number;
  deprecated_hidden: number;
  /** Category -> number of visible catalogue apps in it, largest first. */
  categories: Record<string, number>;
}

/**
 * The bare-call view: what this workspace has, plus the catalogue by the
 * numbers. 338 rows nobody asked for is not an answer; the categories are the
 * index a caller narrows with.
 */
export function summariseApps(
  all: AppEntry[],
  includeDeprecated: boolean,
): {
  connected: AppEntry[];
  custom: AppEntry[];
  used_in_recipes: string[];
  catalogue: CatalogueSummary;
} {
  const connected = all.filter((a) => a.source.includes('connection'));
  const custom = all.filter((a) => a.source.includes('custom') && !a.source.includes('connection'));
  const used = all.filter((a) => a.source.includes('recipes')).map((a) => a.name);

  const counts: Record<string, number> = {};
  let standard = 0;
  let builtin = 0;
  let certified = 0;
  let hidden = 0;
  for (const app of all) {
    const visible = isVisibleApp(app, includeDeprecated);
    if (!visible) {
      hidden++;
      continue;
    }
    if (app.source.includes('standard')) standard++;
    if (app.source.includes('builtin')) builtin++;
    if (app.source.includes('certified')) certified++;
    for (const c of app.categories ?? []) counts[c] = (counts[c] ?? 0) + 1;
  }
  const categories: Record<string, number> = {};
  for (const [name, n] of Object.entries(counts).sort(
    (x, y) => y[1] - x[1] || x[0].localeCompare(y[0]),
  )) {
    categories[name] = n;
  }
  return {
    connected,
    custom,
    used_in_recipes: used,
    catalogue: { standard, builtin, certified, deprecated_hidden: hidden, categories },
  };
}

/** Pages of connections to walk. 20 per page, so this covers 200 connections. */
const CONNECTION_PAGES = 10;

/**
 * Service-worker cache of the reduced catalogue, keyed by the deployment hash.
 * The in-page function is told the hash we hold and skips the 320 KB fetch
 * when the page still names it, so a rename or a new connector shows up on the
 * next Workato deploy and never later.
 */
let catalogueCache: { hash: string; entries: CatalogueEntry[]; fetchedAt: number } | null = null;

/** Exposed for tests. */
export function resetCatalogueCache(): void {
  catalogueCache = null;
}

class WorkatoAppsListTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.APPS_LIST;

  async execute(args: AppsListArgs): Promise<ToolResult> {
    try {
      if (args?.query != null && typeof args.query !== 'string') {
        return createErrorResponse('Param [query] must be a string');
      }
      if (args?.category != null && typeof args.category !== 'string') {
        return createErrorResponse('Param [category] must be a string');
      }
      const query = args?.query?.trim() ?? '';
      const category = args?.category?.trim() ?? '';
      const onlyConnected = args?.only_connected === true;
      const includeDeprecated = args?.include_deprecated === true;
      const narrowed = query.length > 0 || category.length > 0 || onlyConnected;
      // The certified catalogue is ~70 KB raw. Free to include once a query
      // narrows it; opt-in otherwise, so a bare call stays small.
      const includeCertified = args?.include_certified ?? (query.length > 0 || category.length > 0);
      const limit = Math.min(Math.max(args?.limit ?? (narrowed ? 50 : 200), 1), 1000);
      const timeoutMs = Math.min(Math.max(args?.timeout_ms ?? 30_000, 10_000), 110_000);

      const tab = await findWorkatoTab(args?.tabId);
      const raw = await runInWorkatoTab(
        tab.tabId,
        fetchAppSourcesInPage,
        [includeCertified, CONNECTION_PAGES, catalogueCache?.hash ?? null],
        { timeoutMs },
      );

      // Connections are the load-bearing source; the rest are enrichment.
      if (!raw.connections.ok) {
        return createErrorResponse(
          `workato_apps_list: could not read connections. ${raw.connections.message}`,
        );
      }

      let catalogue: CatalogueEntry[] | undefined;
      let catalogueHash: string | undefined;
      if (raw.catalogue.ok && raw.catalogue.unchanged && catalogueCache) {
        catalogue = catalogueCache.entries;
        catalogueHash = catalogueCache.hash;
      } else if (raw.catalogue.ok && Array.isArray(raw.catalogue.entries) && raw.catalogue.hash) {
        catalogueCache = {
          hash: raw.catalogue.hash,
          entries: raw.catalogue.entries,
          fetchedAt: Date.now(),
        };
        catalogue = raw.catalogue.entries;
        catalogueHash = raw.catalogue.hash;
      }

      const all = mergeAppSources({
        connections: raw.connections.body,
        usedAdapters: raw.usedAdapters.ok ? raw.usedAdapters.body : undefined,
        catalogue,
        custom: raw.custom.ok ? raw.custom.body : undefined,
        certified: raw.certified.ok ? raw.certified.body : undefined,
      });

      const degraded = (
        [
          ['catalogue', raw.catalogue],
          ['used_in_recipes', raw.usedAdapters],
          ['custom_connectors', raw.custom],
          ['certified_catalogue', raw.certified],
        ] as const
      )
        .filter(([, res]) => !res.ok)
        .map(([label, res]) => `${label}: ${res.message}`);

      const catalogueNote = catalogue
        ? `The catalogue is complete: ${catalogue.length} standard connectors from Workato's own ` +
          `app config${includeCertified ? ' plus the certified community catalogue' : ''}. An app ` +
          'absent from it is not available as a connector here; the honest options are the HTTP ' +
          'connector `rest` or an SDK connector, and the user should be told that rather than ' +
          'handed a guessed name. workato_adapter_meta accepts an array and reports misses under ' +
          'not_found when a name still needs confirming.'
        : 'The standard-connector catalogue could not be read this call (see sources_unavailable), ' +
          'so only apps this workspace connected, built with or published are listed. Pass ' +
          'guessed names to workato_adapter_meta, which reports misses under not_found.';

      const payload: Record<string, unknown> = {};

      if (!narrowed) {
        const summary = summariseApps(all, includeDeprecated);
        payload.summary = true;
        payload.connected = summary.connected;
        payload.custom = summary.custom;
        payload.used_in_recipes = summary.used_in_recipes;
        payload.catalogue = summary.catalogue;
        payload.hint =
          'This is the summary. Pass query (name, title, alias or category substring, e.g. ' +
          '"sheet", "python", "CRM") or category (exact, e.g. "Database") for the matching ' +
          'apps, include_deprecated:true to see retired connectors, only_connected:true for ' +
          'the connected ones as a plain list.';
      } else {
        let matched = all.filter((a) => isVisibleApp(a, includeDeprecated));
        if (query.length > 0) matched = matched.filter(buildAppMatcher(query));
        if (category.length > 0) matched = matched.filter(buildCategoryMatcher(category));
        if (onlyConnected) matched = matched.filter((a) => a.source.includes('connection'));
        const apps = matched.slice(0, limit);
        payload.count = apps.length;
        payload.total_matched = matched.length;
        payload.apps = apps;
        if (matched.length > apps.length) payload.truncated = matched.length - apps.length;
        if (matched.length === 0) {
          const hiddenDeprecated = all.filter(
            (a) =>
              !isVisibleApp(a, includeDeprecated) &&
              (query.length === 0 || buildAppMatcher(query)(a)) &&
              (category.length === 0 || buildCategoryMatcher(category)(a)),
          ).length;
          payload.no_match_hint =
            (hiddenDeprecated > 0
              ? `${hiddenDeprecated} deprecated connector(s) matched but are hidden; pass ` +
                'include_deprecated:true to see them. '
              : '') +
            'Try a shorter query or a category name; the bare call lists every category with counts.';
        }
      }

      payload.certified_included = includeCertified;
      if (catalogueHash) payload.catalogue_version = catalogueHash.slice(0, 12);
      payload.note = catalogueNote;
      payload.connection_note =
        'NO CONNECTION MEANS STOP AND ASK THE USER: these tools cannot create one. An app with ' +
        'connection_required true and no connections entry (or one whose status is not ' +
        '"success") is a blocker to raise before writing the step. "success" alone does not ' +
        'prove the connection works; workato_step_schema with an empty input is the cheap probe.';
      if (degraded.length > 0) payload.sources_unavailable = degraded;

      return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_apps_list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoAppsListTool = new WorkatoAppsListTool();
