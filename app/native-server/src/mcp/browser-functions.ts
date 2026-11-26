/**
 * Browser functions: the chrome_fn_* tools.
 *
 * Saved, versioned browser flows. A definition (see fn-definition.ts) lives in
 * a private git registry (fn-registry.ts); a run opens a window of its own,
 * runs the steps there (fn-runner.ts), closes the window and logs the run
 * (fn-runs-log.ts). Everything runs in the bridge on top of tab and tool
 * messages the extension already answers, so a function can only ever touch
 * the tab it opened.
 *
 * Write safety: a write or send run without confirm stops before its first
 * commit step and answers with a preview and a run_id; the window stays open
 * (10 minutes) so the confirmed call commits exactly what was previewed. A
 * write may also run in one call with confirm:true; a send never does. The
 * approval itself stays with the calling agent and its user.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  NativeMessageType,
  CORE_TOOL_NAMES,
  sanitizeAndLimitOutput,
} from '@mokuhub/mokutab-shared';
import {
  checkParams,
  isHelperName,
  pausedParams,
  renderTemplate,
  stableJson,
  validateDefinition,
  type FnDefinition,
  type HelperDefinition,
} from './fn-definition';
import { FnRegistry, SaveRefused, parseYaml, toYaml } from './fn-registry';
import { FnRunsLog, type FnRunPhase, type FnRunRecord, type FnRunStatus } from './fn-runs-log';
import { scrubSecrets, type FnVault } from './fn-vault';
import {
  FnRunner,
  newRunState,
  type FnDriver,
  type RunState,
  type StepsOutcome,
} from './fn-runner';

export const FN_LIST_TOOL = CORE_TOOL_NAMES.BROWSER.FN_LIST;
export const FN_GET_TOOL = CORE_TOOL_NAMES.BROWSER.FN_GET;
export const FN_RUN_TOOL = CORE_TOOL_NAMES.BROWSER.FN_RUN;
export const FN_SAVE_TOOL = CORE_TOOL_NAMES.BROWSER.FN_SAVE;
export const FN_RUNS_TOOL = CORE_TOOL_NAMES.BROWSER.FN_RUNS;
const FN_TOOLS = new Set<string>([
  FN_LIST_TOOL,
  FN_GET_TOOL,
  FN_RUN_TOOL,
  FN_SAVE_TOOL,
  FN_RUNS_TOOL,
]);

export function isFnTool(name: string): boolean {
  return FN_TOOLS.has(name);
}

/** How long a preview or a pause keeps its window for the follow-up call. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** A commit with the same dedupe key inside this window is refused. */
export const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_INLINE_BYTES = 100 * 1024;

export interface FnDeps {
  registry: FnRegistry;
  log: FnRunsLog;
  /** Reads vault values for functions that type them (fn-vault.ts). */
  vault?: FnVault;
  /** The browser of one connected profile. */
  driverFor(profile: string): FnDriver;
  connectedProfiles(): string[];
  activeProfile(): string | null;
  now(): number;
  /**
   * Run a bridge tool (FN_BRIDGE_TOOL_ALLOWLIST) in a profile, the way the
   * router would: refused while its module is off.
   */
  callBridgeTool?(
    name: string,
    args: Record<string, unknown>,
    profile: string,
    timeoutMs: number,
  ): Promise<CallToolResult>;
}

/** The profile's driver, plus bridge tools when the deps can run them. */
function driverWithBridgeTools(deps: FnDeps, profile: string): FnDriver {
  const driver = deps.driverFor(profile);
  const call = deps.callBridgeTool;
  if (!call || driver.callBridgeTool) return driver;
  return {
    ...driver,
    callBridgeTool: (name, args, timeoutMs) => call(name, args, profile, timeoutMs),
  };
}

interface PendingRun {
  state: RunState;
  profile: string;
  caller?: string;
  status: 'preview' | 'paused';
  expires_at: number;
}

const pending = new Map<string, PendingRun>();
const inFlightDedupe = new Set<string>();
let sweepTimer: NodeJS.Timeout | null = null;

function newRunId(): string {
  return `R${randomBytes(6).toString('hex')}`;
}

function textResult(body: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Redact and cap what goes back to the model, like chrome_javascript output. */
function safeResult(body: unknown, isError = false): CallToolResult {
  const out = sanitizeAndLimitOutput(body, { maxBytes: MAX_INLINE_BYTES, maxDepth: 12 });
  let text = out.text;
  if (out.truncated) {
    text += '\n[The result was truncated. Run again with out_file to get all of it in a file.]';
  }
  return { content: [{ type: 'text', text }], isError };
}

/** Close a run's window; true only when the tab is really gone. */
function closeQuietly(deps: FnDeps, profile: string, tabId: number | null): Promise<boolean> {
  if (tabId === null) return Promise.resolve(false);
  return deps
    .driverFor(profile)
    .closeTab(tabId)
    .catch(() => false);
}

function ensureSweep(deps: FnDeps): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = deps.now();
    for (const [id, run] of pending) {
      if (run.expires_at > now) continue;
      pending.delete(id);
      void closeQuietly(deps, run.profile, run.state.tabId);
    }
    if (pending.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, 60_000);
  sweepTimer.unref();
}

/** Test hook: forget pending runs and stop the sweep. */
export function resetFnRuntime(): void {
  pending.clear();
  inFlightDedupe.clear();
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

export interface FnCallContext {
  /** Profile named on this call (routing arg), if any. */
  callProfile: string | null;
  /** Profile this MCP session is pinned to, if any. */
  sessionProfile: string | null;
  signal?: AbortSignal;
}

export async function handleFnToolCall(
  name: string,
  args: Record<string, any>,
  ctx: FnCallContext,
  deps: FnDeps,
): Promise<CallToolResult> {
  try {
    switch (name) {
      case FN_LIST_TOOL:
        return handleList(args, deps);
      case FN_GET_TOOL:
        return await handleGet(args, deps);
      case FN_SAVE_TOOL:
        return await handleSave(args, deps);
      case FN_RUNS_TOOL:
        return handleRuns(args, deps);
      case FN_RUN_TOOL:
        return await handleRun(args, ctx, deps);
      default:
        return errorResult(`unknown function tool ${name}`);
    }
  } catch (err: any) {
    if (err instanceof SaveRefused) return errorResult(err.message);
    return errorResult(err?.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// list / get / runs
// ---------------------------------------------------------------------------

function handleList(args: Record<string, any>, deps: FnDeps): CallToolResult {
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const tag = typeof args.tag === 'string' ? args.tag.trim().toLowerCase() : '';
  const includeDrafts = args.include_drafts === true;
  const state = deps.log.state();
  const functions: unknown[] = [];
  const helpers: string[] = [];
  const broken: unknown[] = [];
  let hidden = 0;
  for (const entry of deps.registry.list()) {
    if (isHelperName(entry.name)) {
      helpers.push(entry.name);
      continue;
    }
    if (entry.error || !entry.definition) {
      broken.push({ name: entry.name, error: entry.error });
      continue;
    }
    const def = entry.definition as FnDefinition;
    const haystack = `${def.name} ${def.description} ${(def.tags ?? []).join(' ')}`.toLowerCase();
    if (query && !query.split(/\s+/).every((word) => haystack.includes(word))) continue;
    if (tag && !(def.tags ?? []).some((t) => t.toLowerCase() === tag)) continue;
    const runs = state[def.name];
    // Never ran successfully at all (not even a preview): hidden unless asked.
    if (!runs?.last_ok_at && !includeDrafts) {
      hidden += 1;
      continue;
    }
    const committedOk = def.kind === 'read' ? runs?.last_ok_at : runs?.last_commit_ok_at;
    const committedVersion =
      def.kind === 'read' ? runs?.last_ok_version : runs?.last_commit_ok_version;
    functions.push({
      name: def.name,
      kind: def.kind,
      version: def.version ?? 0,
      description: def.description,
      ...(def.tags?.length ? { tags: def.tags } : {}),
      draft: !committedOk,
      ...(committedOk ? { last_success: committedOk, last_success_version: committedVersion } : {}),
      ...(runs?.last_ok_version !== undefined && runs.last_ok_version !== def.version
        ? { note: `version ${def.version} has not run successfully yet` }
        : {}),
    });
  }
  return textResult({
    registry: deps.registry.dir,
    functions,
    ...(hidden
      ? {
          hidden_drafts: hidden,
          hint: 'include_drafts:true lists functions that never ran successfully',
        }
      : {}),
    ...(helpers.length ? { helpers } : {}),
    ...(broken.length ? { broken } : {}),
  });
}

async function handleGet(args: Record<string, any>, deps: FnDeps): Promise<CallToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return errorResult('name is required');
  const entry = deps.registry.get(name);
  if (!entry) return errorResult(`no function "${name}" in ${deps.registry.dir}`);
  if (entry.error) return errorResult(`${name}: ${entry.error} (${entry.file})`);
  const definition =
    typeof args.version === 'number'
      ? await deps.registry.getVersion(name, args.version)
      : (entry.definition as FnDefinition | HelperDefinition);
  const history = args.history === true ? await deps.registry.history(name) : undefined;
  const runs = deps.log.state()[name];
  if (typeof args.out_file === 'string' && args.out_file.trim()) {
    const target = args.out_file.trim();
    if (!path.isAbsolute(target)) return errorResult('out_file must be an absolute path');
    fs.writeFileSync(target, toYaml(definition));
    return textResult({
      name,
      version: (definition as any).version,
      saved_to: target,
      file: entry.file,
      note: 'Edit the file, then chrome_fn_save(source_path, base_version, changelog).',
      ...(history ? { history } : {}),
    });
  }
  return textResult({
    definition,
    file: entry.file,
    ...(runs ? { runs } : {}),
    ...(history ? { history } : {}),
  });
}

function handleRuns(args: Record<string, any>, deps: FnDeps): CallToolResult {
  const limit =
    typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 200) : 20;
  const fn = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
  return textResult({ runs: deps.log.recent({ fn, limit }) });
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

async function handleSave(args: Record<string, any>, deps: FnDeps): Promise<CallToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return errorResult('name is required');
  const changelog = typeof args.changelog === 'string' ? args.changelog : '';
  const base = typeof args.base_version === 'number' ? args.base_version : undefined;
  const caller = typeof args.caller === 'string' ? args.caller : undefined;

  let definition: any;
  const sources = ['definition', 'source_path', 'from_version'].filter(
    (k) => args[k] !== undefined,
  );
  if (sources.length !== 1) {
    return errorResult('pass exactly one of definition, source_path or from_version');
  }
  if (args.definition !== undefined) {
    definition = args.definition;
  } else if (args.source_path !== undefined) {
    const source = String(args.source_path);
    if (!path.isAbsolute(source)) return errorResult('source_path must be an absolute path');
    const text = fs.readFileSync(source, 'utf8');
    definition = /\.json$/i.test(source) ? JSON.parse(text) : parseYaml(text);
  } else {
    if (typeof args.from_version !== 'number') return errorResult('from_version must be a number');
    definition = await deps.registry.getVersion(name, args.from_version);
  }
  if (!definition || typeof definition !== 'object') return errorResult('the definition is empty');
  if (definition.name === undefined) definition = { ...definition, name };
  if (definition.name !== name) {
    return errorResult(`the definition is named "${definition.name}", the call "${name}"`);
  }
  const { version: _ignored, ...withoutVersion } = definition;
  const saved = await deps.registry.save(withoutVersion, {
    base_version: base,
    changelog:
      args.from_version !== undefined
        ? `rollback to v${args.from_version}: ${changelog}`
        : changelog,
    caller,
  });
  const state = deps.log.state()[name];
  return textResult({
    saved: saved.name,
    version: saved.version,
    previous_version: saved.previous_version,
    commit: saved.sha.slice(0, 12),
    file: saved.file,
    ...(isHelperName(name) || state?.last_ok_at
      ? {}
      : { note: 'Draft until it runs successfully once; chrome_fn_list hides it until then.' }),
  });
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function pickProfile(def: FnDefinition, ctx: FnCallContext, deps: FnDeps): string {
  const profile =
    ctx.callProfile || def.target.profile || ctx.sessionProfile || deps.activeProfile();
  if (!profile) throw new Error('no Chrome profile is connected');
  if (!deps.connectedProfiles().includes(profile)) {
    throw new Error(
      `profile "${profile}" is not connected (connected: ${JSON.stringify(deps.connectedProfiles())})`,
    );
  }
  return profile;
}

function dedupeKey(state: RunState, deps: FnDeps): string | undefined {
  const template = state.def.dedupe_key;
  if (!template) return undefined;
  return deps.log.hashParams(renderTemplate(template, { args: state.args, prev: {} }, false));
}

/** One run-log line; the param values themselves never reach it. */
function runRecord(
  state: RunState,
  profile: string,
  phase: FnRunPhase,
  status: FnRunStatus,
  opts: RunOptions,
  started: number,
  extra: Partial<FnRunRecord> = {},
): FnRunRecord {
  const { deps } = opts;
  return {
    ts: new Date(deps.now()).toISOString(),
    run_id: state.run_id,
    fn: state.def.name,
    version: state.def.version ?? 0,
    kind: state.def.kind,
    phase,
    status,
    committed: state.committed,
    ...(opts.caller ? { caller: opts.caller } : {}),
    profile,
    params_hash: deps.log.hashParams(stableJson(state.args)),
    ...(opts.dedupe ? { dedupe: opts.dedupe.key } : {}),
    ...(state.vault_items.length ? { vault_items: [...state.vault_items] } : {}),
    ms: deps.now() - started,
    ...extra,
  };
}

/** Append to the run log; a failure becomes a warning in the reply, never a lost outcome. */
function appendQuietly(deps: FnDeps, record: FnRunRecord): string | null {
  try {
    return deps.log.append(record);
  } catch (err: any) {
    return `the run log was not written: ${err?.message || String(err)}`;
  }
}

/**
 * Claim the dedupe slot of a confirmed run, or say why it must not commit: the
 * same key committed (or ended unknown) within the window, or is committing in
 * another call right now. Returns null when the run has no dedupe key or is not
 * confirmed yet.
 */
function claimDedupe(
  state: RunState,
  deps: FnDeps,
  allowDuplicate: boolean,
): { key: string; slot: string } | { refused: string } | null {
  if (!state.confirmed) return null;
  const key = dedupeKey(state, deps);
  if (!key) return null;
  const slot = `${state.def.name}:${key}`;
  if (!allowDuplicate) {
    const earlier = deps.log.findDuplicate(state.def.name, key, deps.now() - DEDUPE_WINDOW_MS);
    if (earlier) {
      return {
        refused:
          `the same ${state.def.name} was already committed at ${earlier.ts} (run ${earlier.run_id}, ` +
          `${earlier.status}). Nothing was sent. If it really must happen again, pass allow_duplicate:true.`,
      };
    }
    if (inFlightDedupe.has(slot)) {
      return {
        refused: `the same ${state.def.name} is being committed by another call right now. Nothing was sent.`,
      };
    }
  }
  inFlightDedupe.add(slot);
  return { key, slot };
}

async function handleRun(
  args: Record<string, any>,
  ctx: FnCallContext,
  deps: FnDeps,
): Promise<CallToolResult> {
  const caller =
    typeof args.caller === 'string' && args.caller.trim() ? args.caller.trim() : undefined;
  const keepOpen = args.keep_open === true;
  const confirm = args.confirm === true;
  const outFile =
    typeof args.out_file === 'string' && args.out_file.trim() ? args.out_file.trim() : undefined;
  if (outFile && !path.isAbsolute(outFile)) return errorResult('out_file must be an absolute path');
  // Checked before any window opens: a bad path must not surface after a commit.
  if (outFile && !fs.existsSync(path.dirname(outFile))) {
    return errorResult(`out_file directory does not exist: ${path.dirname(outFile)}`);
  }

  // Follow-up of a preview or a pause.
  if (typeof args.run_id === 'string' && args.run_id.trim()) {
    const runId = args.run_id.trim();
    const run = pending.get(runId);
    if (!run) {
      return errorResult(
        `unknown or expired run_id ${runId} (previews and pauses keep their window for ` +
          `${PENDING_TTL_MS / 60000} minutes). Start again without run_id.`,
      );
    }
    if (args.cancel === true) {
      pending.delete(runId);
      const closed = await closeQuietly(deps, run.profile, run.state.tabId);
      return textResult({
        run_id: runId,
        cancelled: true,
        window_closed: closed,
        ...(closed || run.state.tabId === null
          ? {}
          : {
              note: `tab ${run.state.tabId} is still open (a leave-page prompt?); close it with chrome_close_tabs`,
            }),
      });
    }
    if (args.name !== undefined && args.name !== run.state.def.name) {
      return errorResult(`run ${runId} is ${run.state.def.name}, not ${args.name}`);
    }
    const extra = args.params ?? {};
    if (typeof extra !== 'object' || Array.isArray(extra))
      return errorResult('params must be an object');
    if (run.status === 'preview') {
      if (!confirm) {
        return errorResult(
          `run ${runId} is waiting at its preview. Pass confirm:true to commit it, or cancel:true.`,
        );
      }
      if (Object.keys(extra).length) {
        return errorResult(
          'a confirmed preview commits what was previewed; params cannot change now',
        );
      }
    }
    const merged = { ...run.state.args, ...extra };
    if (run.status === 'paused') {
      const allowed = pausedParams(run.state.def);
      const bad = Object.keys(extra).filter((key) => !allowed.has(key));
      if (bad.length)
        return errorResult(`on resume only paused params may be passed, not: ${bad.join(', ')}`);
    }
    const check = checkParams(run.state.def.params, merged, pausedParams(run.state.def));
    if (!check.ok) return errorResult(`params:\n- ${check.errors.join('\n- ')}`);
    // A send commits only from its preview, also when a pause came first.
    if (confirm && run.state.def.kind === 'send' && !run.state.previewed) {
      return errorResult(
        `a send commits only from its preview: resume run ${runId} without confirm, it stops at ` +
          'the preview; show that to your user, then confirm it.',
      );
    }
    run.state.args = check.value;
    if (confirm) run.state.confirmed = true;
    const claim = claimDedupe(run.state, deps, args.allow_duplicate === true);
    if (claim && 'refused' in claim) return errorResult(claim.refused);
    pending.delete(runId);
    return runToEnd(run.state, run.profile, run.status === 'preview' ? 'commit' : 'full', null, {
      caller: caller ?? run.caller,
      keepOpen,
      outFile,
      signal: ctx.signal,
      deps,
      dedupe: claim ?? undefined,
    });
  }

  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return errorResult('name is required (or run_id to continue a run)');
  const entry = deps.registry.get(name);
  if (!entry) return errorResult(`no function "${name}" (chrome_fn_list shows what exists)`);
  if (entry.error || !entry.definition)
    return errorResult(`${name}: ${entry.error} (${entry.file})`);
  if (isHelperName(name)) return errorResult(`${name} is a helper library, not a function`);
  const def = entry.definition as FnDefinition;
  const problems = validateDefinition(def);
  if (problems.length) {
    return errorResult(
      `${name} v${def.version} does not validate (edited by hand?):\n- ${problems.join('\n- ')}`,
    );
  }
  // A function that types vault values runs only as a person committed it.
  if (def.vault !== undefined) {
    const why = await deps.registry.handCommitted(name);
    if (why) {
      return errorResult(
        `${name} types vault values, so it runs only exactly as a person committed it: ${why}. Nothing was run.`,
      );
    }
  }
  if (def.kind === 'send' && confirm) {
    return errorResult(
      'a send runs in two calls: call without confirm to get the preview and a run_id, show it ' +
        'to your user, then call again with run_id and confirm:true.',
    );
  }
  const check = checkParams(def.params, args.params ?? {}, pausedParams(def));
  if (!check.ok) return errorResult(`params:\n- ${check.errors.join('\n- ')}`);
  const profile = pickProfile(def, ctx, deps);
  const helpers = deps.registry.helpers(def.helpers ?? []);
  const state = newRunState(newRunId(), def, helpers, check.value);
  state.confirmed = def.kind === 'read' || confirm;
  // Refuse a duplicate before a window is even opened.
  const claim = claimDedupe(state, deps, args.allow_duplicate === true);
  if (claim && 'refused' in claim) return errorResult(claim.refused);
  return runToEnd(state, profile, 'full', 'open', {
    caller,
    keepOpen,
    outFile,
    signal: ctx.signal,
    deps,
    dedupe: claim ?? undefined,
  });
}

interface RunOptions {
  caller?: string;
  keepOpen: boolean;
  outFile?: string;
  signal?: AbortSignal;
  deps: FnDeps;
  /** A claimed dedupe slot, released when the run ends. */
  dedupe?: { key: string; slot: string };
}

/**
 * Open the window (new runs), run the steps, and settle the window and log.
 * An unexpected error still closes the window: it must not outlive its run.
 */
async function runToEnd(
  state: RunState,
  profile: string,
  phase: FnRunPhase,
  first: 'open' | null,
  opts: RunOptions,
): Promise<CallToolResult> {
  const { deps } = opts;
  const started = deps.now();
  const runner = new FnRunner(driverWithBridgeTools(deps, profile), opts.signal, deps.vault, {
    // Written before the commit runs: a bridge that dies mid-commit still blocks a duplicate.
    onCommitStart: (s) => {
      appendQuietly(
        deps,
        runRecord(s, profile, 'commit_start', 'unknown', opts, started, { committed: true }),
      );
    },
  });
  try {
    const opened = first === 'open' ? await runner.open(state) : null;
    const outcome = opened ?? (await runner.run(state));
    return await finishRun(state, profile, outcome, phase, started, opts);
  } catch (err) {
    if (!pending.has(state.run_id)) await closeQuietly(deps, profile, state.tabId);
    throw err;
  } finally {
    if (opts.dedupe) inFlightDedupe.delete(opts.dedupe.slot);
  }
}

async function finishRun(
  state: RunState,
  profile: string,
  outcome: StepsOutcome,
  phase: FnRunPhase,
  started: number,
  opts: RunOptions,
): Promise<CallToolResult> {
  const { deps } = opts;
  const def = state.def;
  const keepPending = outcome.status === 'preview' || outcome.status === 'paused';
  const status: FnRunStatus = outcome.status === 'done' ? 'ok' : outcome.status;
  const logPhase: FnRunPhase =
    outcome.status === 'preview' ? 'preview' : outcome.status === 'paused' ? 'paused' : phase;

  let windowNote: Record<string, unknown> = {};
  if (outcome.status === 'preview') state.previewed = true;
  if (keepPending) {
    pending.set(state.run_id, {
      state,
      profile,
      caller: opts.caller,
      status: outcome.status as 'preview' | 'paused',
      expires_at: deps.now() + PENDING_TTL_MS,
    });
    ensureSweep(deps);
    windowNote = { window: { tabId: state.tabId, profile, kept_for_s: PENDING_TTL_MS / 1000 } };
    // keep_open is ignored for a vault function: a window a secret was typed into always closes.
  } else if (opts.keepOpen && state.tabId !== null && def.vault === undefined) {
    windowNote = {
      window: {
        tabId: state.tabId,
        profile,
        kept: true,
        note: 'Left open for inspection (chrome_javascript with this tabId); close it with chrome_close_tabs.',
      },
    };
  } else if (state.tabId !== null && !(await closeQuietly(deps, profile, state.tabId))) {
    windowNote = {
      window: {
        tabId: state.tabId,
        profile,
        kept: true,
        note: 'The window did not close (a leave-page prompt?); close it with chrome_close_tabs.',
      },
    };
  }

  const logWarning = appendQuietly(
    deps,
    runRecord(
      state,
      profile,
      logPhase,
      status,
      opts,
      started,
      outcome.status === 'failed' || outcome.status === 'unknown'
        ? { failed_step: outcome.step, ...(outcome.refused ? { refused: true } : {}) }
        : {},
    ),
  );

  const head = { function: def.name, version: def.version ?? 0, run_id: state.run_id, status };
  let body: Record<string, unknown>;
  switch (outcome.status) {
    case 'done': {
      const previewId = def.preview;
      body = {
        ...head,
        result: outcome.value,
        ...(def.kind !== 'read' && previewId ? { preview: state.prev[previewId] ?? null } : {}),
      };
      break;
    }
    case 'preview':
      body = {
        ...head,
        preview: outcome.value,
        next:
          'Nothing was committed. Show the preview to your user; to commit exactly this, call ' +
          `chrome_fn_run({run_id: "${state.run_id}", confirm: true}); to drop it, add cancel:true.`,
      };
      break;
    case 'paused':
      body = {
        ...head,
        needs: outcome.needs,
        ...(outcome.message ? { message: outcome.message } : {}),
        next: `Resume with chrome_fn_run({run_id: "${state.run_id}", params: {${outcome.needs.map((n) => `${n}: ...`).join(', ')}}}).`,
      };
      break;
    default: {
      let hint: string | undefined;
      if (outcome.status === 'unknown' && def.verify_hint) {
        try {
          hint = renderTemplate(def.verify_hint, { args: state.args, prev: state.prev }, false);
        } catch {
          hint = def.verify_hint;
        }
      }
      body = {
        ...head,
        error: {
          step: outcome.step,
          message: outcome.message,
          ...(outcome.url ? { url: outcome.url } : {}),
        },
        ...(outcome.status === 'unknown'
          ? {
              warning:
                'A commit step ran or was running: the change MAY have landed. Do not run it again ' +
                'before checking.',
              ...(hint ? { verify_hint: hint } : {}),
            }
          : {
              ...(outcome.refused ? { refused: true } : {}),
              note: outcome.refused
                ? 'A check of the function stopped the run. Nothing was committed.'
                : 'Nothing was committed.',
            }),
      };
    }
  }
  // No vault value leaves the bridge, wherever a page or tool echoed it.
  body = scrubSecrets(
    {
      ...body,
      ...windowNote,
      ...(logWarning ? { log_warning: logWarning } : {}),
      trace: state.trace,
    },
    state.secrets,
  );

  const isError = outcome.status === 'failed' || outcome.status === 'unknown';
  if (opts.outFile && outcome.status === 'done') {
    try {
      fs.writeFileSync(opts.outFile, JSON.stringify(body, null, 2));
      return textResult({ ...head, saved_to: opts.outFile, bytes: fs.statSync(opts.outFile).size });
    } catch (err: any) {
      // The run is done (maybe committed): report it inline rather than lose it.
      body = { ...body, out_file_error: err?.message || String(err) };
    }
  }
  return safeResult(body, isError);
}

// ---------------------------------------------------------------------------
// The real driver: profile registry messages
// ---------------------------------------------------------------------------

type SendRequest = (
  profile: string,
  payload: unknown,
  type: string,
  timeoutMs: number,
) => Promise<any>;

export function profileDriver(profile: string, send: SendRequest): FnDriver {
  const ask = async (payload: unknown, type: string, timeoutMs: number) => {
    const reply = await send(profile, payload, type, timeoutMs);
    if (reply?.status !== 'success') throw new Error(reply?.error || `${type} failed`);
    return reply.data;
  };
  return {
    async openTab(url, ownWindow) {
      const data = await ask(
        { url, own_window: ownWindow },
        NativeMessageType.AGENT_TAB_OPEN,
        20_000,
      );
      if (typeof data?.tabId !== 'number') throw new Error('the extension returned no tab id');
      return {
        tabId: data.tabId,
        windowId: typeof data.windowId === 'number' ? data.windowId : null,
      };
    },
    async closeTab(tabId) {
      const data = await ask({ tabId }, NativeMessageType.AGENT_TAB_CLOSE, 15_000);
      // Older extensions answer only `closed`.
      return typeof data?.gone === 'boolean' ? data.gone : data?.closed === true;
    },
    async tabInfo(tabId, waitCompleteMs = 0) {
      return ask(
        { tabId, wait_complete_ms: waitCompleteMs },
        NativeMessageType.AGENT_TAB_INFO,
        waitCompleteMs + 10_000,
      );
    },
    async navigate(tabId, url, timeoutMs) {
      return ask(
        { tabId, url, timeout_ms: timeoutMs },
        NativeMessageType.AGENT_TAB_NAVIGATE,
        timeoutMs + 10_000,
      );
    },
    async callTool(name, toolArgs, timeoutMs) {
      const reply = await send(
        profile,
        { name, args: toolArgs },
        NativeMessageType.CALL_TOOL,
        timeoutMs,
      );
      if (reply?.status === 'success') return reply.data as CallToolResult;
      return {
        content: [{ type: 'text', text: String(reply?.error || 'the tool call failed') }],
        isError: true,
      };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
