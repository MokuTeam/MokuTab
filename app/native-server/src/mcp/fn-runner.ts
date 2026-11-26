/**
 * Browser functions: the step engine.
 *
 * Runs a definition's steps in one tab the run opened itself, through a small
 * driver (open, close, tab info, navigate, call a browser tool), so the engine
 * is testable without a browser and never touches a tab it did not open.
 *
 * Outcomes are named for what the caller must do next:
 * - preview: the run stopped before its first commit step; nothing changed.
 * - paused: a pause step needs params; resume with them.
 * - failed: a step failed before anything was committed; nothing changed.
 * - unknown: a step failed at or after a commit; the change may have landed.
 *   The engine never retries a commit: the caller verifies first.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  FN_BRIDGE_TOOL_ALLOWLIST,
  expressionBody,
  renderTemplate,
  renderValue,
  stableJson,
  vaultRef,
  MAX_STEP_TIMEOUT_MS,
  type FnCondition,
  type FnDefinition,
  type FnStep,
  type TemplateScope,
} from './fn-definition';
import {
  VaultError,
  pageMatchesVaultUris,
  scrubSecrets,
  type FnVault,
  type VaultField,
} from './fn-vault';

export interface TabInfo {
  exists: boolean;
  tabId: number;
  url?: string;
  status?: string;
  title?: string;
  timed_out?: boolean;
}

/** The browser, as one profile sees it. */
export interface FnDriver {
  openTab(url: string, ownWindow: boolean): Promise<{ tabId: number; windowId: number | null }>;
  /** True when the tab is gone afterwards. */
  closeTab(tabId: number): Promise<boolean>;
  tabInfo(tabId: number, waitCompleteMs?: number): Promise<TabInfo>;
  navigate(tabId: number, url: string, timeoutMs: number): Promise<TabInfo>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult>;
  /**
   * A bridge tool (FN_BRIDGE_TOOL_ALLOWLIST), run in this run's profile but not
   * in its tab. Absent on a driver that cannot reach the bridge modules.
   */
  callBridgeTool?(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<CallToolResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface TraceEntry {
  step: string;
  type: string;
  /** failed_optional: an optional step failed; its value is {state: 'error', error} and the run went on. */
  status: 'ok' | 'skipped' | 'failed' | 'failed_optional';
  ms: number;
  note?: string;
}

/** Everything a run carries between calls (a preview or pause keeps it). */
export interface RunState {
  run_id: string;
  def: FnDefinition;
  helpers: Array<{ name: string; code: string }>;
  args: Record<string, unknown>;
  prev: Record<string, unknown>;
  next: number;
  tabId: number | null;
  windowId: number | null;
  /** A commit step has run: any failure from here on is an unknown outcome. */
  committed: boolean;
  /** The caller confirmed: commit steps run instead of stopping the preview. */
  confirmed: boolean;
  /** The run stopped at its preview once: a send may be confirmed only after that. */
  previewed?: boolean;
  trace: TraceEntry[];
  /** Id of the last js, tool or finish step that ran (the default result). */
  last_value_step?: string;
  /** Last URL the run saw in its tab. */
  url?: string;
  /** Vault values typed in this run: scrubbed from every step value and from the reply. */
  secrets: string[];
  /** Vault item ids this run read (for the run log; ids are not secret). */
  vault_items: string[];
}

export type StepsOutcome =
  | { status: 'done'; value: unknown }
  | { status: 'preview'; value: unknown }
  | { status: 'paused'; needs: string[]; message?: string; step: string }
  | {
      status: 'failed' | 'unknown';
      step: string;
      message: string;
      url?: string;
      /** A verify or fail step of the function stopped it before any commit: a check did its job. */
      refused?: boolean;
    };

const POLL_MS = 500;
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_JS_MS = 60_000;
const DEFAULT_TOOL_MS = 60_000;
const DEFAULT_NAVIGATE_MS = 60_000;
const PROBE_JS_MS = 8_000;
const RESULT_MARK = '__mokutab_fn';

/**
 * Pages a function must never load: logging out or switching role ends the
 * session the user (and every other agent in the profile) is working in.
 */
const SESSION_ENDING_URL = /(log-?out|sign-?out|changerole|nllogout)/i;

/** The path only: a query parameter that merely mentions logout is not a logout page. */
export function sessionEndingUrl(url: string): boolean {
  try {
    return SESSION_ENDING_URL.test(new URL(url).pathname);
  } catch {
    return SESSION_ENDING_URL.test(url);
  }
}

/** Refuse what is not a plain http(s) page or would end the session; null when fine. */
function unloadableUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return `refused to load ${url}: not an http(s) URL`;
  if (sessionEndingUrl(url)) return `refused to load a session-ending page: ${url}`;
  return null;
}

/**
 * The value a step condition names: a step id, or a step id and a field path
 * (`store.state`). A step id with a dot in it wins over a path.
 */
export function stepValue(prev: Record<string, unknown>, ref: string): unknown {
  if (Object.prototype.hasOwnProperty.call(prev, ref)) return prev[ref];
  const [head, ...rest] = ref.split('.');
  let value: unknown = prev[head];
  for (const key of rest) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Page URLs tested against definition regexes are capped, so a slow regex stays bounded. */
const MAX_URL_TEST_CHARS = 4096;

export interface RunnerHooks {
  /**
   * Called right before a commit step executes. The run log records an
   * "unknown, committed" line here, so a bridge that dies mid-commit still
   * leaves a record that blocks a duplicate.
   */
  onCommitStart?(state: RunState, step: FnStep): void;
}

class StepError extends Error {}

/** A verify or fail step of the function said no: the check did its job. */
class CheckRefused extends StepError {}

function firstText(result: CallToolResult): string {
  const first: any = Array.isArray(result?.content) ? result.content[0] : undefined;
  return first && first.type === 'text' && typeof first.text === 'string' ? first.text : '';
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url || '').host.toLowerCase();
  } catch {
    return '';
  }
}

/** The JS sent for one js step or probe: values as JSON literals, then the body. */
export function composePageCode(state: RunState, body: string): string {
  const helpers = state.helpers
    .map((helper) => `(function (h) {\n${helper.code}\n})(h);`)
    .join('\n');
  return [
    `const args = ${JSON.stringify(state.args)};`,
    `const prev = ${JSON.stringify(state.prev)};`,
    'const h = {};',
    helpers,
    'const __fnValue = await (async () => {',
    body,
    '})();',
    `return { ${RESULT_MARK}: true, url: location.href, value: __fnValue === undefined ? null : __fnValue };`,
  ].join('\n');
}

export class FnRunner {
  constructor(
    private readonly driver: FnDriver,
    private readonly signal?: AbortSignal,
    private readonly vault?: FnVault,
    private readonly hooks: RunnerHooks = {},
  ) {}

  private scope(state: RunState): TemplateScope {
    return { args: state.args, prev: state.prev };
  }

  /** Open the run's tab on the target URL and wait for it to load. */
  async open(state: RunState): Promise<StepsOutcome | null> {
    const started = this.driver.now();
    let url: string;
    try {
      url = renderTemplate(state.def.target.url, this.scope(state), true);
    } catch (err: any) {
      return this.fail(state, 'open', 'open', started, err?.message || String(err));
    }
    const refusal = unloadableUrl(url);
    if (refusal) return this.fail(state, 'open', 'open', started, refusal);
    try {
      const tab = await this.driver.openTab(url, state.def.target.own_window !== false);
      state.tabId = tab.tabId;
      state.windowId = tab.windowId;
      const info = await this.driver.tabInfo(tab.tabId, DEFAULT_NAVIGATE_MS);
      if (!info.exists) throw new StepError('the window closed while it loaded');
      state.url = info.url;
      if (info.timed_out) throw new StepError(`the page did not finish loading: ${info.url}`);
      const hostError = await this.hostMismatch(state);
      if (hostError) throw new StepError(hostError);
    } catch (err: any) {
      return this.fail(state, 'open', 'open', started, err?.message || String(err));
    }
    state.trace.push({ step: 'open', type: 'open', status: 'ok', ms: this.driver.now() - started });
    return null;
  }

  private fail(
    state: RunState,
    stepId: string,
    type: string,
    started: number,
    rawMessage: string,
    refused = false,
  ): StepsOutcome {
    // A tool error can echo its arguments: never let a vault value out.
    const message = scrubSecrets(rawMessage, state.secrets);
    state.trace.push({
      step: stepId,
      type,
      status: 'failed',
      ms: this.driver.now() - started,
      note: message,
    });
    return {
      status: state.committed ? 'unknown' : 'failed',
      step: stepId,
      message,
      ...(state.url ? { url: state.url } : {}),
      ...(refused && !state.committed ? { refused: true } : {}),
    };
  }

  private async hostMismatch(state: RunState): Promise<string | null> {
    if (!state.def.target.host || state.tabId === null) return null;
    const expected = renderTemplate(state.def.target.host, this.scope(state), false).toLowerCase();
    const info = await this.driver.tabInfo(state.tabId);
    if (!info.exists) return 'the function window was closed';
    state.url = info.url;
    const actual = hostOf(info.url);
    return actual === expected
      ? null
      : `the page is on ${actual || info.url || 'no URL'}, expected ${expected} (logged out, or redirected?)`;
  }

  /**
   * Run steps from state.next until the end, a finish/fail step, a pause, or
   * (unconfirmed) the first commit step.
   */
  async run(state: RunState): Promise<StepsOutcome> {
    const steps = state.def.steps;
    while (state.next < steps.length) {
      const step = steps[state.next];
      const started = this.driver.now();
      if (this.signal?.aborted) {
        return this.fail(state, step.id, step.type, started, 'the call was cancelled');
      }
      if (step.commit && !state.confirmed) {
        return { status: 'preview', value: this.previewValue(state) };
      }
      let commitStarted = false;
      try {
        if (step.when) {
          const check = await this.condition(state, step.when);
          if (!check.ok) {
            state.trace.push({
              step: step.id,
              type: step.type,
              status: 'skipped',
              ms: this.driver.now() - started,
            });
            state.next += 1;
            continue;
          }
        }
        if (step.commit) {
          const hostError = await this.hostMismatch(state);
          if (hostError) throw new StepError(hostError);
          commitStarted = true;
          this.hooks.onCommitStart?.(state, step);
        }
        const outcome = await this.execute(state, step);
        if (step.commit) state.committed = true;
        const value = state.prev[step.id] as { state?: unknown; error?: unknown } | undefined;
        const optionalFailed =
          !!step.optional && !!value && value.state === 'error' && typeof value.error === 'string';
        state.trace.push({
          step: step.id,
          type: step.type,
          status: optionalFailed ? 'failed_optional' : 'ok',
          ms: this.driver.now() - started,
          ...(optionalFailed ? { note: String(value!.error).slice(0, 300) } : {}),
          ...(outcome?.status === 'paused' ? { note: 'paused' } : {}),
        });
        if (outcome) {
          if (outcome.status !== 'paused') state.next += 1;
          return outcome;
        }
        state.next += 1;
      } catch (err: any) {
        // A commit step that failed may still have landed: from here on the
        // outcome is unknown, whatever the error says.
        if (commitStarted) state.committed = true;
        return this.fail(
          state,
          step.id,
          step.type,
          started,
          err?.message || String(err),
          err instanceof CheckRefused,
        );
      }
    }
    const resultStep = state.def.result ?? state.last_value_step;
    return { status: 'done', value: resultStep ? (state.prev[resultStep] ?? null) : null };
  }

  private previewValue(state: RunState): unknown {
    const id = state.def.preview ?? state.last_value_step;
    return id ? (state.prev[id] ?? null) : null;
  }

  /** Run a step whose failure is only its value: {state: 'error', error}. */
  private async optionally(
    state: RunState,
    step: FnStep,
    run: () => Promise<StepsOutcome | null>,
  ): Promise<StepsOutcome | null> {
    try {
      return await run();
    } catch (err: any) {
      if (!(err instanceof StepError)) throw err;
      state.prev[step.id] = { state: 'error', error: err.message };
      return null;
    }
  }

  private async execute(state: RunState, step: FnStep): Promise<StepsOutcome | null> {
    const timeout = Math.min(step.timeout_ms ?? 0, MAX_STEP_TIMEOUT_MS);
    switch (step.type) {
      case 'navigate': {
        if (step.optional) {
          return this.optionally(state, step, () =>
            this.execute(state, { ...step, optional: false }),
          );
        }
        const url = renderTemplate(step.url as string, this.scope(state), true);
        const refusal = unloadableUrl(url);
        if (refusal) throw new StepError(refusal);
        const info = await this.driver.navigate(
          this.tab(state),
          url,
          timeout || DEFAULT_NAVIGATE_MS,
        );
        if (!info.exists) throw new StepError('the function window was closed');
        state.url = info.url;
        if (info.timed_out) throw new StepError(`the page did not finish loading: ${info.url}`);
        state.prev[step.id] = { url: info.url, title: info.title };
        return null;
      }
      case 'wait_for': {
        if (step.optional) {
          return this.optionally(state, step, () =>
            this.execute(state, { ...step, optional: false }),
          );
        }
        state.prev[step.id] = await this.waitFor(state, step, timeout || DEFAULT_WAIT_MS);
        return null;
      }
      case 'js': {
        state.prev[step.id] = await this.runJs(
          state,
          step.code as string,
          timeout || DEFAULT_JS_MS,
        );
        state.last_value_step = step.id;
        return null;
      }
      case 'verify': {
        const value = await this.runJs(state, step.code as string, timeout || DEFAULT_JS_MS);
        if (value !== true) {
          throw new CheckRefused(
            typeof value === 'string' && value
              ? `verify failed: ${value}`
              : `verify failed: the check returned ${JSON.stringify(value)}`,
          );
        }
        return null;
      }
      case 'tool': {
        const fromVault = vaultRef(step.args?.value);
        let args: Record<string, unknown>;
        if (fromVault !== null) {
          const { value: _ref, ...rest } = step.args ?? {};
          args = renderValue(rest, this.scope(state)) as Record<string, unknown>;
          args.value = await this.vaultValue(state, fromVault);
        } else {
          args = (renderValue(step.args ?? {}, this.scope(state)) as Record<string, unknown>) ?? {};
        }
        let result: unknown;
        try {
          result = FN_BRIDGE_TOOL_ALLOWLIST.includes(step.tool as string)
            ? await this.callBridgeTool(step.tool as string, args, timeout || DEFAULT_TOOL_MS)
            : await this.callTool(state, step.tool as string, args, timeout || DEFAULT_TOOL_MS);
        } catch (err: any) {
          if (!step.optional || !(err instanceof StepError)) throw err;
          // An optional step that failed: its value says so and the run goes on.
          result = { state: 'error', error: err.message };
        }
        state.prev[step.id] = scrubSecrets(result, state.secrets);
        state.last_value_step = step.id;
        return null;
      }
      case 'pause': {
        const needs = (step.needs ?? []).filter((need) => state.args[need] === undefined);
        if (needs.length === 0) return null;
        const message = step.message
          ? renderTemplate(step.message, this.scope(state), false)
          : undefined;
        return { status: 'paused', needs, step: step.id, ...(message ? { message } : {}) };
      }
      case 'finish': {
        const value = renderValue(step.value ?? null, this.scope(state));
        state.prev[step.id] = value;
        state.last_value_step = step.id;
        return { status: 'done', value };
      }
      case 'fail':
        throw new CheckRefused(renderTemplate(step.message as string, this.scope(state), false));
      default:
        throw new StepError(`unknown step type ${(step as FnStep).type}`);
    }
  }

  /**
   * A vault value for a fill, read at the moment it is typed (a TOTP code is
   * fresh) and only when the page is a site of that vault item.
   */
  private async vaultValue(state: RunState, name: string): Promise<string> {
    const entry = state.def.vault?.[name];
    if (!entry) throw new StepError(`{vault.${name}} is not declared under vault`);
    if (!this.vault) throw new StepError('this bridge has no vault reader');
    const item = renderTemplate(entry.item, this.scope(state), false);
    const info = await this.driver.tabInfo(this.tab(state));
    if (!info.exists) throw new StepError('the function window was closed');
    state.url = info.url;
    try {
      const uris = await this.vault.uris(item);
      if (uris.length === 0) {
        throw new StepError(
          `vault item ${item} has no website URIs, so the page cannot be checked against it; ` +
            'add the login site to the item. Nothing was typed.',
        );
      }
      if (!pageMatchesVaultUris(info.url || '', uris)) {
        throw new StepError(
          `the page (${hostOf(info.url) || info.url}) is not a website of vault item ${item}. ` +
            'Nothing was typed.',
        );
      }
      const value = await this.vault.get(item, entry.field as VaultField);
      state.secrets.push(value);
      // Reading took seconds (bw); the page may have moved meanwhile.
      const now = await this.driver.tabInfo(this.tab(state));
      if (!now.exists || !pageMatchesVaultUris(now.url || '', uris)) {
        throw new StepError(
          `the page moved to ${hostOf(now.url) || now.url || 'nowhere'} while the vault was read. Nothing was typed.`,
        );
      }
      if (!state.vault_items.includes(item)) state.vault_items.push(item);
      return value;
    } catch (err: any) {
      if (err instanceof StepError) throw err;
      if (err instanceof VaultError) throw new StepError(err.message);
      throw new StepError('reading the vault failed');
    }
  }

  private tab(state: RunState): number {
    if (state.tabId === null) throw new StepError('the run has no window');
    return state.tabId;
  }

  private async callTool(
    state: RunState,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    let result: CallToolResult;
    try {
      result = await this.driver.callTool(name, { ...args, tabId: this.tab(state) }, timeoutMs);
    } catch (err: any) {
      throw new StepError(`${name}: ${err?.message || String(err)}`);
    }
    const value = parseMaybeJson(firstText(result));
    if (result.isError) {
      const message =
        typeof value === 'string'
          ? value
          : ((value as any)?.error?.message ?? JSON.stringify(value));
      throw new StepError(`${name}: ${message}`);
    }
    return value;
  }

  /** A bridge tool: the run's profile, no tab. */
  private async callBridgeTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.driver.callBridgeTool)
      throw new StepError(`${name}: this bridge cannot run bridge tools from a function`);
    let result: CallToolResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      // The step's timeout and the run's cancel apply here too: the tool runs
      // on in the bridge, but the run stops waiting for it.
      const stopped = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
        onAbort = () => reject(new Error('the call was cancelled'));
        if (this.signal?.aborted) onAbort();
        else this.signal?.addEventListener('abort', onAbort, { once: true });
      });
      result = await Promise.race([this.driver.callBridgeTool(name, args, timeoutMs), stopped]);
    } catch (err: any) {
      throw new StepError(`${name}: ${err?.message || String(err)}`);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) this.signal?.removeEventListener('abort', onAbort);
    }
    const value = parseMaybeJson(firstText(result));
    if (result.isError) {
      const message =
        typeof value === 'string'
          ? value
          : ((value as any)?.error?.message ?? JSON.stringify(value));
      throw new StepError(`${name}: ${message}`);
    }
    return value;
  }

  /** Run a body in the page; returns its value. */
  private async runJs(state: RunState, body: string, timeoutMs: number): Promise<unknown> {
    let result: CallToolResult;
    try {
      result = await this.driver.callTool(
        'chrome_javascript',
        {
          tabId: this.tab(state),
          code: composePageCode(state, body),
          timeoutMs,
          rawOutput: true,
        },
        timeoutMs + 10_000,
      );
    } catch (err: any) {
      throw new StepError(`chrome_javascript: ${err?.message || String(err)}`);
    }
    const payload = parseMaybeJson(firstText(result)) as any;
    if (result.isError || !payload || payload.success !== true) {
      const kind = payload?.error?.kind;
      const message =
        payload?.error?.message ?? (typeof payload === 'string' ? payload : 'no result');
      throw new StepError(
        kind === 'timeout'
          ? `timed out after ${timeoutMs} ms; the page may still be running it`
          : `${kind ? `${kind}: ` : ''}${message}`,
      );
    }
    const parsed = parseMaybeJson(String(payload.result ?? '')) as any;
    if (!parsed || typeof parsed !== 'object' || parsed[RESULT_MARK] !== true) {
      throw new StepError('the step result could not be read back');
    }
    if (typeof parsed.url === 'string') state.url = parsed.url;
    return parsed.value;
  }

  private async condition(
    state: RunState,
    cond: FnCondition,
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    if (cond.step !== undefined) {
      const actual = stableJson(stepValue(state.prev, cond.step) ?? null);
      const options = cond.equals !== undefined ? [cond.equals] : (cond.in ?? []);
      return { ok: options.some((option) => stableJson(option) === actual) };
    }
    if (cond.url !== undefined) {
      const info = await this.driver.tabInfo(this.tab(state));
      if (!info.exists) throw new StepError('the function window was closed');
      state.url = info.url;
      const subject = (info.url || '').slice(0, MAX_URL_TEST_CHARS);
      return { ok: new RegExp(cond.url).test(subject), value: info.url };
    }
    if (cond.exists !== undefined || cond.missing !== undefined) {
      const selector = (cond.exists ?? cond.missing) as string;
      const found = (await this.callTool(
        state,
        'chrome_find_elements',
        { selector, maxResults: 1, includeText: false },
        PROBE_JS_MS,
      )) as any;
      const total = typeof found?.total === 'number' ? found.total : 0;
      return { ok: cond.exists !== undefined ? total > 0 : total === 0 };
    }
    const value = await this.runJs(state, expressionBody(cond.js as string), PROBE_JS_MS);
    return { ok: Boolean(value), value };
  }

  private async waitFor(state: RunState, step: FnStep, timeoutMs: number): Promise<unknown> {
    const deadline = this.driver.now() + timeoutMs;
    const conditions: FnCondition[] =
      step.any ??
      (typeof step.until === 'string' ? [{ js: step.until }] : [step.until as FnCondition]);
    let lastError = '';
    for (;;) {
      for (const cond of conditions) {
        try {
          const check = await this.condition(state, cond);
          if (check.ok) {
            if (step.any) return cond.name;
            return check.value === undefined ? true : check.value;
          }
        } catch (err: any) {
          // A page that is navigating answers with errors: not ready yet.
          lastError = err?.message || String(err);
          if (/window was closed/.test(lastError)) throw err;
        }
      }
      if (this.signal?.aborted) throw new StepError('the call was cancelled');
      if (this.driver.now() >= deadline) {
        throw new StepError(
          `still not ready after ${timeoutMs} ms` +
            (lastError ? ` (last error: ${lastError})` : ''),
        );
      }
      await this.driver.sleep(POLL_MS);
    }
  }
}

export function newRunState(
  run_id: string,
  def: FnDefinition,
  helpers: Array<{ name: string; code: string }>,
  args: Record<string, unknown>,
): RunState {
  return {
    run_id,
    def,
    helpers,
    args,
    prev: {},
    next: 0,
    tabId: null,
    windowId: null,
    committed: false,
    confirmed: false,
    trace: [],
    secrets: [],
    vault_items: [],
  };
}
