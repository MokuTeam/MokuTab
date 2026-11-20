/**
 * workato_lcap_* — Workato Workflow App (LCAP) page tools.
 *
 * A Workflow App page is a JSON tree behind four endpoints, so the whole page
 * can be read, patched and written without touching the builder UI:
 *
 *   GET    /web_api/lcap/apps.json            list the apps in this workspace
 *   POST   /web_api/lcap/pages.json           create a page
 *   GET    /web_api/lcap/pages/<id>.json      read one
 *   PUT    /web_api/lcap/pages/<id>.json      replace its `content` (whole tree)
 *   DELETE /web_api/lcap/pages/<id>.json      delete it
 *
 * Auth is the session cookie plus `x-csrf-token` read from the XSRF-TOKEN-V2
 * cookie; there is no csrf meta tag on app.workato.com.
 *
 * The guards live in `page-checks.ts` and in `saveContent` below, because this
 * format has a failure mode that reports success everywhere: delete a widget
 * without renumbering rows and the following containers lose their computed
 * `top`, while the PUT returns ok and the GET reads back exactly what was
 * written. Static checks catch the common shape of it; the post-save render
 * probe is the only thing that actually proves the page draws.
 *
 * Format reference: skills/workato-recipes/workflow-apps.md.
 */

import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import {
  findWorkatoTab,
  runInWorkatoTab,
  workatoNotFoundHint,
  WorkatoDispatchError,
  type WorkatoTabInfo,
} from '../workato/tab-dispatch';
import { assertExpectedContext } from '../workato/session-context';
import {
  describeBrokenDatapills,
  findBrokenDatapills,
  normalizeDatapills,
} from '../workato-ui/save-guards';
import {
  buildWidgetIndex,
  checkAgainstPrevious,
  checkStructure,
  describeIssues,
  hasErrors,
  judgeRender,
  layoutEntries,
  type LcapIssue,
  type RenderCheckResult,
  type RenderedWidget,
} from './page-checks';
import type {
  LcapAppsListArgs,
  LcapPageCreateArgs,
  LcapPageDeleteArgs,
  LcapPageGetArgs,
  LcapPageSaveArgs,
  LcapPageValidateArgs,
  LcapWidgetPatchArgs,
} from './types';

// ---------------------------------------------------------------------------
// In-page fetch helpers.
//
// Each of these is serialized into the Workato tab, so it must be entirely
// self-contained: no imports, no shared helpers, and NO async/await — WXT/Vite
// rewrites async functions into hoisted helpers that do not survive
// Function.prototype.toString. Promise chains only. (See pull-recipe.ts.)
// ---------------------------------------------------------------------------

interface InPageFailure {
  stage: 'fetch' | 'shape' | 'csrf';
  status?: number;
  body_excerpt?: string;
  message: string;
}

interface PageReadResult {
  ok: boolean;
  page?: Record<string, unknown>;
  bytes?: number;
  failure?: InPageFailure;
}

interface MutateResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  body_excerpt?: string;
  failure?: InPageFailure;
}

function lcapGetPageInPage(pageId: number): Promise<PageReadResult> {
  const url = `/web_api/lcap/pages/${pageId}.json`;
  return fetch(url, {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  }).then((r) =>
    r.text().then((text) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'fetch' as const,
            status: r.status,
            body_excerpt: text.slice(0, 400),
            message: `GET ${url} returned HTTP ${r.status}`,
          },
        };
      }
      let json: { result?: Record<string, unknown> };
      try {
        json = JSON.parse(text);
      } catch (e) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: text.slice(0, 400),
            message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }
      if (!json || typeof json !== 'object' || !json.result) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: text.slice(0, 400),
            message: `GET ${url} returned no \`result\` envelope.`,
          },
        };
      }
      return { ok: true, page: json.result, bytes: text.length };
    }),
  );
}

function lcapWriteInPage(
  method: string,
  url: string,
  payload: unknown | null,
): Promise<MutateResult> {
  const cookie = document.cookie.match(/XSRF-TOKEN-V2=([^;]+)/);
  const token = cookie ? decodeURIComponent(cookie[1]) : '';
  if (!token) {
    return Promise.resolve({
      ok: false,
      failure: {
        stage: 'csrf' as const,
        message:
          'No XSRF-TOKEN-V2 cookie on this tab. Workato mutating calls need it as x-csrf-token; ' +
          'there is no csrf meta tag on app.workato.com. Is this tab logged in?',
      },
    });
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'x-csrf-token': token,
  };
  const init: RequestInit = { method, credentials: 'include', headers };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(payload);
  }
  return fetch(url, init).then((r) =>
    r.text().then((text) => {
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep the raw text */
      }
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          status: r.status,
          body_excerpt: text.slice(0, 400),
          failure: {
            stage: 'fetch' as const,
            status: r.status,
            body_excerpt: text.slice(0, 400),
            message: `${method} ${url} returned HTTP ${r.status}`,
          },
        };
      }
      return { ok: true, status: r.status, body };
    }),
  );
}

function lcapAppsListInPage(): Promise<MutateResult> {
  return fetch('/web_api/lcap/apps.json', {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  }).then((r) =>
    r.text().then((text) => {
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep the raw text */
      }
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          status: r.status,
          body_excerpt: text.slice(0, 400),
          failure: {
            stage: 'fetch' as const,
            status: r.status,
            body_excerpt: text.slice(0, 400),
            message: `GET /web_api/lcap/apps.json returned HTTP ${r.status}`,
          },
        };
      }
      return { ok: true, status: r.status, body };
    }),
  );
}

/**
 * Read the rendered geometry of the page's TOP LEVEL widgets.
 *
 * Top level only: two widgets sharing a y inside a container is a normal
 * side-by-side row, while two top level containers sharing a y is the stacking
 * bug. Waits for the first widget to appear, because the page is an SPA and an
 * empty result would otherwise read as "nothing rendered".
 */
function lcapRenderProbeInPage(timeoutMs: number): Promise<RenderedWidget[]> {
  const deadline = Date.now() + timeoutMs;

  const topLevel = (): Element[] => {
    const all = Array.prototype.slice.call(
      document.querySelectorAll('.lcap-layout__widget'),
    ) as Element[];
    return all.filter((el) => {
      let parent = el.parentElement;
      while (parent) {
        if (parent.classList && parent.classList.contains('lcap-layout__widget')) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  };

  const shape = (els: Element[]): RenderedWidget[] =>
    els.map((el) => {
      const style = el.getAttribute('style') || '';
      const rect = el.getBoundingClientRect();
      return {
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        style,
        y: Math.round(rect.top),
        has_top: /(^|;)\s*top\s*:/.test(style),
      };
    });

  const attempt = (): Promise<RenderedWidget[]> => {
    const els = topLevel();
    if (els.length > 0) return Promise.resolve(shape(els));
    if (Date.now() >= deadline) return Promise.resolve([]);
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 400);
    }).then(attempt);
  };

  return attempt();
}

// ---------------------------------------------------------------------------
// Background-side helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const RENDER_WAIT_MS = 20_000;

function clampTimeout(value: number | undefined): number {
  return Math.min(Math.max(value ?? DEFAULT_TIMEOUT_MS, 10_000), 110_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Turn an in-page failure into the message the caller sees. */
function failureText(prefix: string, failure: InPageFailure | undefined): string {
  const status = failure?.status;
  return (
    `${prefix}: ${failure?.message ?? 'unknown failure'}` +
    (status === 404
      ? ' A 404 on a /web_api/lcap/ path usually means this tab is in the wrong workspace or ' +
        'environment rather than the page being gone: Workato resolves both from the tab session. ' +
        'Confirm with workato_whoami and pin tabId + profile to a tab in the right workspace.' +
        workatoNotFoundHint(status)
      : '') +
    (failure?.body_excerpt ? `\n--- body excerpt ---\n${failure.body_excerpt}` : '')
  );
}

interface StoredPage {
  page: Record<string, unknown>;
  content: unknown;
  updatedAt: string | undefined;
}

async function readPage(tabId: number, pageId: number, timeoutMs: number): Promise<StoredPage> {
  const result = await runInWorkatoTab(tabId, lcapGetPageInPage, [pageId], { timeoutMs });
  if (!result.ok || !result.page) {
    throw new Error(failureText(`workato_lcap read of page ${pageId} failed`, result.failure));
  }
  const page = result.page;
  return {
    page,
    content: page.content,
    updatedAt: typeof page.updated_at === 'string' ? page.updated_at : undefined,
  };
}

/** Page metadata worth returning without the tree. */
function pageMeta(page: Record<string, unknown>): Record<string, unknown> {
  const content = isRecord(page.content) ? page.content : {};
  const variables = Array.isArray(content.variables) ? content.variables : [];
  const handlers = isRecord(content.handlers) ? content.handlers : {};
  return {
    page_id: page.id,
    name: page.name,
    path: page.path,
    folder_id: page.folder_id,
    project_id: page.project_id,
    updated_at: page.updated_at,
    max_width: content.maxWidth,
    spacing: content.spacing,
    variables: variables.map((v) =>
      isRecord(v) ? { id: v.id, name: v.name, dataType: v.dataType } : v,
    ),
    page_load_handler: isRecord(handlers.pageLoad)
      ? handlers.pageLoad.type
      : (handlers.pageLoad ?? null),
  };
}

/**
 * Find tabs sitting on this page's builder.
 *
 * `https://app.workato.com/lcap/pages/<id>` is the builder, and its Save
 * writes its own cached tree over anything the API wrote in the meantime —
 * the same trap as saving a recipe while its editor is open.
 */
async function findBuilderTabs(pageId: number): Promise<Array<{ id: number; url: string }>> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({
      url: ['*://*.workato.com/lcap/pages/*', '*://*.workato.is/lcap/pages/*'],
    });
  } catch {
    return [];
  }
  const wanted = new RegExp(`/lcap/pages/${pageId}(?:[/?#]|$)`);
  return tabs
    .filter((t) => typeof t.id === 'number' && typeof t.url === 'string' && wanted.test(t.url))
    .map((t) => ({ id: t.id as number, url: t.url as string }));
}

/**
 * Wait until a freshly created tab has finished loading.
 *
 * Without this the probe can be injected while the tab is still on about:blank,
 * where it would wait out its whole window and report "nothing rendered" for a
 * page that is fine.
 */
async function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status: string | undefined;
    try {
      status = (await chrome.tabs.get(tabId)).status;
    } catch {
      return; // tab went away; the probe will report what it finds
    }
    if (status === 'complete' || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Open the page in a background tab, read its geometry, close the tab.
 *
 * Run after the PUT: the JSON is valid in the stacking failure, so rendering
 * is the only evidence that the save produced a page that draws.
 */
async function runRenderCheck(
  tab: WorkatoTabInfo,
  pageId: number,
): Promise<{ result: RenderCheckResult; note?: string }> {
  let probeTabId: number | undefined;
  try {
    const created = await chrome.tabs.create({
      url: `${tab.origin}/lcap/pages/${pageId}`,
      active: false,
    });
    probeTabId = created.id;
    if (typeof probeTabId === 'number') await waitForTabLoad(probeTabId, 15_000);
    if (typeof probeTabId !== 'number') {
      return {
        result: { status: 'failed', widget_count: 0, issues: ['Could not open a probe tab.'] },
      };
    }
    const widgets = await runInWorkatoTab(probeTabId, lcapRenderProbeInPage, [RENDER_WAIT_MS], {
      timeoutMs: RENDER_WAIT_MS + 10_000,
      retryOnTimeout: false,
    });
    if (widgets.length === 0) {
      return {
        result: {
          status: 'failed',
          widget_count: 0,
          issues: [
            'No .lcap-layout__widget elements appeared within the wait window. The page may be ' +
              'empty, still loading, or this tab may be in the wrong workspace.',
          ],
        },
      };
    }
    return { result: judgeRender(widgets) };
  } finally {
    if (typeof probeTabId === 'number') {
      try {
        await chrome.tabs.remove(probeTabId);
      } catch {
        /* the tab may already be gone */
      }
    }
  }
}

interface SaveOutcome {
  payload: Record<string, unknown>;
}

/**
 * The write path shared by `workato_lcap_page_save` and
 * `workato_lcap_widget_patch`: guard, PUT, verify, render-check.
 */
async function saveContent(
  tab: WorkatoTabInfo,
  args: {
    pageId: number;
    content: unknown;
    stored: StoredPage;
    expectedUpdatedAt?: string;
    allowWidgetRemoval?: boolean;
    allowRowCollapse?: boolean;
    force?: boolean;
    skipRenderCheck?: boolean;
    timeoutMs: number;
  },
): Promise<SaveOutcome | { error: string }> {
  const { pageId, content, stored, timeoutMs } = args;

  // 1. Builder-open guard.
  const builderTabs = await findBuilderTabs(pageId);
  if (builderTabs.length > 0 && !args.force) {
    return {
      error:
        `Refusing to save: the page builder is open on page ${pageId} in tab ` +
        `${builderTabs.map((t) => `${t.id} (${t.url})`).join(', ')}. Its Save writes the ` +
        'builder\'s cached tree over whatever the API wrote, so the symptom is "the save ' +
        'succeeded and then my changes vanished". Close or navigate that tab, or pass ' +
        'force:true if you are sure nobody will press Save there.',
    };
  }

  // 2. Optimistic lock.
  if (args.expectedUpdatedAt && stored.updatedAt !== args.expectedUpdatedAt) {
    return {
      error:
        `Refusing to save: expected_updated_at ${args.expectedUpdatedAt} but the stored page ` +
        `reports ${stored.updatedAt}. Someone (or the builder) saved since you read it. Re-read ` +
        'with workato_lcap_page_get and reapply your change.',
    };
  }

  // 3. Static checks.
  const issues: LcapIssue[] = [
    ...checkStructure(content),
    ...checkAgainstPrevious(stored.content, content, {
      allowWidgetRemoval: args.allowWidgetRemoval,
      allowRowCollapse: args.allowRowCollapse,
    }),
  ];
  if (hasErrors(issues)) {
    return {
      error:
        `Refusing to save page ${pageId}: ${issues.filter((i) => i.severity === 'error').length} ` +
        `blocking issue(s).\n${describeIssues(issues)}`,
    };
  }

  // 4. Datapill hygiene. A payload that is not JSON would be stored happily and
  //    resolve to nothing at runtime, so it is a refusal, not a warning.
  const broken = findBrokenDatapills(content);
  if (broken.length > 0) {
    return { error: describeBrokenDatapills(broken) };
  }
  const normalized = normalizeDatapills(content);

  // 5. Write. No auto-retry: a repeated PUT is a second write.
  let putResult: MutateResult;
  let saveStatus = 'succeeded';
  try {
    putResult = await runInWorkatoTab(
      tab.tabId,
      lcapWriteInPage,
      [
        'PUT',
        `/web_api/lcap/pages/${pageId}.json`,
        { page: { id: pageId, content: normalized.value } },
      ],
      { timeoutMs, retryOnTimeout: false },
    );
  } catch (err) {
    // A timeout is not proof the write failed. Read the page back and let the
    // stored updated_at decide, rather than reporting a false failure.
    const after = await readPage(tab.tabId, pageId, timeoutMs).catch(() => null);
    if (after && after.updatedAt && after.updatedAt !== stored.updatedAt) {
      putResult = { ok: true, status: 200, body: { result: 'ok' } };
      saveStatus = 'succeeded_after_timeout';
    } else {
      throw err;
    }
  }
  if (!putResult.ok) {
    return { error: failureText(`Saving page ${pageId} failed`, putResult.failure) };
  }

  // 6. Read back the stored updated_at so the caller can pass it as the next
  //    optimistic lock without a second call.
  const after = await readPage(tab.tabId, pageId, timeoutMs).catch(() => null);

  const payload: Record<string, unknown> = {
    page_id: pageId,
    save_status: saveStatus,
    updated_at: after?.updatedAt ?? null,
    previous_updated_at: stored.updatedAt ?? null,
    normalized_datapills: normalized.normalized,
    warnings: issues.filter((i) => i.severity === 'warning'),
  };

  // 7. Render check.
  if (args.skipRenderCheck) {
    payload.render_check = 'skipped';
  } else {
    const check = await runRenderCheck(tab, pageId);
    payload.render_check = check.result.status;
    payload.render_widget_count = check.result.widget_count;
    if (check.result.status === 'failed') {
      payload.render_issues = check.result.issues;
      payload.render_warning =
        'THE PAGE SAVED BUT DOES NOT DRAW CORRECTLY. The JSON is valid in this failure mode, so ' +
        'nothing else will report it. Fix the row numbering and save again, or restore the ' +
        'previous tree.';
    }
  }
  return { payload };
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function toolError(err: unknown, tool: string): ToolResult {
  if (err instanceof WorkatoDispatchError) {
    return createErrorResponse(
      `${err.message}` +
        (err.code === 'TabNotFound'
          ? ' Note: an omitted `profile` resolves against the default Chrome profile, which ' +
            'reports TabNotFound for a tab that exists under another profile. Pass tabId AND ' +
            'profile together.'
          : ''),
    );
  }
  return createErrorResponse(`${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

class WorkatoLcapAppsListTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO_LCAP.APPS_LIST;

  async execute(args: LcapAppsListArgs = {}): Promise<ToolResult> {
    try {
      const tab = await findWorkatoTab(args.tabId);
      const result = await runInWorkatoTab(tab.tabId, lcapAppsListInPage, [], {
        timeoutMs: clampTimeout(args.timeout_ms),
      });
      if (!result.ok) {
        return createErrorResponse(failureText('workato_lcap_apps_list failed', result.failure));
      }
      const body = result.body as { result?: unknown };
      const apps = Array.isArray(body?.result) ? body.result : [];
      return ok({
        app_count: apps.length,
        apps: apps.map((app) =>
          isRecord(app)
            ? {
                id: app.id,
                name: app.name,
                project_id: app.project_id,
                unique_id: app.unique_id,
                live: app.live,
              }
            : app,
        ),
      });
    } catch (err) {
      return toolError(err, 'workato_lcap_apps_list');
    }
  }
}

class WorkatoLcapPageGetTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO_LCAP.PAGE_GET;

  async execute(args: LcapPageGetArgs): Promise<ToolResult> {
    try {
      if (typeof args?.page_id !== 'number' || !Number.isFinite(args.page_id)) {
        return createErrorResponse('Param [page_id] must be a finite number');
      }
      const tab = await findWorkatoTab(args.tabId);
      const stored = await readPage(tab.tabId, args.page_id, clampTimeout(args.timeout_ms));
      const index = buildWidgetIndex(stored.content);
      const payload: Record<string, unknown> = {
        ...pageMeta(stored.page),
        widget_count: index.length,
        widgets: index,
      };
      if (args.view === 'full') payload.content = stored.content;
      return ok(payload);
    } catch (err) {
      return toolError(err, 'workato_lcap_page_get');
    }
  }
}

class WorkatoLcapPageSaveTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO_LCAP.PAGE_SAVE;

  async execute(args: LcapPageSaveArgs): Promise<ToolResult> {
    try {
      if (typeof args?.page_id !== 'number' || !Number.isFinite(args.page_id)) {
        return createErrorResponse('Param [page_id] must be a finite number');
      }
      if (args.content === undefined) {
        return createErrorResponse(
          'Param [content] is required (or [content_path], which the native-server resolves ' +
            'into it). A page save replaces the whole `content` tree — there is no partial update.',
        );
      }
      const timeoutMs = clampTimeout(args.timeout_ms);
      const tab = await findWorkatoTab(args.tabId);
      await assertExpectedContext(args, tab.tabId);
      const stored = await readPage(tab.tabId, args.page_id, timeoutMs);

      const outcome = await saveContent(tab, {
        pageId: args.page_id,
        content: args.content,
        stored,
        expectedUpdatedAt: args.expected_updated_at,
        allowWidgetRemoval: args.allow_widget_removal,
        allowRowCollapse: args.allow_row_collapse,
        force: args.force,
        skipRenderCheck: args.skip_render_check,
        timeoutMs,
      });
      if ('error' in outcome) return createErrorResponse(outcome.error);
      return ok(outcome.payload);
    } catch (err) {
      return toolError(err, 'workato_lcap_page_save');
    }
  }
}

class WorkatoLcapPageValidateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO_LCAP.PAGE_VALIDATE;

  async execute(args: LcapPageValidateArgs): Promise<ToolResult> {
    try {
      const hasContent = args?.content !== undefined;
      if (typeof args?.page_id !== 'number' && !hasContent) {
        return createErrorResponse(
          'Pass [page_id] to validate the stored page (static checks plus a render probe), or ' +
            '[content] / [content_path] to validate a tree in hand (static checks only).',
        );
      }

      // Content in hand: static checks only, no browser needed beyond nothing.
      if (hasContent && typeof args.page_id !== 'number') {
        const issues = checkStructure(args.content);
        const broken = findBrokenDatapills(args.content);
        return ok({
          ok: !hasErrors(issues) && broken.length === 0,
          mode: 'content',
          issues,
          broken_datapills: broken,
          widget_count: buildWidgetIndex(args.content).length,
          note: 'Static checks only. A render probe needs the page to exist server side.',
        });
      }

      const timeoutMs = clampTimeout(args.timeout_ms);
      const tab = await findWorkatoTab(args.tabId);
      const pageId = args.page_id as number;
      const stored = await readPage(tab.tabId, pageId, timeoutMs);
      const target = hasContent ? args.content : stored.content;
      const issues = checkStructure(target);
      if (hasContent) {
        issues.push(...checkAgainstPrevious(stored.content, target));
      }
      const broken = findBrokenDatapills(target);
      const render = await runRenderCheck(tab, pageId);
      const builderTabs = await findBuilderTabs(pageId);

      return ok({
        ok: !hasErrors(issues) && broken.length === 0 && render.result.status === 'passed',
        mode: hasContent ? 'page+content' : 'page',
        page_id: pageId,
        updated_at: stored.updatedAt,
        issues,
        broken_datapills: broken,
        render_check: render.result.status,
        render_issues: render.result.issues,
        render_widget_count: render.result.widget_count,
        builder_open_in_tabs: builderTabs.map((t) => t.id),
      });
    } catch (err) {
      return toolError(err, 'workato_lcap_page_validate');
    }
  }
}

/**
 * Presentational properties `workato_lcap_widget_patch` will write.
 *
 * Deliberately excludes everything that carries a binding or an address:
 * `id`, `type`, `handlers`, `appFunctionOptions`, `visible`, `layout`,
 * `dataSource`. Most polish work is exactly this list, and doing it through a
 * whole-tree rewrite is what creates the chance to break the layout.
 */
export const ALLOWED_WIDGET_PROPS = new Set([
  'label',
  'hint',
  'placeholder',
  'text',
  'alignment',
  'color',
  'title',
  'description',
  'x',
  'width',
  'displayedRowsCount',
  'allowRowCreation',
  'allowRowDeletion',
  'forbidEmptyRows',
  'addRowButtonText',
  'columnsSettings',
  'options',
  'enabled',
  'style',
  'padding',
  'margin',
  'backgroundColor',
  'borderColor',
  'pillsSupportMarkdown',
  'multiValue',
  'editable',
  'name',
]);

/** Properties the patch tool refuses outright, with the reason. */
const FORBIDDEN_WIDGET_PROPS: Record<string, string> = {
  id: 'a widget id is the address every datapill uses; changing it silently empties every pill pointing at it',
  type: 'changing a widget type invalidates the rest of its properties',
  handlers: 'use a full page save for handler wiring, so the diff guards run over the result',
  appFunctionOptions: 'recipe bindings belong in a reviewed full-tree save',
  visible:
    'conditional visibility is an opcode expression; write it with a full page save so it is validated',
  layout: 'row numbering is what the geometry guards exist for; move widgets with a full page save',
  dataSource: 'no populated example of this family has ever been observed',
  validations: 'validation rules change submission behaviour, not presentation',
};

class WorkatoLcapWidgetPatchTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO_LCAP.WIDGET_PATCH;

  async execute(args: LcapWidgetPatchArgs): Promise<ToolResult> {
    try {
      if (typeof args?.page_id !== 'number' || !Number.isFinite(args.page_id)) {
        return createErrorResponse('Param [page_id] must be a finite number');
      }
      if (typeof args?.widget_id !== 'string' || args.widget_id.length === 0) {
        return createErrorResponse("Param [widget_id] must be the widget's 8-hex id");
      }
      if (!isRecord(args?.props) || Object.keys(args.props).length === 0) {
        return createErrorResponse('Param [props] must be a non-empty object of properties to set');
      }

      const forbidden = Object.keys(args.props).filter((k) => k in FORBIDDEN_WIDGET_PROPS);
      if (forbidden.length > 0) {
        return createErrorResponse(
          `workato_lcap_widget_patch refuses these properties:\n` +
            forbidden.map((k) => `  ${k}: ${FORBIDDEN_WIDGET_PROPS[k]}`).join('\n') +
            '\nUse workato_lcap_page_save for structural or binding changes.',
        );
      }
      const unknown = Object.keys(args.props).filter((k) => !ALLOWED_WIDGET_PROPS.has(k));
      if (unknown.length > 0) {
        return createErrorResponse(
          `workato_lcap_widget_patch does not know these properties: ${unknown.join(', ')}. ` +
            `Allowed: ${[...ALLOWED_WIDGET_PROPS].sort().join(', ')}. Use ` +
            'workato_lcap_page_save for anything outside that list.',
        );
      }

      const timeoutMs = clampTimeout(args.timeout_ms);
      const tab = await findWorkatoTab(args.tabId);
      await assertExpectedContext(args, tab.tabId);
      const stored = await readPage(tab.tabId, args.page_id, timeoutMs);

      // Deep clone so the stored tree stays intact for the diff guards.
      const next = JSON.parse(JSON.stringify(stored.content ?? {}));
      const target = findWidget(next, args.widget_id);
      if (!target) {
        const known = buildWidgetIndex(stored.content)
          .map((w) => `${w.id} (${w.type})`)
          .join(', ');
        return createErrorResponse(
          `Widget ${args.widget_id} is not on page ${args.page_id}. Widgets here: ${known}`,
        );
      }
      const before: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args.props)) {
        before[key] = target[key];
        target[key] = value;
      }

      const outcome = await saveContent(tab, {
        pageId: args.page_id,
        content: next,
        stored,
        expectedUpdatedAt: args.expected_updated_at,
        force: args.force,
        skipRenderCheck: args.skip_render_check,
        timeoutMs,
      });
      if ('error' in outcome) return createErrorResponse(outcome.error);
      return ok({
        ...outcome.payload,
        widget_id: args.widget_id,
        changed: Object.keys(args.props),
        previous_values: before,
      });
    } catch (err) {
      return toolError(err, 'workato_lcap_widget_patch');
    }
  }
}

/** Locate a widget node inside a page tree by id, containers included. */
function findWidget(content: unknown, widgetId: string): Record<string, unknown> | null {
  const search = (layout: unknown): Record<string, unknown> | null => {
    for (const { widget } of layoutEntries(layout)) {
      if (widget.id === widgetId) return widget;
      if (widget.type === 'container') {
        const nested = search(widget.layout);
        if (nested) return nested;
      }
    }
    return null;
  };
  return search(isRecord(content) ? content.layout : undefined);
}

/** A valid, empty page. */
const EMPTY_PAGE_CONTENT = {
  type: 'common',
  maxWidth: 'fixed',
  spacing: 'standard',
  background: { style: 'color', color: '#fafbfc' },
  variables: [],
  handlers: { pageLoad: null },
  layout: [1],
};

class WorkatoLcapPageCreateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO_LCAP.PAGE_CREATE;

  async execute(args: LcapPageCreateArgs): Promise<ToolResult> {
    try {
      if (typeof args?.folder_id !== 'number' || !Number.isFinite(args.folder_id)) {
        return createErrorResponse(
          'Param [folder_id] must be the numeric id of the Workflow App folder to create in',
        );
      }
      if (typeof args?.name !== 'string' || args.name.length === 0) {
        return createErrorResponse('Param [name] must be a non-empty page name');
      }
      const content = args.content === undefined ? EMPTY_PAGE_CONTENT : args.content;
      const issues = checkStructure(content);
      if (hasErrors(issues)) {
        return createErrorResponse(
          `Refusing to create the page: the supplied content is invalid.\n${describeIssues(issues)}`,
        );
      }
      const broken = findBrokenDatapills(content);
      if (broken.length > 0) return createErrorResponse(describeBrokenDatapills(broken));
      const normalized = normalizeDatapills(content);

      const tab = await findWorkatoTab(args.tabId);
      await assertExpectedContext(args, tab.tabId);
      const result = await runInWorkatoTab(
        tab.tabId,
        lcapWriteInPage,
        [
          'POST',
          '/web_api/lcap/pages.json',
          {
            page: {
              folder_id: args.folder_id,
              name: args.name,
              path: args.path ?? args.name,
              content: normalized.value,
            },
          },
        ],
        { timeoutMs: clampTimeout(args.timeout_ms), retryOnTimeout: false },
      );
      if (!result.ok) {
        return createErrorResponse(failureText('workato_lcap_page_create failed', result.failure));
      }
      const body = result.body as { result?: Record<string, unknown> };
      const page = isRecord(body?.result) ? body.result : {};
      return ok({
        page_id: page.id,
        name: page.name,
        path: page.path,
        folder_id: page.folder_id,
        updated_at: page.updated_at,
        builder_url:
          typeof page.id === 'number' ? `${tab.origin}/lcap/pages/${page.id}` : undefined,
        note: 'Workato regenerates `path` from `name`, so the path you passed is advisory.',
      });
    } catch (err) {
      return toolError(err, 'workato_lcap_page_create');
    }
  }
}

class WorkatoLcapPageDeleteTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO_LCAP.PAGE_DELETE;

  async execute(args: LcapPageDeleteArgs): Promise<ToolResult> {
    try {
      if (typeof args?.page_id !== 'number' || !Number.isFinite(args.page_id)) {
        return createErrorResponse('Param [page_id] must be a finite number');
      }
      if (args.confirm !== true) {
        return createErrorResponse(
          `Refusing to delete page ${args.page_id}: pass confirm:true. There is no undo, and a ` +
            'deleted page takes its widget ids with it, so anything bound to them is gone too. ' +
            'Only call this when the user explicitly asked for the deletion.',
        );
      }
      const timeoutMs = clampTimeout(args.timeout_ms);
      const tab = await findWorkatoTab(args.tabId);
      await assertExpectedContext(args, tab.tabId);
      // Read first so the response can name what was deleted.
      const stored = await readPage(tab.tabId, args.page_id, timeoutMs).catch(() => null);

      const result = await runInWorkatoTab(
        tab.tabId,
        lcapWriteInPage,
        ['DELETE', `/web_api/lcap/pages/${args.page_id}.json`, null],
        { timeoutMs, retryOnTimeout: false },
      );
      if (!result.ok) {
        return createErrorResponse(
          failureText(`Deleting page ${args.page_id} failed`, result.failure),
        );
      }
      return ok({
        page_id: args.page_id,
        deleted: true,
        name: stored?.page.name,
        widget_count: stored ? buildWidgetIndex(stored.content).length : undefined,
      });
    } catch (err) {
      return toolError(err, 'workato_lcap_page_delete');
    }
  }
}

export const workatoLcapAppsListTool = new WorkatoLcapAppsListTool();
export const workatoLcapPageGetTool = new WorkatoLcapPageGetTool();
export const workatoLcapPageSaveTool = new WorkatoLcapPageSaveTool();
export const workatoLcapPageValidateTool = new WorkatoLcapPageValidateTool();
export const workatoLcapWidgetPatchTool = new WorkatoLcapWidgetPatchTool();
export const workatoLcapPageCreateTool = new WorkatoLcapPageCreateTool();
export const workatoLcapPageDeleteTool = new WorkatoLcapPageDeleteTool();
