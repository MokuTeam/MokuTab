import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import {
  findWorkatoTab,
  runInWorkatoTab,
  workatoNotFoundHint,
  WorkatoDispatchError,
  type WorkatoTabInfo,
} from './tab-dispatch';
import { loadRecipeSnapshot } from './pull-recipe';

/**
 * workato_test_recipe: the supported "Test recipe" path, with trigger input.
 *
 * Captured from the recipe editor (2026-09-07):
 *   PUT /recipes/<id>/test.json
 *     recipe_function trigger: {"trigger_event":{"parameters":{...},
 *       "context":{"calling_job_id":"0","calling_recipe_id":"0"}},"error_format":"json"}
 *     clock / webhook / pub_sub: {"error_format":"json"}
 *     -> {"success":true,"flow":{"id","last_run_at","stopped_at","running","testing":true}}
 *   The response carries NO job id (the editor learns it over a WebSocket), so the
 *   job is found by polling GET /web_api/recipes/<id>/jobs.json?test_jobs_only=true.
 *   GET /recipes/<id>/status.json  -> flow.testing flips false when the test ends.
 *   PUT /recipes/<id>/stop_test.json -> {"result":true} (waiting webhook/pub_sub tests).
 *
 * The recipe is never started: it stays stopped with stop_reason test_run_stop.
 */

export type TestRecipeAction = 'run' | 'stop' | 'status';
export type TestMode = 'input' | 'immediate' | 'waiting' | 'unsupported';

/** Trigger providers whose test waits for a real inbound event instead of running now. */
const WAITING_TRIGGER_PROVIDERS = ['workato_webhooks', 'workato_pub_sub'];
/** Trigger providers whose test runs immediately and accepts no trigger data. */
const IMMEDIATE_TRIGGER_PROVIDERS = ['clock'];
/** The only trigger that accepts injected input. */
const INPUT_TRIGGER_PROVIDER = 'workato_recipe_function';

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MIN_WAIT_TIMEOUT_MS = 2_000;
const MAX_WAIT_TIMEOUT_MS = 110_000;
const DISPATCH_BUFFER_MS = 8_000;
const MAX_DISPATCH_MS = 115_000;
const CONTEXT_TIMEOUT_MS = 45_000;
const SHORT_TIMEOUT_MS = 20_000;
const TRACE_HINT = 'workato_job_trace(recipe_id, job_id)';

export interface TriggerParameter {
  name: string;
  required: boolean;
  type?: string;
}

export interface TestModeDecision {
  mode: TestMode;
  provider: string;
  trigger_name: string;
  /** null when the trigger declares no parameter schema at all (validation is then skipped). */
  parameters: TriggerParameter[] | null;
  /** Why the trigger is unsupported. Only set for mode 'unsupported'. */
  reason?: string;
}

export interface TriggerInputProblems {
  unknown_keys: string[];
  missing_required: string[];
}

export interface WriteGateAssessment {
  /** Providers bound to a connection in version.config (config entry carries account_id). */
  connection_backed: string[];
  /** Step providers with no config entry at all: treated as connection-backed. */
  unbound_step_providers: string[];
  /**
   * Providers a step uses whose config entry exists but carries no account_id,
   * and which are not connectionless. Workato refuses the run itself; this
   * refuses it before the HTTP call and says which connection is missing.
   */
  unbound_providers: string[];
  requires_allow_writes: boolean;
}

interface TestJobSlim {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  error?: string;
}

interface TestFlowSlim {
  state?: string;
  running?: boolean;
  testing?: boolean;
  stop_reason?: string | null;
  last_run_at?: string | null;
}

interface InPageFailure {
  stage: 'csrf' | 'meta' | 'code' | 'prescan' | 'test' | 'status' | 'stop' | 'shape' | 'workato';
  status?: number;
  body_excerpt?: string;
  message: string;
  details?: unknown;
}

interface RunInPageResult {
  ok: boolean;
  flow?: TestFlowSlim;
  job?: TestJobSlim | null;
  polls?: number;
  waited_ms?: number;
  timed_out?: boolean;
  failure?: InPageFailure;
}

interface StatusInPageResult {
  ok: boolean;
  flow?: TestFlowSlim;
  latest_test_job?: TestJobSlim | null;
  failure?: InPageFailure;
}

interface StopInPageResult {
  ok: boolean;
  result?: unknown;
  failure?: InPageFailure;
}

interface TestRecipeArgs {
  recipe_id: number;
  action?: TestRecipeAction;
  trigger_input?: Record<string, unknown>;
  allow_writes?: boolean;
  wait?: boolean;
  wait_timeout_ms?: number;
  tabId?: number;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (background only, unit tested)                                 */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function shapeParameter(entry: unknown): TriggerParameter | null {
  const rec = asRecord(entry);
  if (!rec) return null;
  const name = typeof rec.name === 'string' ? rec.name : '';
  if (name === '') return null;
  return {
    name,
    // Workato writes optional:false for a required field; an absent flag is
    // treated as optional so the gate never refuses a legitimate call.
    required: rec.optional === false,
    type: typeof rec.type === 'string' ? rec.type : undefined,
  };
}

function shapeParameters(list: unknown): TriggerParameter[] | null {
  if (!Array.isArray(list)) return null;
  const out: TriggerParameter[] = [];
  for (const entry of list) {
    const param = shapeParameter(entry);
    if (param) out.push(param);
  }
  return out;
}

/**
 * Declared trigger parameters, from `input.parameters_schema_json` (a JSON
 * STRING) or, failing that, from the `parameters` wrapper the editor writes
 * into the trigger's extended_output_schema.
 */
export function readTriggerParameters(trigger: unknown): TriggerParameter[] | null {
  const node = asRecord(trigger);
  if (!node) return null;

  const input = asRecord(node.input);
  const raw = input ? input.parameters_schema_json : undefined;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = shapeParameters(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      /* malformed schema string: fall through to the extended schema */
    }
  } else if (Array.isArray(raw)) {
    const parsed = shapeParameters(raw);
    if (parsed) return parsed;
  }

  const extended = node.extended_output_schema;
  if (Array.isArray(extended)) {
    for (const entry of extended) {
      const rec = asRecord(entry);
      if (rec && rec.name === 'parameters') {
        const parsed = shapeParameters(rec.properties);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

/** Decide which test mode the recipe's trigger supports. The code tree root IS the trigger node. */
export function detectTestMode(code: unknown): TestModeDecision {
  const node = asRecord(code);
  const provider = node && typeof node.provider === 'string' ? node.provider : '';
  const triggerName = node && typeof node.name === 'string' ? node.name : '';
  const base = { provider, trigger_name: triggerName };

  if (!node) {
    return {
      ...base,
      mode: 'unsupported',
      parameters: null,
      reason: 'the recipe code tree could not be read as a trigger node',
    };
  }
  if (provider === INPUT_TRIGGER_PROVIDER) {
    return { ...base, mode: 'input', parameters: readTriggerParameters(node) };
  }
  if (IMMEDIATE_TRIGGER_PROVIDERS.indexOf(provider) !== -1) {
    return { ...base, mode: 'immediate', parameters: null };
  }
  if (WAITING_TRIGGER_PROVIDERS.indexOf(provider) !== -1) {
    return { ...base, mode: 'waiting', parameters: null };
  }
  return {
    ...base,
    mode: 'unsupported',
    parameters: null,
    reason:
      `trigger ${provider || '(none)'}/${triggerName || '(none)'} has no Test path that accepts ` +
      'injected input; Workato only offers Test with input for a workato_recipe_function trigger',
  };
}

/** Compare supplied trigger input against the declared parameters. Preserves 0 and false. */
export function validateTriggerInput(
  input: Record<string, unknown> | undefined,
  parameters: TriggerParameter[],
): TriggerInputProblems {
  const provided = asRecord(input) ?? {};
  const declared = parameters.map((p) => p.name);
  const unknown_keys = Object.keys(provided).filter((key) => declared.indexOf(key) === -1);
  const missing_required = parameters
    .filter((p) => p.required && provided[p.name] === undefined)
    .map((p) => p.name);
  return { unknown_keys, missing_required };
}

/** version.config is a JSON string of application entries; tolerate an already-parsed array. */
export function parseRecipeConfig(configRaw: unknown): Record<string, unknown>[] {
  let value = configRaw;
  if (typeof value === 'string') {
    if (value.trim() === '') return [];
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    if (rec) out.push(rec);
  }
  return out;
}

/** Every distinct `provider` used by a node in the code tree (control-flow nodes carry none). */
export function collectStepProviders(code: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    const rec = asRecord(node);
    if (!rec) return;
    if (
      typeof rec.provider === 'string' &&
      rec.provider !== '' &&
      found.indexOf(rec.provider) === -1
    ) {
      found.push(rec.provider);
    }
    if (Array.isArray(rec.block)) {
      for (const child of rec.block) visit(child);
    }
  };
  visit(code);
  return found;
}

/**
 * Adapters observed to carry no `account_id` in a recipe config because they
 * need no connection. Kept in step with CONNECTIONLESS_PROVIDERS in the
 * bridge's modules/workato/recipe-engine.ts.
 */
export const CONNECTIONLESS_PROVIDERS: ReadonlySet<string> = new Set([
  'clock',
  'csv_parser',
  'email',
  'logger',
  'py_eval',
  'workato_pub_sub',
  'workato_recipe_function',
  'workato_variable',
  // connection_required:false in /integrations/meta, checked 2026-10-19.
  'json_parser',
  'workato_template',
  'lookup_table',
  'utility',
  'workato_webhooks',
  'workato_db_table',
  'xml_parser',
  'workato_list',
  'workato_files',
]);

/**
 * A test run executes the recipe's real steps, so any connection-backed provider
 * means real records can change. Connection-backed is read from version.config:
 * an entry carries `account_id` only when its provider needs a connection.
 *
 * The absence of an account_id is NOT proof of connectionlessness. A config
 * entry left behind by a removed step, or one whose connection was never bound,
 * carries no account_id either, and treating that as connectionless sent runs
 * Workato then refused itself. Such an entry is reported in unbound_providers.
 */
export function assessTestWriteGate(configRaw: unknown, code: unknown): WriteGateAssessment {
  const entries = parseRecipeConfig(configRaw);
  const connection_backed: string[] = [];
  const known: string[] = [];
  const unboundConfig: string[] = [];
  for (const entry of entries) {
    const provider = typeof entry.provider === 'string' ? entry.provider : '';
    if (provider === '') continue;
    if (known.indexOf(provider) === -1) known.push(provider);
    const accountId = entry.account_id;
    const bound = typeof accountId === 'number' ? Number.isFinite(accountId) : accountId != null;
    if (bound) {
      if (connection_backed.indexOf(provider) === -1) connection_backed.push(provider);
    } else if (!CONNECTIONLESS_PROVIDERS.has(provider) && unboundConfig.indexOf(provider) === -1) {
      unboundConfig.push(provider);
    }
  }
  const stepProviders = collectStepProviders(code);
  const unbound_step_providers = stepProviders.filter((provider) => known.indexOf(provider) === -1);
  // Only a provider a step actually uses can break the run. A leftover entry
  // for a provider no step uses is dead weight, not a blocker.
  const unbound_providers = unboundConfig.filter(
    (provider) => stepProviders.indexOf(provider) !== -1,
  );
  return {
    connection_backed,
    unbound_step_providers,
    unbound_providers,
    requires_allow_writes: connection_backed.length > 0 || unbound_step_providers.length > 0,
  };
}

/** Body for PUT /recipes/<id>/test.json, exactly as the editor sends it. */
export function buildTestRequestBody(
  mode: TestMode,
  triggerInput: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (mode !== 'input') return { error_format: 'json' };
  return {
    trigger_event: {
      parameters: asRecord(triggerInput) ?? {},
      context: { calling_job_id: '0', calling_recipe_id: '0' },
    },
    error_format: 'json',
  };
}

/* -------------------------------------------------------------------------- */
/* In-page functions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Starts one test run and polls the test-job list for the job it produced.
 * Workato does not return the job id, so the ids present BEFORE the PUT are
 * recorded and the first id that is not among them is this run's job.
 *
 * Runs in the Workato tab's MAIN world: plain function, .then() chains only.
 */
export function runRecipeTestInPage(
  recipeId: number,
  body: Record<string, unknown>,
  waitMs: number,
  pollIntervalMs: number,
): Promise<RunInPageResult> {
  function readCookie(n: string): string | null {
    const escaped = n.replace(/[-.+*]/g, '\\$&');
    const m = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  let csrf = readCookie('XSRF-TOKEN-V2') || readCookie('XSRF-TOKEN') || readCookie('csrf-token');
  if (!csrf) {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    csrf = csrfMeta && csrfMeta.getAttribute('content');
  }
  if (!csrf) {
    return Promise.resolve({
      ok: false,
      failure: {
        stage: 'csrf' as const,
        message:
          'could not find CSRF token in XSRF-TOKEN-V2 cookie or meta tag; ensure the tab is a logged-in Workato page',
      },
    });
  }

  const jobsUrl = `/web_api/recipes/${recipeId}/jobs.json?test_jobs_only=true&per_page=5`;
  const readOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };

  function shapeJob(raw: any): TestJobSlim {
    const err = raw && raw.error;
    const message = err && err.message ? String(err.message) : '';
    const job: TestJobSlim = {
      id: String((raw && raw.id) || ''),
      status: String((raw && raw.status) || 'unknown'),
      started_at: raw && raw.started_at != null ? String(raw.started_at) : null,
      completed_at: raw && raw.completed_at != null ? String(raw.completed_at) : null,
    };
    if (message !== '') job.error = message;
    return job;
  }

  function isTerminal(raw: any): boolean {
    const status = String((raw && raw.status) || '').toLowerCase();
    if (status === 'succeeded' || status === 'failed') return true;
    return Boolean(raw && typeof raw.completed_at === 'string' && raw.completed_at !== '');
  }

  function fetchJobs(): Promise<{ ok: boolean; jobs: any[]; failure?: InPageFailure }> {
    return fetch(jobsUrl, readOpts).then((r) =>
      r.text().then((bodyText) => {
        if (r.status < 200 || r.status >= 300) {
          return {
            ok: false,
            jobs: [],
            failure: {
              stage: 'prescan' as const,
              status: r.status,
              body_excerpt: bodyText.slice(0, 512),
              message: `GET ${jobsUrl} returned HTTP ${r.status}`,
            },
          };
        }
        let json: any = null;
        try {
          json = JSON.parse(bodyText);
        } catch (e) {
          return {
            ok: false,
            jobs: [],
            failure: {
              stage: 'shape' as const,
              body_excerpt: bodyText.slice(0, 512),
              message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
            },
          };
        }
        if (!json || !Array.isArray(json.jobs)) {
          return {
            ok: false,
            jobs: [],
            failure: {
              stage: 'shape' as const,
              body_excerpt: bodyText.slice(0, 512),
              message: `GET ${jobsUrl} did not return a jobs array`,
            },
          };
        }
        return { ok: true, jobs: json.jobs };
      }),
    );
  }

  return fetchJobs().then((pre) => {
    if (!pre.ok) {
      // No PUT is sent: without the pre-run job ids the new job cannot be told
      // apart from an older test job, and a test run has real side effects.
      return { ok: false, failure: pre.failure };
    }
    const known: string[] = [];
    for (let i = 0; i < pre.jobs.length; i++) {
      const id = String((pre.jobs[i] && pre.jobs[i].id) || '');
      if (id !== '') known.push(id);
    }

    const testUrl = `/recipes/${recipeId}/test.json`;
    return fetch(testUrl, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-csrf-token': csrf as string,
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify(body),
    }).then((r) =>
      r.text().then((bodyText) => {
        let json: any = null;
        try {
          json = bodyText.length > 0 ? JSON.parse(bodyText) : {};
        } catch (e) {
          return {
            ok: false,
            failure: {
              stage: 'shape' as const,
              status: r.status,
              body_excerpt: bodyText.slice(0, 1024),
              message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
            },
          };
        }
        if (json && json.error) {
          return {
            ok: false,
            failure: {
              stage: 'workato' as const,
              message: `Workato refused the test run of recipe ${recipeId}`,
              details: json.error.details || json.error,
            },
          };
        }
        if (r.status < 200 || r.status >= 300) {
          return {
            ok: false,
            failure: {
              stage: 'test' as const,
              status: r.status,
              body_excerpt: bodyText.slice(0, 1024),
              message: `PUT ${testUrl} returned HTTP ${r.status}`,
            },
          };
        }

        const rawFlow = (json && json.flow) || null;
        const flow: TestFlowSlim = {
          running: rawFlow ? Boolean(rawFlow.running) : undefined,
          testing: rawFlow ? Boolean(rawFlow.testing) : undefined,
          last_run_at: rawFlow && rawFlow.last_run_at != null ? String(rawFlow.last_run_at) : null,
        };
        const startedAt = Date.now();
        if (!(waitMs > 0)) {
          return { ok: true, flow, job: null, polls: 0, waited_ms: 0, timed_out: false };
        }
        const deadline = startedAt + waitMs;

        function poll(polls: number, seen: any): Promise<RunInPageResult> {
          return new Promise((resolve) => setTimeout(resolve, pollIntervalMs)).then(() =>
            fetchJobs().then((res) => {
              let found = seen;
              if (res.ok) {
                for (let i = 0; i < res.jobs.length; i++) {
                  const id = String((res.jobs[i] && res.jobs[i].id) || '');
                  if (id !== '' && known.indexOf(id) === -1) {
                    found = res.jobs[i];
                    break;
                  }
                }
              }
              const attempts = polls + 1;
              if (found && isTerminal(found)) {
                return {
                  ok: true,
                  flow,
                  job: shapeJob(found),
                  polls: attempts,
                  waited_ms: Date.now() - startedAt,
                  timed_out: false,
                };
              }
              if (Date.now() >= deadline) {
                return {
                  ok: true,
                  flow,
                  job: found ? shapeJob(found) : null,
                  polls: attempts,
                  waited_ms: Date.now() - startedAt,
                  timed_out: true,
                };
              }
              return poll(attempts, found);
            }),
          );
        }

        return poll(0, null);
      }),
    );
  });
}

/**
 * Reads flow.testing plus the newest test job. Runs in the Workato tab's MAIN
 * world: plain function, .then() chains only.
 */
export function readTestStatusInPage(recipeId: number): Promise<StatusInPageResult> {
  const readOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };
  const statusUrl = `/recipes/${recipeId}/status.json`;
  const jobsUrl = `/web_api/recipes/${recipeId}/jobs.json?test_jobs_only=true&per_page=5`;

  return fetch(statusUrl, readOpts).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'status' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 512),
            message: `GET ${statusUrl} returned HTTP ${r.status}`,
          },
        };
      }
      let json: any = null;
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
      const rawFlow = (json && json.flow) || null;
      if (!rawFlow) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: bodyText.slice(0, 512),
            message: `GET ${statusUrl} did not return a flow object`,
          },
        };
      }
      const flow: TestFlowSlim = {
        state: rawFlow.state != null ? String(rawFlow.state) : undefined,
        running: Boolean(rawFlow.running),
        testing: Boolean(rawFlow.testing),
        stop_reason: rawFlow.stop_reason != null ? String(rawFlow.stop_reason) : null,
        last_run_at: rawFlow.last_run_at != null ? String(rawFlow.last_run_at) : null,
      };

      return fetch(jobsUrl, readOpts).then((jr) =>
        jr.text().then((jobsText) => {
          let latest: TestJobSlim | null = null;
          if (jr.status >= 200 && jr.status < 300) {
            try {
              const jobsJson = JSON.parse(jobsText);
              const jobs = jobsJson && Array.isArray(jobsJson.jobs) ? jobsJson.jobs : [];
              if (jobs.length > 0) {
                const raw = jobs[0];
                const err = raw && raw.error;
                const message = err && err.message ? String(err.message) : '';
                latest = {
                  id: String((raw && raw.id) || ''),
                  status: String((raw && raw.status) || 'unknown'),
                  started_at: raw && raw.started_at != null ? String(raw.started_at) : null,
                  completed_at: raw && raw.completed_at != null ? String(raw.completed_at) : null,
                };
                if (message !== '') latest.error = message;
              }
            } catch {
              /* the flow status is the answer; a job list failure is not fatal */
            }
          }
          return { ok: true, flow, latest_test_job: latest };
        }),
      );
    }),
  );
}

/**
 * Stop test: the button shown while a webhook / pub_sub test waits for an event.
 * Runs in the Workato tab's MAIN world: plain function, .then() chains only.
 */
export function stopRecipeTestInPage(recipeId: number): Promise<StopInPageResult> {
  function readCookie(n: string): string | null {
    const escaped = n.replace(/[-.+*]/g, '\\$&');
    const m = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  let csrf = readCookie('XSRF-TOKEN-V2') || readCookie('XSRF-TOKEN') || readCookie('csrf-token');
  if (!csrf) {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    csrf = csrfMeta && csrfMeta.getAttribute('content');
  }
  if (!csrf) {
    return Promise.resolve({
      ok: false,
      failure: {
        stage: 'csrf' as const,
        message:
          'could not find CSRF token in XSRF-TOKEN-V2 cookie or meta tag; ensure the tab is a logged-in Workato page',
      },
    });
  }

  const url = `/recipes/${recipeId}/stop_test.json`;
  return fetch(url, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'x-csrf-token': csrf as string,
      'x-requested-with': 'XMLHttpRequest',
    },
  }).then((r) =>
    r.text().then((bodyText) => {
      let json: any = null;
      try {
        json = bodyText.length > 0 ? JSON.parse(bodyText) : {};
      } catch (e) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 512),
            message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }
      if (json && json.error) {
        return {
          ok: false,
          failure: {
            stage: 'workato' as const,
            message: `Workato refused to stop the test of recipe ${recipeId}`,
            details: json.error.details || json.error,
          },
        };
      }
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'stop' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 512),
            message: `PUT ${url} returned HTTP ${r.status}`,
          },
        };
      }
      return { ok: true, result: json ? json.result : undefined };
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

function failureText(prefix: string, failure: InPageFailure | undefined): string {
  const stage = failure?.stage ?? 'unknown';
  return (
    `${prefix} (${stage}): ${failure?.message ?? 'unknown failure'}` +
    workatoNotFoundHint(failure?.status) +
    (failure?.body_excerpt ? `\n--- body excerpt ---\n${failure.body_excerpt}` : '') +
    (failure?.details !== undefined ? `\n--- details ---\n${JSON.stringify(failure.details)}` : '')
  );
}

class WorkatoTestRecipeTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.TEST_RECIPE;

  async execute(args: TestRecipeArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }
      const action: TestRecipeAction = args.action ?? 'run';
      if (action !== 'run' && action !== 'stop' && action !== 'status') {
        return createErrorResponse("Param [action] must be 'run', 'stop', or 'status'");
      }

      const tab = await findWorkatoTab(args.tabId);

      if (action === 'stop') return this.stopTest(tab.tabId, args.recipe_id);
      if (action === 'status') return this.readStatus(tab.tabId, args.recipe_id);
      return this.runTest(tab, args);
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_test_recipe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async stopTest(tabId: number, recipeId: number): Promise<ToolResult> {
    const result = await runInWorkatoTab(tabId, stopRecipeTestInPage, [recipeId], {
      timeoutMs: SHORT_TIMEOUT_MS,
      retryOnTimeout: false,
    });
    if (!result.ok) {
      return createErrorResponse(failureText('WorkatoApiError', result.failure));
    }
    let state: StatusInPageResult | null = null;
    try {
      state = await runInWorkatoTab(tabId, readTestStatusInPage, [recipeId], {
        timeoutMs: SHORT_TIMEOUT_MS,
      });
    } catch {
      /* the stop landed; a follow-up status read is best effort */
    }
    const payload: Record<string, unknown> = {
      recipe_id: recipeId,
      action: 'stop',
      stopped: true,
      result: result.result,
    };
    if (state && state.ok && state.flow) {
      payload.flow = { testing: state.flow.testing, running: state.flow.running };
      payload.recipe_state_after = state.flow;
    }
    return {
      content: [
        {
          type: 'text',
          text: `stopped the test of recipe ${recipeId}\n${JSON.stringify(payload)}`,
        },
      ],
      isError: false,
    };
  }

  private async readStatus(tabId: number, recipeId: number): Promise<ToolResult> {
    const state = await runInWorkatoTab(tabId, readTestStatusInPage, [recipeId], {
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    if (!state.ok || !state.flow) {
      return createErrorResponse(failureText('WorkatoApiError', state.failure));
    }
    const payload = {
      recipe_id: recipeId,
      action: 'status' as const,
      testing: state.flow.testing === true,
      flow: { testing: state.flow.testing, running: state.flow.running },
      recipe_state_after: state.flow,
      latest_test_job: state.latest_test_job ?? null,
      trace_hint: TRACE_HINT,
    };
    return {
      content: [
        {
          type: 'text',
          text:
            `recipe ${recipeId}: testing=${payload.testing}, running=${state.flow.running}\n` +
            JSON.stringify(payload),
        },
      ],
      isError: false,
    };
  }

  private async runTest(tab: WorkatoTabInfo, args: TestRecipeArgs): Promise<ToolResult> {
    const tabId = tab.tabId;
    const recipeId = args.recipe_id;
    if (args.trigger_input !== undefined && asRecord(args.trigger_input) === null) {
      return createErrorResponse('Param [trigger_input] must be a non-null object when supplied');
    }
    if (args.wait_timeout_ms !== undefined && typeof args.wait_timeout_ms !== 'number') {
      return createErrorResponse('Param [wait_timeout_ms] must be a number of milliseconds');
    }

    // One version-pinned snapshot instead of an unpinned meta+code pair: the
    // config and the tree are then guaranteed to describe the same version,
    // and a recipe already read in this session costs no code fetch at all.
    const snapshot = await loadRecipeSnapshot(tab, recipeId, { timeoutMs: CONTEXT_TIMEOUT_MS });
    if (!snapshot.ok) {
      return createErrorResponse(snapshot.error);
    }
    const context = { config: snapshot.version.config, code: snapshot.code as unknown };

    const decision = detectTestMode(context.code);
    if (decision.mode === 'unsupported') {
      return createErrorResponse(
        `WorkatoUnsupportedTestMode: ${decision.reason}. Nothing was sent. ` +
          'Run the recipe for real (workato_start_recipe) and let its own trigger fire, or ' +
          're-run a past job with workato_repeat_job.',
      );
    }

    // Write gate BEFORE any HTTP: a test run executes the recipe's real steps.
    const gate = assessTestWriteGate(context.config, context.code);
    // Workato refuses this run with "account_id can't be blank" after the
    // request has already gone out. Refuse it here, naming the provider.
    if (gate.unbound_providers.length > 0) {
      const named = gate.unbound_providers.join(', ');
      return createErrorResponse(
        `WorkatoUnboundConnection: recipe ${recipeId} uses provider ${named}, which needs a ` +
          'connection, and the recipe config carries no account_id for it. Workato refuses the ' +
          'run. These tools cannot create a connection: ask the user to create one at ' +
          `app.workato.com/connections/new (adapter ${gate.unbound_providers[0]}) and tell you ` +
          'its name, then bind it with workato_recipe_apply(bind_connection). Nothing was sent.',
      );
    }
    if (gate.requires_allow_writes && args.allow_writes !== true) {
      const named = gate.connection_backed.concat(gate.unbound_step_providers).join(', ');
      return createErrorResponse(
        `WorkatoUnsafeAction: testing recipe ${recipeId} executes its real steps and it binds ` +
          `connection-backed providers (${named}), so the run can create or change records in ` +
          'those systems. Pass allow_writes:true to proceed. Recipes that only use ' +
          'connectionless providers run without the flag.',
      );
    }

    // A test ends with the recipe stopped (stop_reason test_run_stop), so a test
    // of a running recipe could leave it stopped, and its callers failing.
    const before = await runInWorkatoTab(tabId, readTestStatusInPage, [recipeId], {
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    if (!before.ok || !before.flow) {
      return createErrorResponse(
        `${failureText('WorkatoApiError', before.failure)} Could not confirm recipe ${recipeId} ` +
          'is stopped, so the test was not sent.',
      );
    }
    if (before.flow.running) {
      return createErrorResponse(
        `WorkatoRecipeRunning: recipe ${recipeId} is running, and a test run could leave it ` +
          'stopped. Nothing was sent. Test a copy (workato_copy_recipe), or stop it, test it ' +
          'and start it again on purpose; a recipe function whose callers are running cannot ' +
          'be stopped until they are.',
      );
    }

    let validated: TriggerInputProblems | null = null;
    if (decision.mode === 'input') {
      if (decision.parameters !== null) {
        validated = validateTriggerInput(args.trigger_input, decision.parameters);
        if (validated.unknown_keys.length > 0 || validated.missing_required.length > 0) {
          const declared = decision.parameters
            .map((p) => `${p.name}${p.required ? '' : '?'}`)
            .join(', ');
          return createErrorResponse(
            `WorkatoInvalidTriggerInput: recipe ${recipeId} declares parameters [${declared || 'none'}]. ` +
              (validated.missing_required.length > 0
                ? `Missing required: ${validated.missing_required.join(', ')}. `
                : '') +
              (validated.unknown_keys.length > 0
                ? `Not declared on the trigger (would be dropped): ${validated.unknown_keys.join(', ')}. `
                : '') +
              'Nothing was sent.',
          );
        }
      }
    } else if (args.trigger_input !== undefined) {
      return createErrorResponse(
        `WorkatoUnsupportedTestMode: the ${decision.provider} trigger of recipe ${recipeId} takes ` +
          'no trigger data (mode ' +
          decision.mode +
          '); Workato sends none for it. Remove trigger_input. Nothing was sent.',
      );
    }

    const waitRequested = args.wait !== false;
    const waitTimeoutMs = Math.min(
      Math.max(args.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS),
      MAX_WAIT_TIMEOUT_MS,
    );
    // A waiting trigger produces no job until a real event arrives: polling for
    // one would only burn the wait window.
    const waitMs = decision.mode === 'waiting' || !waitRequested ? 0 : waitTimeoutMs;
    const dispatchMs =
      waitMs > 0
        ? Math.min(waitMs + DISPATCH_BUFFER_MS, MAX_DISPATCH_MS)
        : SHORT_TIMEOUT_MS + 10_000;

    const body = buildTestRequestBody(decision.mode, args.trigger_input);
    const result = await runInWorkatoTab(
      tabId,
      runRecipeTestInPage,
      [recipeId, body, waitMs, POLL_INTERVAL_MS],
      { timeoutMs: dispatchMs, retryOnTimeout: false },
    );
    if (!result.ok) {
      return createErrorResponse(
        failureText('WorkatoApiError', result.failure) +
          '\n(retriable: false - inspect the failure before retrying; a test run has real effects)',
      );
    }

    let state: StatusInPageResult | null = null;
    try {
      state = await runInWorkatoTab(tabId, readTestStatusInPage, [recipeId], {
        timeoutMs: SHORT_TIMEOUT_MS,
      });
    } catch {
      /* the test ran; the follow-up state read is best effort */
    }

    const job = result.job ?? null;
    let status: string;
    if (decision.mode === 'waiting') status = 'waiting';
    else if (waitMs === 0) status = 'started';
    else if (job && !result.timed_out) status = job.status;
    else status = 'pending';

    const payload: Record<string, unknown> = {
      recipe_id: recipeId,
      action: 'run',
      mode: decision.mode,
      trigger: { provider: decision.provider, name: decision.trigger_name },
      status,
      job,
      polls: result.polls ?? 0,
      waited_ms: result.waited_ms ?? 0,
      timed_out: result.timed_out === true,
      trace_hint: TRACE_HINT,
      flow: { testing: result.flow?.testing, running: result.flow?.running },
    };
    if (decision.mode === 'input') {
      payload.parameters_declared = decision.parameters !== null;
      if (decision.parameters !== null) payload.parameters_validated = true;
    }
    if (gate.connection_backed.length > 0 || gate.unbound_step_providers.length > 0) {
      payload.connection_backed_providers = gate.connection_backed.concat(
        gate.unbound_step_providers,
      );
    }
    if (state && state.ok && state.flow) {
      payload.recipe_state_after = state.flow;
      if (!job && state.latest_test_job) payload.latest_test_job = state.latest_test_job;
    }
    if (decision.mode === 'waiting') {
      payload.note =
        'the test is armed and waits for a real event; stop it with ' +
        "workato_test_recipe(recipe_id, action:'stop'). A pub_sub subscription can be forced " +
        'to check now with workato_api_request PUT /recipes/<id>/poll_now.json {"id":<id>}.';
    } else if (result.timed_out) {
      payload.note =
        `no finished test job within ${result.waited_ms ?? waitMs} ms; the job may still be ` +
        "running - re-check with workato_list_jobs or this tool with action:'status'";
    }

    const summary =
      `test recipe ${recipeId} (${decision.mode}): ${status}` +
      (job ? ` job=${job.id}` : '') +
      (result.timed_out ? ' (wait timed out)' : '');
    return {
      content: [{ type: 'text', text: `${summary}\n${JSON.stringify(payload)}` }],
      isError: false,
    };
  }
}

export const workatoTestRecipeTool = new WorkatoTestRecipeTool();
