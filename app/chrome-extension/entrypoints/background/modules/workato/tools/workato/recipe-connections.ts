import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { stripConnectionSecrets } from './strip-secrets';

/**
 * workato_recipe_connections: which connections a recipe is bound to, and
 * whether they can actually authenticate.
 *
 * Workato has no per-recipe connection endpoint. The bindings live in the
 * recipe's `config` array (one entry per provider, `account_id` present only
 * when the connector needs a connection), and health lives on the connection
 * itself. So this tool reads:
 *
 *   GET /recipes/<id>.json                -> flow.config (string or array)
 *   GET /recipes/<id>/code.json           -> which providers steps actually use
 *   GET /connections/<account_id>.json    -> per bound connection
 *   GET /integrations/meta?name=a,b       -> config.required for the rest
 *
 * The code read is what keeps a stale entry from blocking a caller. Removing
 * the last step of a provider leaves its `config` entry behind with no
 * account_id, and reporting that as 'missing' blocked restarts over a
 * connection the recipe no longer needs. Such an entry is reported 'unused'.
 *
 * Everything the connection returns passes through stripConnectionSecrets and
 * then a field whitelist, so no credential material and none of the provider
 * input bag can reach the response.
 */

interface RecipeConnectionsArgs {
  recipe_id: number;
  tabId?: number;
  windowId?: number;
}

/** One `config` entry of a recipe, as Workato stores it. */
export interface RecipeConfigEntry {
  provider: string;
  name: string;
  account_id: number | null;
  skip_validation?: boolean;
}

export interface RecipeConnectionsRaw {
  ok: boolean;
  recipe?: {
    recipe_id: number;
    name: string;
    state: string;
    running: boolean;
    version_no: number;
  };
  entries?: RecipeConfigEntry[];
  /** Raw /connections/<id>.json result objects keyed by connection id (secrets stripped later). */
  connections?: Record<string, unknown>;
  /** Per connection id, why the read failed. */
  connection_errors?: Record<string, string>;
  /** Per provider, `config.required` from /integrations/meta; null when meta did not say. */
  meta_required?: Record<string, boolean | null>;
  meta_error?: string;
  config_parse_error?: string;
  /** Distinct `provider` values found on the recipe's steps. Absent when the code could not be read. */
  step_providers?: string[];
  /** Why the code could not be read, so 'unused' is never inferred from a failed fetch. */
  code_error?: string;
  failure?: {
    stage: 'fetch' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * Runs in the Workato tab's MAIN world. Plain function, .then() chains, every
 * helper declared inside, JSON-serializable args only. async/await here is
 * rewritten by the bundler into a hoisted helper that does not survive
 * Function.prototype.toString (see pull-recipe.ts).
 */
export function fetchRecipeConnectionsInPage(recipeId: number): Promise<RecipeConnectionsRaw> {
  const fetchOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };

  function getJson(url: string): Promise<{ status: number; bodyText: string; json: unknown }> {
    return fetch(url, fetchOpts).then((r) =>
      r.text().then((bodyText) => {
        let json: unknown = null;
        try {
          json = JSON.parse(bodyText);
        } catch {
          /* keep the raw body for diagnostics */
        }
        return { status: r.status, bodyText, json };
      }),
    );
  }

  /**
   * Every distinct `provider` a STEP carries. `config` entries carry a provider
   * too, under keyword "application": those are the bindings being checked, so
   * counting one as usage would make every entry look used.
   */
  function collectProviders(node: unknown, out: string[]): void {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) collectProviders(node[i], out);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    const keyword = typeof rec.keyword === 'string' ? rec.keyword : null;
    if (typeof rec.provider === 'string' && rec.provider !== '' && keyword !== 'application') {
      if (out.indexOf(rec.provider) === -1) out.push(rec.provider);
    }
    const keys = Object.keys(rec);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (key === 'input' || key === 'extended_input_schema') continue;
      if (key === 'extended_output_schema') continue;
      const child = rec[key];
      if (child && typeof child === 'object') collectProviders(child, out);
    }
  }

  function readStepProviders(): Promise<{ providers?: string[]; error?: string }> {
    const url = `/recipes/${recipeId}/code.json?mode=view`;
    return getJson(url).then(
      (res) => {
        if (res.status < 200 || res.status >= 300) {
          return { error: `GET ${url} returned HTTP ${res.status}` };
        }
        const result = res.json && (res.json as any).result;
        let tree: unknown = result;
        if (typeof result === 'string') {
          try {
            tree = JSON.parse(result);
          } catch (e) {
            return {
              error: `GET ${url}: JSON.parse of result failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            };
          }
        }
        if (!tree || typeof tree !== 'object') {
          return { error: `GET ${url}: unexpected shape, missing result` };
        }
        const providers: string[] = [];
        collectProviders(tree, providers);
        return { providers: providers };
      },
      (e) => ({ error: `GET ${url} failed: ${e instanceof Error ? e.message : String(e)}` }),
    );
  }

  function adapterNode(meta: unknown, name: string): Record<string, unknown> | null {
    const roots: unknown[] = [meta];
    if (meta && typeof meta === 'object') {
      const m = meta as Record<string, unknown>;
      if (m.result !== undefined) roots.push(m.result);
      if (m.adapters !== undefined) roots.push(m.adapters);
    }
    for (let i = 0; i < roots.length; i += 1) {
      const root = roots[i];
      if (!root || typeof root !== 'object') continue;
      const node = (root as Record<string, unknown>)[name];
      if (node && typeof node === 'object') return node as Record<string, unknown>;
    }
    return null;
  }

  return getJson(`/recipes/${recipeId}.json`).then((meta) => {
    if (meta.status < 200 || meta.status >= 300) {
      return {
        ok: false,
        failure: {
          stage: 'fetch' as const,
          status: meta.status,
          body_excerpt: meta.bodyText.slice(0, 512),
          message: `GET /recipes/${recipeId}.json returned HTTP ${meta.status}`,
        },
      };
    }
    const recipeData = (meta.json as any)?.result?.recipe_data;
    const flow = recipeData?.flow;
    if (!flow || typeof flow !== 'object') {
      return {
        ok: false,
        failure: {
          stage: 'shape' as const,
          body_excerpt: JSON.stringify(meta.json).slice(0, 512),
          message: 'Unexpected response shape - missing result.recipe_data.flow.',
        },
      };
    }

    const recipe = {
      recipe_id: recipeId,
      name: String(flow.name ?? ''),
      state: String(recipeData?.state ?? flow.state ?? 'unknown'),
      running: Boolean(recipeData?.running ?? flow.running),
      version_no: Number(flow.version_no ?? 0),
    };

    // config is a JSON string on this endpoint and an array on some others.
    let configParseError: string | undefined;
    let configArray: unknown[] = [];
    const rawConfig = flow.config;
    if (typeof rawConfig === 'string') {
      try {
        const parsed = JSON.parse(rawConfig);
        if (Array.isArray(parsed)) configArray = parsed;
        else configParseError = 'flow.config parsed to a non-array value';
      } catch (e) {
        configParseError = `flow.config JSON.parse failed: ${
          e instanceof Error ? e.message : String(e)
        }`;
      }
    } else if (Array.isArray(rawConfig)) {
      configArray = rawConfig;
    } else if (rawConfig != null) {
      configParseError = 'flow.config is neither a JSON string nor an array';
    }

    const entries: RecipeConfigEntry[] = [];
    for (let i = 0; i < configArray.length; i += 1) {
      const raw = configArray[i];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const provider = String(item.provider ?? item.name ?? '');
      if (provider === '') continue;
      const accountId =
        typeof item.account_id === 'number' && isFinite(item.account_id) ? item.account_id : null;
      const entry: RecipeConfigEntry = {
        provider,
        name: String(item.name ?? provider),
        account_id: accountId,
      };
      if (typeof item.skip_validation === 'boolean') entry.skip_validation = item.skip_validation;
      entries.push(entry);
    }

    const accountIds: number[] = [];
    const providersWithoutAccount: string[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      if (e.account_id !== null) {
        if (accountIds.indexOf(e.account_id) === -1) accountIds.push(e.account_id);
      } else if (providersWithoutAccount.indexOf(e.provider) === -1) {
        providersWithoutAccount.push(e.provider);
      }
    }

    const connections: Record<string, unknown> = {};
    const connectionErrors: Record<string, string> = {};
    const metaRequired: Record<string, boolean | null> = {};
    let metaError: string | undefined;

    const connectionReads = accountIds.map((id) =>
      getJson(`/connections/${id}.json`).then((res) => {
        if (res.status < 200 || res.status >= 300) {
          connectionErrors[String(id)] =
            `GET /connections/${id}.json returned HTTP ${res.status}` +
            (res.status === 404 ? ' (connection not found in this workspace/environment)' : '');
          return;
        }
        const result = (res.json as any)?.result;
        if (!result || typeof result !== 'object') {
          connectionErrors[String(id)] =
            `GET /connections/${id}.json returned an unexpected shape (missing result object)`;
          return;
        }
        connections[String(id)] = result;
      }),
    );

    const metaRead =
      providersWithoutAccount.length === 0
        ? Promise.resolve()
        : getJson(
            `/integrations/meta?name=${encodeURIComponent(
              providersWithoutAccount.join(','),
            )}&cacheKey=x`,
          ).then((res) => {
            if (res.status < 200 || res.status >= 300) {
              metaError = `GET /integrations/meta returned HTTP ${res.status}`;
              for (let i = 0; i < providersWithoutAccount.length; i += 1) {
                metaRequired[providersWithoutAccount[i]] = null;
              }
              return;
            }
            for (let i = 0; i < providersWithoutAccount.length; i += 1) {
              const name = providersWithoutAccount[i];
              const node = adapterNode(res.json, name);
              const config = node && node.config;
              const required =
                config && typeof config === 'object'
                  ? (config as Record<string, unknown>).required
                  : undefined;
              metaRequired[name] = typeof required === 'boolean' ? required : null;
            }
          });

    let stepProviders: string[] | undefined;
    let codeError: string | undefined;
    const codeRead = readStepProviders().then((res) => {
      stepProviders = res.providers;
      codeError = res.error;
    });

    return Promise.all(connectionReads.concat([metaRead, codeRead])).then(() => {
      const out: RecipeConnectionsRaw = {
        ok: true,
        recipe,
        entries,
        connections,
        connection_errors: connectionErrors,
        meta_required: metaRequired,
      };
      if (metaError !== undefined) out.meta_error = metaError;
      if (configParseError !== undefined) out.config_parse_error = configParseError;
      if (stepProviders !== undefined) out.step_providers = stepProviders;
      if (codeError !== undefined) out.code_error = codeError;
      return out;
    });
  });
}

// ---------------------------------------------------------------------------
// Pure projection. No I/O, no Chrome APIs, unit-tested with fixtures.
// ---------------------------------------------------------------------------

export type ConnectionHealthStatus =
  | 'ok'
  | 'lost'
  | 'missing'
  | 'not_required'
  | 'unused'
  | 'unknown';

export interface RecipeConnectionHealth {
  provider: string;
  name: string;
  connection_id: number | null;
  connection_name?: string;
  authorization_status?: string;
  authorized_at?: string | null;
  connection_lost_at?: string | null;
  connection_lost_reason?: string | null;
  authorization_error?: string | null;
  warning?: string | null;
  running_recipe_count?: number;
  status: ConnectionHealthStatus;
  /** Why the connection could not be read, when status is 'missing' or 'unknown'. */
  error?: string;
}

export interface BlockingConnection {
  provider: string;
  connection_id: number | null;
  status: ConnectionHealthStatus;
  reason: string;
}

export interface RecipeConnectionsPayload {
  recipe_id: number;
  name: string;
  state: string;
  running: boolean;
  version_no: number;
  connections: RecipeConnectionHealth[];
  healthy: boolean;
  blocking: BlockingConnection[];
  actions: string[];
  /** Set when flow.config could not be read as an array of bindings. */
  config_parse_error?: string;
  /** Set when /integrations/meta could not be read, so connection_required is unknown. */
  meta_error?: string;
  /** Set when the recipe code could not be read, so an unused binding cannot be told apart. */
  code_error?: string;
}

/** Compact form for attaching to another tool's payload. */
export interface RecipeConnectionsSummary {
  healthy: boolean;
  connections: Array<{
    provider: string;
    connection_id: number | null;
    connection_name?: string;
    status: ConnectionHealthStatus;
  }>;
  blocking: BlockingConnection[];
  actions: string[];
}

const HEALTH_KEYS = [
  'authorization_status',
  'authorized_at',
  'connection_lost_at',
  'connection_lost_reason',
  'authorization_error',
  'warning',
  'running_recipe_count',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function describe(entry: RecipeConnectionHealth): string {
  const named = entry.connection_name ? ` "${entry.connection_name}"` : '';
  return entry.connection_id !== null
    ? `connection ${entry.connection_id}${named} (provider ${entry.provider})`
    : `provider ${entry.provider}`;
}

/**
 * Project the in-page read into per-connection health plus a recipe verdict.
 *
 * Secrets are stripped BEFORE the whitelist, so a credential cannot reach the
 * response even if Workato adds a new health-looking key. The provider input
 * bag is never copied: it is settings, not health.
 */
export function projectRecipeConnections(raw: RecipeConnectionsRaw): RecipeConnectionsPayload {
  const entries = raw.entries ?? [];
  const connections = raw.connections ?? {};
  const connectionErrors = raw.connection_errors ?? {};
  const metaRequired = raw.meta_required ?? {};
  // Absent (code unreadable) means "cannot tell", which must not become "unused".
  const stepProviders = raw.step_providers;

  const projected: RecipeConnectionHealth[] = entries.map((entry) => {
    const health: RecipeConnectionHealth = {
      provider: entry.provider,
      name: entry.name,
      connection_id: entry.account_id,
      status: 'unknown',
    };

    if (entry.account_id === null) {
      const required = metaRequired[entry.provider];
      if (required === false) {
        health.status = 'not_required';
      } else if (required === true) {
        health.status = 'missing';
      } else {
        health.status = 'unknown';
        health.error =
          raw.meta_error ??
          `connection_required is not published for adapter ${entry.provider}, so whether this ` +
            'step needs a connection could not be determined';
      }
      return health;
    }

    const rawConnection = connections[String(entry.account_id)];
    if (!isRecord(rawConnection)) {
      health.status = 'missing';
      health.error =
        connectionErrors[String(entry.account_id)] ??
        `connection ${entry.account_id} could not be read`;
      return health;
    }

    const stripped = stripConnectionSecrets(rawConnection);
    const safe = isRecord(stripped) ? stripped : {};
    if (typeof safe.name === 'string') health.connection_name = safe.name;
    const target = health as unknown as Record<string, unknown>;
    for (const key of HEALTH_KEYS) {
      // Copy only when present: an absent field is unknown, not null.
      if (key in safe) target[key] = safe[key];
    }

    const status = typeof safe.authorization_status === 'string' ? safe.authorization_status : '';
    const lostAt = safe.connection_lost_at;
    if (status === 'success' && (lostAt === null || lostAt === undefined)) {
      health.status = 'ok';
    } else if (status === '' && lostAt == null) {
      health.status = 'unknown';
      health.error = `connection ${entry.account_id} did not report authorization_status`;
    } else {
      health.status = 'lost';
    }
    return health;
  });

  // A binding no step uses cannot stop this recipe from running, whatever
  // shape it is in. Typically left behind when the last step of a provider was
  // removed and its config entry was not, which used to read as 'missing' and
  // blocked a caller restart over a connection the recipe no longer needs. The
  // health fields already read are kept: 'unused' explains the entry, it does
  // not hide what is known about it.
  if (stepProviders !== undefined) {
    for (const entry of projected) {
      if (stepProviders.includes(entry.provider)) continue;
      entry.status = 'unused';
      entry.error =
        `no step in this recipe uses provider ${entry.provider}, so this config entry is left ` +
        'over and does not block a start';
    }
  }

  const blocking: BlockingConnection[] = [];
  const actions: string[] = [];

  for (const entry of projected) {
    if (entry.status === 'ok' || entry.status === 'not_required' || entry.status === 'unused') {
      continue;
    }

    if (entry.status === 'lost') {
      const why =
        entry.authorization_error ||
        entry.connection_lost_reason ||
        entry.authorization_status ||
        'not authorized';
      blocking.push({
        provider: entry.provider,
        connection_id: entry.connection_id,
        status: entry.status,
        reason: String(why),
      });
      actions.push(
        `Re-authorize ${describe(entry)}: ${why}` +
          (entry.connection_lost_at ? ` (lost at ${entry.connection_lost_at})` : '') +
          '. Ask the user to re-authorize this connection; do not ask for a new one.',
      );
      continue;
    }

    if (entry.status === 'missing' && entry.connection_id !== null) {
      blocking.push({
        provider: entry.provider,
        connection_id: entry.connection_id,
        status: entry.status,
        reason: entry.error ?? 'connection could not be read',
      });
      actions.push(
        `The recipe binds provider ${entry.provider} to connection ${entry.connection_id}, which ` +
          `could not be read (${entry.error ?? 'unknown reason'}). Confirm the connection still ` +
          'exists in this workspace and environment before starting the recipe.',
      );
      continue;
    }

    if (entry.status === 'missing') {
      blocking.push({
        provider: entry.provider,
        connection_id: null,
        status: entry.status,
        reason: `adapter ${entry.provider} requires a connection and the recipe config has no account_id`,
      });
      actions.push(
        `Provider ${entry.provider} needs a connection and the recipe config carries no ` +
          'account_id. These tools cannot create a connection: ask the user to create one at ' +
          `app.workato.com/connections/new (adapter ${entry.provider}) and tell you its name.`,
      );
      continue;
    }

    blocking.push({
      provider: entry.provider,
      connection_id: entry.connection_id,
      status: entry.status,
      reason: entry.error ?? 'status could not be determined',
    });
    actions.push(
      `Could not determine the health of ${describe(entry)}: ${
        entry.error ?? 'status could not be determined'
      }. Check it in the workspace before starting the recipe.`,
    );
  }

  const payload: RecipeConnectionsPayload = {
    recipe_id: raw.recipe?.recipe_id ?? 0,
    name: raw.recipe?.name ?? '',
    state: raw.recipe?.state ?? 'unknown',
    running: raw.recipe?.running ?? false,
    version_no: raw.recipe?.version_no ?? 0,
    connections: projected,
    healthy: blocking.length === 0,
    blocking,
    actions,
  };
  if (raw.config_parse_error !== undefined) payload.config_parse_error = raw.config_parse_error;
  if (raw.meta_error !== undefined) payload.meta_error = raw.meta_error;
  if (raw.code_error !== undefined) payload.code_error = raw.code_error;
  return payload;
}

/** Compact projection for attaching to a lifecycle or status payload. */
export function summarizeRecipeConnections(
  payload: RecipeConnectionsPayload,
): RecipeConnectionsSummary {
  return {
    healthy: payload.healthy,
    connections: payload.connections.map((c) => {
      const item: RecipeConnectionsSummary['connections'][number] = {
        provider: c.provider,
        connection_id: c.connection_id,
        status: c.status,
      };
      if (c.connection_name !== undefined) item.connection_name = c.connection_name;
      return item;
    }),
    blocking: payload.blocking,
    actions: payload.actions,
  };
}

/** Read and project a recipe's connection health. Throws WorkatoDispatchError on transport failure. */
export async function fetchRecipeConnections(
  tabId: number,
  recipeId: number,
): Promise<RecipeConnectionsPayload> {
  const raw = await runInWorkatoTab(tabId, fetchRecipeConnectionsInPage, [recipeId], {
    timeoutMs: 30_000,
  });
  if (!raw.ok) {
    throw new WorkatoDispatchError(
      'UnexpectedShape',
      `recipe connections fetch failed (${raw.failure?.stage}): ${raw.failure?.message ?? 'unknown'}`,
    );
  }
  return projectRecipeConnections(raw);
}

class WorkatoRecipeConnectionsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.RECIPE_CONNECTIONS;

  async execute(args: RecipeConnectionsArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }

      const tab = await findWorkatoTab(args.tabId, { windowId: args.windowId });
      const raw = await runInWorkatoTab(tab.tabId, fetchRecipeConnectionsInPage, [args.recipe_id], {
        timeoutMs: 30_000,
      });

      if (!raw.ok) {
        return createErrorResponse(
          `WorkatoApiError (${raw.failure?.stage}): ${raw.failure?.message}` +
            (raw.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${raw.failure.body_excerpt}`
              : ''),
        );
      }

      const payload = projectRecipeConnections(raw);
      const unusedCount = payload.connections.filter((c) => c.status === 'unused').length;
      const unusedNote =
        unusedCount > 0 ? `, ${unusedCount} unused (no step uses them, not blocking)` : '';
      const headline = payload.healthy
        ? `recipe ${payload.recipe_id} connections: all ${payload.connections.length} binding(s) usable${unusedNote}`
        : `recipe ${payload.recipe_id} connections: ${payload.blocking.length} of ` +
          `${payload.connections.length} binding(s) block a start${unusedNote}`;

      return {
        content: [
          {
            type: 'text',
            text:
              headline +
              (payload.actions.length > 0 ? `\n${payload.actions.join('\n')}` : '') +
              `\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_recipe_connections failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoRecipeConnectionsTool = new WorkatoRecipeConnectionsTool();
