import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTabDetailed, WorkatoDispatchError } from './tab-dispatch';
import {
  buildCoverageSummary,
  normalizeMatchSpec,
  normalizeStartedBound,
  parseReportColumns,
  projectJobFields,
  shapeSlimJob,
  validateJobFields,
  type JobScanCoverage,
  type MatchSpec,
  type ReportColumn,
} from './job-projection';
import { loadRecipeSnapshot } from './pull-recipe';

/** started_at values Workato honours. Anything else is silently ignored server-side. */
const STARTED_AT_VALUES = ['1.hour', '24.hours', '7.days', '30.days', 'all'] as const;

interface ListJobsArgs {
  recipe_id: number;
  limit?: number;
  status?: string;
  query?: string;
  started_at?: string;
  /** ISO-8601, YYYY-MM-DD or YYYY-MM-DDTHH:MM(:SS). Forwarded as started_at_from. */
  started_from?: string;
  /** Same shape as started_from. Forwarded as started_at_to. */
  started_to?: string;
  /** Zone applied to started_from/started_to when they carry no offset. Default UTC. */
  timezone?: string;
  /** Local scan predicate, applied to every scanned job in the page walk. */
  match?: { mode?: 'exact' | 'substring' | 'regex'; fields?: string[]; value: string };
  /** Jobs SCANNED before the walk gives up. Default 500, max 5000. Separate from limit. */
  scan_budget?: number;
  /** Stop after 3 consecutive erased jobs. Default true. */
  stop_on_erased?: boolean;
  /** Project the slim job down to these fields, e.g. ['id','started_at','report.Marker code']. */
  fields?: string[];
  /** Read the recipe's job_report_schema to label report columns. Default true. */
  report_labels?: boolean;
  group_by_master_job?: boolean;
  cursor?: string;
  full?: boolean;
  /** In-page script timeout. Default 30000, clamped 10000–110000. */
  timeout_ms?: number;
  tabId?: number;
}

interface RawJobsPage {
  job_count?: number;
  job_scope_count?: number;
  job_succeeded_count?: number;
  job_failed_count?: number;
  job_offset_count?: number;
  job_per_page?: number;
  jobs?: Array<Record<string, unknown>>;
}

/** Single JSON-serializable argument for the in-page walk. */
export interface ListJobsWalkOptions {
  recipeId: number;
  limit: number;
  status: string | null;
  query: string | null;
  startedAt: string | null;
  startedFrom: string | null;
  startedTo: string | null;
  groupByMaster: boolean;
  cursor: string | null;
  budgetMs: number;
  scanBudget: number;
  stopOnErased: boolean;
  match: MatchSpec | null;
  columns: ReportColumn[];
}

export interface ListJobsWalkResult {
  ok: boolean;
  /** Matching jobs, capped at `limit`. In backend mode every scanned job matches. */
  jobs?: Array<Record<string, unknown>>;
  meta?: {
    job_count: number;
    job_scope_count: number;
    job_succeeded_count: number;
    job_failed_count: number;
  };
  scanned?: number;
  matched?: number;
  erased_seen?: number;
  from_started_at?: string;
  through_started_at?: string;
  /** Last job the walk LOOKED at, match or not. The resume cursor. */
  last_scanned_id?: string;
  complete?: boolean;
  retention_boundary_reached?: boolean;
  stopped_reason?: string;
  failure?: {
    stage: 'meta' | 'page' | 'shape' | 'match';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * In-page function. Plain function returning a Promise chain — DO NOT add
 * async/await. Recurses via .then() to walk pages.
 *
 * CRITICAL: This function is serialized via Function.prototype.toString()
 * by chrome.scripting.executeScript. Module-scope constants referenced
 * inside the function body do NOT survive serialization — they become
 * undefined in the page context. All constants and helpers must be declared
 * INSIDE the function (same class of pitfall as v1's `_pullInPage` issue).
 *
 * The local match runs HERE, per page, so a 5000-job scan crosses the page
 * boundary as a handful of matches instead of 5000 raw jobs.
 */
export function listJobsInPage(opts: ListJobsWalkOptions): Promise<ListJobsWalkResult> {
  const PER_PAGE = 25;
  const ERASED_RUN_STOP = 3;
  const recipeId = opts.recipeId;
  const limit = opts.limit;
  const scanBudget = opts.scanBudget;
  const stopOnErased = opts.stopOnErased !== false;
  const match = opts.match || null;
  const deadline =
    Date.now() + (typeof opts.budgetMs === 'number' && opts.budgetMs > 0 ? opts.budgetMs : 22000);

  let matchRegex: RegExp | null = null;
  if (match && match.mode === 'regex') {
    try {
      matchRegex = new RegExp(match.value, 'i');
    } catch (e) {
      return Promise.resolve({
        ok: false,
        failure: {
          stage: 'match' as const,
          message: `match.value is not a valid regular expression: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      });
    }
  }

  const labelToColumn: Record<string, string> = {};
  const columns = Array.isArray(opts.columns) ? opts.columns : [];
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    if (column && typeof column.name === 'string' && column.label) {
      labelToColumn[String(column.label).toLowerCase()] = column.name;
    }
  }

  function buildUrl(cursor: string | null): string {
    const params = new URLSearchParams();
    params.set('per_page', String(PER_PAGE));
    if (cursor) {
      params.set('offset_job_id', cursor);
      params.set('prev', 'false');
    }
    if (opts.status) params.set('status', opts.status);
    if (opts.query) params.set('query', opts.query);
    if (opts.startedAt) params.set('started_at', opts.startedAt);
    if (opts.startedFrom) params.set('started_at_from', opts.startedFrom);
    if (opts.startedTo) params.set('started_at_to', opts.startedTo);
    if (opts.groupByMaster) params.set('group_by_master_job', 'true');
    return `/web_api/recipes/${recipeId}/jobs.json?${params.toString()}`;
  }

  const fetchOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };

  function fetchPage(
    cursor: string | null,
  ): Promise<
    { ok: true; page: RawJobsPage } | { ok: false; failure: ListJobsWalkResult['failure'] }
  > {
    const url = buildUrl(cursor);
    return fetch(url, fetchOpts).then((r) =>
      r.text().then((bodyText) => {
        if (r.status < 200 || r.status >= 300) {
          return {
            ok: false as const,
            failure: {
              stage: 'page' as const,
              status: r.status,
              body_excerpt: bodyText.slice(0, 1024),
              message: `GET ${url} returned HTTP ${r.status}`,
            },
          };
        }
        let json: RawJobsPage;
        try {
          json = JSON.parse(bodyText) as RawJobsPage;
        } catch (e) {
          return {
            ok: false as const,
            failure: {
              stage: 'shape' as const,
              body_excerpt: bodyText.slice(0, 1024),
              message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
            },
          };
        }
        if (!Array.isArray(json.jobs)) {
          return {
            ok: false as const,
            failure: {
              stage: 'shape' as const,
              body_excerpt: bodyText.slice(0, 1024),
              message: 'Unexpected response shape — missing jobs array.',
            },
          };
        }
        return { ok: true as const, page: json };
      }),
    );
  }

  /** Every string a match field can look at on one job. */
  function valuesForField(job: Record<string, unknown>, field: string): string[] {
    const out: string[] = [];
    if (field === 'id') {
      if (job.id != null) out.push(String(job.id));
      return out;
    }
    if (field === 'title') {
      if (job.title != null) out.push(String(job.title));
      return out;
    }
    if (field === 'error') {
      const err = job.error;
      if (err && typeof err === 'object') {
        const record = err as Record<string, unknown>;
        if (record.message != null) out.push(String(record.message));
        if (record.inner_message != null) out.push(String(record.inner_message));
        if (record.error_type != null) out.push(String(record.error_type));
      }
      return out;
    }
    const report = job.report && typeof job.report === 'object' ? job.report : null;
    if (!report) return out;
    const record = report as Record<string, unknown>;
    if (field === 'report') {
      for (const key in record) {
        if (key.indexOf('custom_column_') === 0 && record[key] != null) {
          out.push(String(record[key]));
        }
      }
      return out;
    }
    if (field.indexOf('report.') === 0) {
      const wanted = field.slice(7);
      const name =
        wanted.indexOf('custom_column_') === 0 ? wanted : labelToColumn[wanted.toLowerCase()];
      if (name && record[name] != null) out.push(String(record[name]));
      return out;
    }
    return out;
  }

  function matchesJob(job: Record<string, unknown>): boolean {
    if (!match) return true;
    const fields =
      match.fields && match.fields.length ? match.fields : ['id', 'title', 'error', 'report'];
    const needle = String(match.value).toLowerCase();
    for (let i = 0; i < fields.length; i++) {
      const values = valuesForField(job, fields[i]);
      for (let j = 0; j < values.length; j++) {
        const value = values[j];
        if (match.mode === 'regex') {
          if (matchRegex && matchRegex.test(value)) return true;
        } else if (match.mode === 'exact') {
          if (value.toLowerCase() === needle) return true;
        } else if (value.toLowerCase().indexOf(needle) >= 0) {
          return true;
        }
      }
    }
    return false;
  }

  const state = {
    matched: [] as Array<Record<string, unknown>>,
    scanned: 0,
    matchedCount: 0,
    erasedSeen: 0,
    consecutiveErased: 0,
    fromStartedAt: '',
    throughStartedAt: '',
    lastScannedId: '',
    retentionBoundary: false,
    stoppedReason: 'end_of_list',
    lastPage: null as RawJobsPage | null,
  };

  /** Walk one page's jobs. Returns true when the walk must stop. */
  function consume(jobs: Array<Record<string, unknown>>): boolean {
    for (let i = 0; i < jobs.length; i++) {
      if (state.scanned >= scanBudget) {
        state.stoppedReason = 'scan_budget';
        return true;
      }
      const job = jobs[i] || {};
      state.scanned++;
      if (typeof job.id === 'string') state.lastScannedId = job.id;
      if (job.started_at != null) {
        const startedAt = String(job.started_at);
        if (!state.fromStartedAt) state.fromStartedAt = startedAt;
        state.throughStartedAt = startedAt;
      }
      if (job.erased === true) {
        state.erasedSeen++;
        state.consecutiveErased++;
      } else {
        state.consecutiveErased = 0;
      }
      if (matchesJob(job)) {
        state.matchedCount++;
        if (state.matched.length < limit) state.matched.push(job);
      }
      if (state.matched.length >= limit) {
        state.stoppedReason = 'limit';
        return true;
      }
      if (stopOnErased && state.consecutiveErased >= ERASED_RUN_STOP) {
        state.retentionBoundary = true;
        state.stoppedReason = 'erased_boundary';
        return true;
      }
    }
    return false;
  }

  function finish(complete: boolean): ListJobsWalkResult {
    const page = state.lastPage || {};
    return {
      ok: true,
      jobs: state.matched,
      meta: {
        job_count: Number(page.job_count || 0),
        job_scope_count: Number(page.job_scope_count || 0),
        job_succeeded_count: Number(page.job_succeeded_count || 0),
        job_failed_count: Number(page.job_failed_count || 0),
      },
      scanned: state.scanned,
      matched: state.matchedCount,
      erased_seen: state.erasedSeen,
      from_started_at: state.fromStartedAt || undefined,
      through_started_at: state.throughStartedAt || undefined,
      last_scanned_id: state.lastScannedId || undefined,
      // The retention boundary is the end of what can be searched at all, so it
      // counts as covered ground rather than a truncated scan.
      complete: complete || state.retentionBoundary,
      retention_boundary_reached: state.retentionBoundary,
      stopped_reason: state.stoppedReason,
    };
  }

  function loop(cursor: string | null): Promise<ListJobsWalkResult> {
    return fetchPage(cursor).then((res) => {
      if (!res.ok) {
        const failure = res.failure!;
        if (state.scanned === 0 && failure.stage === 'page') failure.stage = 'meta';
        return { ok: false, failure };
      }
      state.lastPage = res.page;
      const jobs = res.page.jobs || [];
      if (consume(jobs)) return finish(false);
      if (jobs.length < PER_PAGE) {
        state.stoppedReason = 'end_of_list';
        return finish(true);
      }
      const lastJob = jobs[jobs.length - 1];
      const nextCursor = lastJob && typeof lastJob.id === 'string' ? lastJob.id : null;
      if (!nextCursor) {
        state.stoppedReason = 'end_of_list';
        return finish(true);
      }
      if (Date.now() >= deadline) {
        state.stoppedReason = 'time_budget';
        return finish(false);
      }
      return loop(nextCursor);
    });
  }

  return loop(opts.cursor);
}

class WorkatoListJobsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.LIST_JOBS;

  async execute(args: ListJobsArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }
      const limit =
        typeof args?.limit === 'number' && Number.isFinite(args.limit) && args.limit >= 1
          ? Math.min(Math.floor(args.limit), 100)
          : 25;
      const status = typeof args?.status === 'string' && args.status ? args.status : null;
      const query = typeof args?.query === 'string' && args.query ? args.query : null;
      const startedAt =
        typeof args?.started_at === 'string' && args.started_at ? args.started_at : null;
      if (startedAt !== null && !(STARTED_AT_VALUES as readonly string[]).includes(startedAt)) {
        return createErrorResponse(
          `Param [started_at] must be one of ${STARTED_AT_VALUES.join(', ')}. Workato silently ` +
            'ignores every other value and returns the unfiltered scope, so an arbitrary window ' +
            'would read as "no such jobs". Use started_from / started_to for a custom range.',
        );
      }
      const from = normalizeStartedBound(args?.started_from, args?.timezone, 'from');
      if (!from.ok) return createErrorResponse(from.error!);
      const to = normalizeStartedBound(args?.started_to, args?.timezone, 'to');
      if (!to.ok) return createErrorResponse(to.error!);

      const matchCheck = normalizeMatchSpec(args?.match);
      if (!matchCheck.ok) return createErrorResponse(matchCheck.error!);
      const match = matchCheck.match ?? null;

      const fieldCheck = validateJobFields(args?.fields);
      if (!fieldCheck.ok) return createErrorResponse(fieldCheck.error!);
      const fields = fieldCheck.fields;

      const scanBudgetArg =
        typeof args?.scan_budget === 'number' && Number.isFinite(args.scan_budget)
          ? Math.min(Math.max(Math.floor(args.scan_budget), 1), 5000)
          : 500;
      // A scan budget below the limit could never fill it; raise it silently.
      const scanBudget = Math.max(scanBudgetArg, limit);
      const stopOnErased = args?.stop_on_erased !== false;
      const groupByMaster = args?.group_by_master_job === true;
      const cursor = typeof args?.cursor === 'string' && args.cursor ? args.cursor : null;
      const full = args?.full === true;
      const wantLabels = args?.report_labels !== false;

      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 30_000, 10_000), 110_000);
      // In-page budget: leave ~8s headroom so the walk returns partial results
      // gracefully before the outer script timeout would discard everything.
      const budgetMs = Math.max(timeoutMs - 8_000, 8_000);

      const tab = await findWorkatoTab(args.tabId);

      // Report-column labels live on the recipe trigger's job_report_schema, so
      // they come from the version-pinned recipe snapshot rather than a second
      // unpinned code fetch behind a time-based cache. The snapshot cache is
      // keyed by recipe id AND version, so a save that changes the labels can
      // never be served stale, and a repeat call costs one cheap metadata read.
      let columns: ReportColumn[] = [];
      let columnsVersion: number | null = null;
      let columnsNote: string | undefined;
      if (wantLabels) {
        try {
          const snapshot = await loadRecipeSnapshot(tab, args.recipe_id, { timeoutMs: 20_000 });
          if (snapshot.ok) {
            columns = parseReportColumns(snapshot.code);
            columnsVersion = snapshot.version.version_no;
          } else {
            columnsNote = `Report column labels unavailable: ${snapshot.error}. Columns are keyed custom_column_N.`;
          }
        } catch (err) {
          columnsNote = `Report column labels unavailable: ${
            err instanceof Error ? err.message : String(err)
          }. Columns are keyed custom_column_N.`;
        }
      }

      const walkOptions: ListJobsWalkOptions = {
        recipeId: args.recipe_id,
        limit,
        status,
        query,
        startedAt,
        startedFrom: from.value ?? null,
        startedTo: to.value ?? null,
        groupByMaster,
        cursor,
        budgetMs,
        scanBudget,
        stopOnErased,
        match,
        columns,
      };

      const { value: result, retried } = await runInWorkatoTabDetailed(
        tab.tabId,
        listJobsInPage,
        [walkOptions],
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

      const matchedJobs = result.jobs ?? [];
      const complete = result.complete === true;
      const backendFiltered = Boolean(query || status || startedAt || from.value || to.value);
      const searchMode: JobScanCoverage['search_mode'] = match
        ? backendFiltered
          ? 'both'
          : 'local'
        : 'backend';

      const coverage: JobScanCoverage = {
        search_mode: searchMode,
        scanned: result.scanned ?? 0,
        matched: result.matched ?? 0,
        erased_seen: result.erased_seen ?? 0,
        from_started_at: result.from_started_at,
        through_started_at: result.through_started_at,
        complete,
        // The resume cursor is the last job SCANNED, not the last one returned:
        // a scan that matched nothing still has to be resumable.
        next_cursor: complete ? undefined : result.last_scanned_id,
        retention_boundary_reached: result.retention_boundary_reached === true,
        stopped_reason: result.stopped_reason ?? 'end_of_list',
        scan_budget: scanBudget,
        limit,
      };

      const extras: Record<string, unknown> = {};
      if (!complete && coverage.stopped_reason === 'time_budget') {
        extras.partial = true;
        if (coverage.through_started_at) extras.scanned_through = coverage.through_started_at;
        extras.note =
          'Time budget ran out mid-walk; results cover jobs scanned so far. Resume with cursor=next_cursor.';
      }
      if (retried) extras.retried = true;
      if (columnsNote) extras.report_columns_note = columnsNote;

      let jobs: unknown[];
      if (fields) {
        jobs = matchedJobs.map((job) => projectJobFields(shapeSlimJob(job, columns), fields));
        if (full) extras.full_ignored = 'fields projection applied; full:true ignored.';
      } else if (full) {
        jobs = matchedJobs;
      } else {
        jobs = matchedJobs.map((job) => shapeSlimJob(job, columns));
      }

      const payload = {
        total: result.meta?.job_count ?? 0,
        scope: result.meta?.job_scope_count ?? 0,
        succeeded: result.meta?.job_succeeded_count ?? 0,
        failed: result.meta?.job_failed_count ?? 0,
        ...extras,
        search_mode: searchMode,
        coverage,
        summary: buildCoverageSummary(coverage),
        ...(wantLabels ? { report_columns: columns, report_columns_version: columnsVersion } : {}),
        next_cursor: coverage.next_cursor,
        jobs,
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
        `workato_list_jobs failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoListJobsTool = new WorkatoListJobsTool();
