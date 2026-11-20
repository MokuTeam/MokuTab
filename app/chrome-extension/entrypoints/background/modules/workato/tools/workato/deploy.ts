import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { assertExpectedContext, type ExpectedTabContext } from './session-context';
import { fetchFoldersInPage, findFolderNode, type RawFolderNode } from './folders';
import { readAuthUser } from './switch-environment';
import {
  decideRun,
  diffDeployRecipe,
  joinPlan,
  resolveEnvironment,
  selectManifest,
  UNCHANGED_STATES,
  type AssetSelection,
  type DiffAsset,
  type EnvironmentRef,
  type ManifestAsset,
  type RecipeDeployDiff,
} from './deploy-logic';

/**
 * Deployment tools: workato_deployments_list, workato_deploy_plan,
 * workato_deploy_run.
 *
 * Endpoints captured live 2026-09-29 (Legacy, Dev 8070978 -> Prod 8070980,
 * deployment 313765). Both "Deploy to" buttons, the project's and the recipe's,
 * drive the same project-level flow:
 *   GET  /web_api/project_folders/<root>/deployable_environments.json
 *   GET  /web_api/project_folders/<root>/project_builds.json?page=N&created_at_to=<iso>
 *   POST /web_api/project_folders/<root>/deployments.json {title,description,reviewer_ids,environment_id}  -> draft
 *   PUT  /web_api/deployments/<id>.json {manifest}                       (which assets, `checked`)
 *   PUT  /web_api/deployments/<id>/start_diff_calculation.json {include_tags}
 *   GET  /web_api/deployments/<id>.json                                  (poll; manifest_with_diff)
 *   GET  /recipes/compare?v1=<rid>:deployment_id:<id>&v2=<rid>:version_no:last
 *   PUT  /web_api/deployments/<id>.json {title,description,reviewer_ids,environment_id}
 *   PUT  /web_api/deployments/<id>/start_deploy.json {include_tags, retry_deploy}
 * A running target recipe makes start_deploy end in deploy_failed "Recipes
 * require action: stop"; retry_deploy:true is the UI's "Stop recipes and
 * continue deploying" (Workato stops, deploys and restarts them).
 */

const POLL_INTERVAL_MS = 2_500;
const DIFF_TIMEOUT_MS = 60_000;
const RUN_DEFAULT_TIMEOUT_MS = 90_000;
const RUN_MAX_TIMEOUT_MS = 110_000;
const MAX_STEP_DIFF_RECIPES = 10;

interface DeployRequestResult {
  ok: boolean;
  status: number;
  json?: any;
  body_excerpt?: string;
  message?: string;
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based.
 * One JSON request against the app with the page's session; writes carry the
 * CSRF token the way the app sends it.
 */
export function deployRequestInPage(
  method: string,
  path: string,
  body: unknown,
): Promise<DeployRequestResult> {
  function readCookie(n: string): string | null {
    const escaped = n.replace(/[-.+*]/g, '\\$&');
    const m = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-requested-with': 'XMLHttpRequest',
  };
  if (method !== 'GET') {
    let csrf = readCookie('XSRF-TOKEN-V2') || readCookie('XSRF-TOKEN') || readCookie('csrf-token');
    if (!csrf) {
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      csrf = csrfMeta && csrfMeta.getAttribute('content');
    }
    if (!csrf) {
      return Promise.resolve({
        ok: false,
        status: 0,
        message: 'could not find a CSRF token; ensure the tab is a logged-in Workato page',
      });
    }
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = csrf;
  }
  return fetch(path, {
    method: method,
    credentials: 'include',
    headers: headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  }).then((r) =>
    r.text().then((text) => {
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      const ok = r.status >= 200 && r.status < 300;
      return {
        ok: ok,
        status: r.status,
        json: json,
        body_excerpt: ok ? undefined : text.slice(0, 1024),
        message: ok ? undefined : `${method} ${path} returned HTTP ${r.status}`,
      };
    }),
  );
}

class DeployApiError extends Error {}

async function request(
  tabId: number,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await runInWorkatoTab(tabId, deployRequestInPage, [method, path, body ?? null], {
    // Writes are never auto-retried: a second POST would open a second draft.
    retryOnTimeout: method === 'GET',
  });
  if (!res.ok) {
    throw new DeployApiError(
      `${res.message ?? `${method} ${path} failed`}` +
        (res.body_excerpt ? `\n--- body excerpt ---\n${res.body_excerpt}` : ''),
    );
  }
  return res.json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(err: unknown): string {
  if (err instanceof WorkatoDispatchError) return `${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function textResult(summary: string, payload: unknown, isError = false): ToolResult {
  return { content: [{ type: 'text', text: `${summary}\n${JSON.stringify(payload)}` }], isError };
}

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

interface ProjectRoot {
  folder_id: number;
  name: string;
  project_id: string | null;
}

function rootOf(roots: RawFolderNode[], folderId: number): RawFolderNode | null {
  for (const root of roots) {
    if (root.id === folderId || findFolderNode(root.children ?? [], folderId)) return root;
  }
  return null;
}

async function recipeFolderId(
  tabId: number,
  recipeId: number,
): Promise<{ folderId: number; name: string }> {
  const json = await request(tabId, 'GET', `/recipes/${recipeId}.json`);
  const flow = json?.result?.recipe_data?.flow;
  const folderId = flow?.folder_id;
  if (typeof folderId !== 'number') {
    throw new DeployApiError(`Recipe ${recipeId} came back without a folder_id.`);
  }
  return { folderId, name: String(flow?.name ?? '') };
}

/**
 * The project ROOT folder for a recipe, a folder or a project name/id: the
 * deployment endpoints are keyed by it.
 */
/** Names the tab's environment when a lookup fails: the usual cause is planning from the target env. */
async function environmentHint(tabId: number): Promise<string> {
  try {
    const auth = await readAuthUser(tabId);
    return (
      ` The tab is in ${auth.workspace?.name ?? '?'} / ${auth.environment?.name ?? '?'}; a deployment is ` +
      'planned from the SOURCE environment where the project is developed (switch with workato_switch_environment).'
    );
  } catch {
    return '';
  }
}

async function resolveProjectRoot(
  tabId: number,
  args: { recipe_id?: number; folder_id?: number; project?: string | number },
): Promise<ProjectRoot & { recipe_name?: string }> {
  const tree = await runInWorkatoTab(tabId, fetchFoldersInPage, []);
  if (!tree.ok || !tree.raw) {
    throw new DeployApiError(`folder tree fetch failed: ${tree.failure?.message ?? 'unknown'}`);
  }
  const roots = tree.raw.folders;
  const toRoot = (node: RawFolderNode): ProjectRoot => ({
    folder_id: node.id,
    name: node.name,
    project_id: node.project_id != null ? String(node.project_id) : null,
  });

  if (typeof args.recipe_id === 'number') {
    const { folderId, name } = await recipeFolderId(tabId, args.recipe_id);
    const root = rootOf(roots, folderId);
    if (!root) {
      throw new DeployApiError(
        `Recipe ${args.recipe_id} sits in folder ${folderId}, which is in no project of this workspace/environment.` +
          (await environmentHint(tabId)),
      );
    }
    return { ...toRoot(root), recipe_name: name };
  }
  if (typeof args.folder_id === 'number') {
    const root = rootOf(roots, args.folder_id);
    if (!root) {
      throw new DeployApiError(
        `Folder ${args.folder_id} is in no project of this workspace/environment (see workato_list_folders).` +
          (await environmentHint(tabId)),
      );
    }
    return toRoot(root);
  }
  const wanted = String(args.project ?? '').toLowerCase();
  const hits = roots.filter(
    (f) => String(f.project_id ?? '') === wanted || f.name.toLowerCase() === wanted,
  );
  if (hits.length !== 1) {
    throw new DeployApiError(
      `${hits.length === 0 ? 'No' : 'More than one'} project matched "${args.project}". Projects: ` +
        roots.map((f) => `${f.name} (project_id ${f.project_id}, folder ${f.id})`).join(', '),
    );
  }
  return toRoot(hits[0]);
}

function hasTarget(args: { recipe_id?: unknown; folder_id?: unknown; project?: unknown }): boolean {
  return (
    typeof args?.recipe_id === 'number' ||
    typeof args?.folder_id === 'number' ||
    (args?.project !== undefined && args.project !== null && args.project !== '')
  );
}

function toEnvList(json: any): EnvironmentRef[] {
  const list = Array.isArray(json?.result) ? json.result : [];
  return list
    .filter((e: any) => e && typeof e.id === 'number')
    .map((e: any) => ({ id: e.id, name: String(e.name ?? ''), type: String(e.type ?? '') }));
}

// ---------------------------------------------------------------------------
// workato_deployments_list
// ---------------------------------------------------------------------------

interface ListArgs {
  recipe_id?: number;
  folder_id?: number;
  project?: string | number;
  page?: number;
  tabId?: number;
}

class WorkatoDeploymentsListTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.DEPLOYMENTS_LIST;

  async execute(args: ListArgs): Promise<ToolResult> {
    try {
      if (!hasTarget(args)) {
        return createErrorResponse('Pass [recipe_id], [folder_id] or [project].');
      }
      const tab = await findWorkatoTab(args.tabId);
      const project = await resolveProjectRoot(tab.tabId, args);
      const page = typeof args.page === 'number' && args.page >= 1 ? Math.floor(args.page) : 1;
      const createdTo = new Date(Date.now() + 86_400_000).toISOString();
      const [envs, builds] = await Promise.all([
        request(
          tab.tabId,
          'GET',
          `/web_api/project_folders/${project.folder_id}/deployable_environments.json`,
        ),
        request(
          tab.tabId,
          'GET',
          `/web_api/project_folders/${project.folder_id}/project_builds.json?page=${page}` +
            `&created_at_to=${encodeURIComponent(createdTo)}`,
        ),
      ]);
      const result = builds?.result ?? {};
      const items = (Array.isArray(result.items) ? result.items : []).map((b: any) => ({
        id: b.id,
        deployment_id: b.deployment_id ?? null,
        title: b.title ?? null,
        state: b.state ?? null,
        error: b.error ?? null,
        environment_id: b.environment_id ?? null,
        environment_name: b.environment_name ?? null,
        environment_type: b.environment_type ?? null,
        created_at: b.created_at ?? null,
        updated_at: b.updated_at ?? null,
        performed_by: b.performed_by_user?.name ?? null,
        zip_file_name: b.zip_file_name ?? null,
      }));
      const payload = {
        project,
        deployable_environments: toEnvList(envs),
        page: result.page ?? page,
        per_page: result.per_page ?? null,
        count: result.count ?? items.length,
        total: result.total ?? null,
        items,
      };
      return textResult(
        `${items.length} deployment(s) of project "${project.name}" (page ${payload.page}, total ${payload.total ?? '?'})`,
        payload,
      );
    } catch (err) {
      return createErrorResponse(`workato_deployments_list failed: ${errorText(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// workato_deploy_plan
// ---------------------------------------------------------------------------

interface PlanArgs {
  recipe_id?: number;
  folder_id?: number;
  project?: string | number;
  environment?: string | number;
  assets?: AssetSelection;
  include?: number[];
  exclude?: number[];
  include_step_diff?: boolean;
  include_tags?: boolean;
  tabId?: number;
  expected_context?: ExpectedTabContext;
}

async function pollDeployment(
  tabId: number,
  deploymentId: number,
  done: (dep: any) => boolean,
  timeoutMs: number,
): Promise<{ dep: any; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let dep = (await request(tabId, 'GET', `/web_api/deployments/${deploymentId}.json`))?.result;
  while (!done(dep) && Date.now() + POLL_INTERVAL_MS < deadline) {
    await sleep(POLL_INTERVAL_MS);
    dep = (await request(tabId, 'GET', `/web_api/deployments/${deploymentId}.json`))?.result;
  }
  return { dep, timedOut: !done(dep) };
}

function environmentOf(dep: any, envs: EnvironmentRef[] = []): EnvironmentRef | { id: number } {
  const hit = envs.find((e) => e.id === dep?.environment_id);
  return hit ?? { id: dep?.environment_id };
}

class WorkatoDeployPlanTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.DEPLOY_PLAN;

  async execute(args: PlanArgs): Promise<ToolResult> {
    let deploymentId: number | null = null;
    try {
      if (!hasTarget(args)) {
        return createErrorResponse('Pass [recipe_id], [folder_id] or [project].');
      }
      if (args.environment === undefined || args.environment === null || args.environment === '') {
        return createErrorResponse(
          'Param [environment] is required: the TARGET (test, prod, a name or an id).',
        );
      }
      const mode: AssetSelection =
        args.assets ?? (typeof args.recipe_id === 'number' ? 'recipe_with_deps' : 'all');
      if (mode !== 'recipe_with_deps' && mode !== 'all') {
        return createErrorResponse('Param [assets] must be "recipe_with_deps" or "all".');
      }
      if (mode === 'recipe_with_deps' && typeof args.recipe_id !== 'number') {
        return createErrorResponse('assets:"recipe_with_deps" needs [recipe_id].');
      }

      const tab = await findWorkatoTab(args.tabId);
      await assertExpectedContext(args, tab.tabId);
      const project = await resolveProjectRoot(tab.tabId, args);
      const auth = await readAuthUser(tab.tabId);
      const envs = toEnvList(
        await request(
          tab.tabId,
          'GET',
          `/web_api/project_folders/${project.folder_id}/deployable_environments.json`,
        ),
      );
      const target = resolveEnvironment(args.environment, envs);
      if (!target.ok) return createErrorResponse(`Target environment: ${target.error}`);
      if (auth.environment && target.value.id === auth.environment.id) {
        return createErrorResponse(
          `The target ${target.value.name} is the environment this tab is in. Run the plan from the ` +
            'SOURCE environment tab (where the project is developed), or switch it with ' +
            'workato_switch_environment.',
        );
      }

      const created = await request(
        tab.tabId,
        'POST',
        `/web_api/project_folders/${project.folder_id}/deployments.json`,
        { title: '', description: '', reviewer_ids: [], environment_id: target.value.id },
      );
      const draft = created?.result;
      if (!draft || typeof draft.id !== 'number') {
        throw new DeployApiError('Creating the deployment draft returned no id.');
      }
      deploymentId = draft.id;
      const manifest: ManifestAsset[] = Array.isArray(draft.project_build?.manifest)
        ? draft.project_build.manifest
        : [];
      const selection = selectManifest(manifest, {
        mode,
        recipeId: args.recipe_id,
        include: Array.isArray(args.include) ? args.include : undefined,
        exclude: Array.isArray(args.exclude) ? args.exclude : undefined,
      });
      if (!selection.ok) {
        return createErrorResponse(
          `${selection.error} (draft deployment ${deploymentId} was opened and is left unused).`,
        );
      }

      await request(tab.tabId, 'PUT', `/web_api/deployments/${deploymentId}.json`, {
        manifest: selection.value,
      });
      await request(
        tab.tabId,
        'PUT',
        `/web_api/deployments/${deploymentId}/start_diff_calculation.json`,
        {
          include_tags: args.include_tags !== false,
        },
      );
      const { dep, timedOut } = await pollDeployment(
        tab.tabId,
        deploymentId as number,
        (d) =>
          d?.state === 'diff_calculation_finished' || String(d?.state ?? '').endsWith('_failed'),
        DIFF_TIMEOUT_MS,
      );
      if (timedOut || dep?.state !== 'diff_calculation_finished') {
        return textResult(
          `deployment ${deploymentId}: the diff did not finish (state ${dep?.state ?? '?'})`,
          {
            deployment_id: deploymentId,
            state: dep?.state ?? null,
            error: dep?.error ?? null,
            next: timedOut
              ? 'Workato is still calculating. Call workato_deploy_plan again later or inspect the deployment in the UI.'
              : "The diff failed; the error above is Workato's.",
          },
          true,
        );
      }

      const plan = joinPlan(
        selection.value,
        Array.isArray(dep.manifest_with_diff) ? (dep.manifest_with_diff as DiffAsset[]) : [],
      );

      const stepDiffs: Record<string, RecipeDeployDiff | { error: string }> = {};
      const skipped: number[] = [];
      if (args.include_step_diff !== false) {
        const changed = plan.assets.filter(
          (a) => a.type === 'recipe' && !UNCHANGED_STATES.has(a.state) && a.source_id !== null,
        );
        for (const asset of changed) {
          if (Object.keys(stepDiffs).length >= MAX_STEP_DIFF_RECIPES) {
            skipped.push(asset.source_id as number);
            continue;
          }
          const key = String(asset.source_id);
          try {
            const compare = await request(
              tab.tabId,
              'GET',
              `/recipes/compare?v1=${encodeURIComponent(`${asset.source_id}:deployment_id:${deploymentId}`)}` +
                `&v2=${encodeURIComponent(`${asset.source_id}:version_no:last`)}`,
            );
            stepDiffs[key] = diffDeployRecipe(compare?.v1 ?? {}, compare?.v2 ?? {}, plan.id_map);
          } catch (err) {
            stepDiffs[key] = { error: errorText(err) };
          }
        }
      }

      const environment = { id: target.value.id, name: target.value.name, type: target.value.type };
      const payload: Record<string, unknown> = {
        deployment_id: deploymentId,
        project,
        environment,
        target_folder_id: dep.target_folder_id ?? null,
        summary: plan.summary,
        assets: plan.assets,
        not_included: plan.not_included,
        will_stop: plan.will_stop,
      };
      if (args.include_step_diff !== false) payload.step_diffs = stepDiffs;
      if (skipped.length > 0) payload.step_diffs_skipped = skipped;
      payload.next =
        `Review, then workato_deploy_run(deployment_id:${deploymentId}, title, allow_writes:true` +
        (plan.will_stop.length > 0
          ? ', allow_stop_running:true). Workato stops the running recipes in will_stop, deploys and restarts them.'
          : ').') +
        ' Nothing is deployed until then.';

      const s = plan.summary;
      return textResult(
        `deploy plan ${deploymentId} to ${environment.name}: ${s.updated} updated, ${s.added} added, ` +
          `${s.unchanged} unchanged` +
          (plan.will_stop.length > 0
            ? `; will stop and restart ${plan.will_stop.map((r) => r.name).join(', ')}`
            : ''),
        payload,
      );
    } catch (err) {
      return createErrorResponse(
        `workato_deploy_plan failed: ${errorText(err)}` +
          (deploymentId !== null ? ` (draft deployment ${deploymentId} exists)` : ''),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// workato_deploy_run
// ---------------------------------------------------------------------------

interface RunArgs {
  deployment_id?: number;
  title?: string;
  description?: string;
  allow_writes?: boolean;
  allow_stop_running?: boolean;
  wait?: boolean;
  timeout_ms?: number;
  tabId?: number;
  expected_context?: ExpectedTabContext;
}

function runPayload(
  dep: any,
  deploymentId: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const changed = (Array.isArray(dep?.manifest_with_diff) ? dep.manifest_with_diff : [])
    .filter((a: any) => a && !UNCHANGED_STATES.has(a.state))
    .map((a: any) => ({
      name: a.name,
      type: a.type,
      target_id: a.id,
      state: a.state,
      changes: a.changes,
    }));
  return {
    deployment_id: deploymentId,
    state: dep?.state ?? null,
    error: dep?.error ?? null,
    title: dep?.title ?? null,
    environment_id: dep?.environment_id ?? null,
    changed_assets: changed,
    recipes_to_stop: dep?.recipes_to_stop ?? [],
    imported_recipes_status: dep?.imported_recipes_status ?? null,
    zip_file_name: dep?.project_build?.zip_file_name ?? null,
    ...extra,
  };
}

class WorkatoDeployRunTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.DEPLOY_RUN;

  async execute(args: RunArgs): Promise<ToolResult> {
    try {
      if (typeof args?.deployment_id !== 'number' || !Number.isFinite(args.deployment_id)) {
        return createErrorResponse(
          'Param [deployment_id] must be the id workato_deploy_plan returned.',
        );
      }
      if (typeof args.title !== 'string' || args.title.trim() === '') {
        return createErrorResponse('Param [title] must be a non-empty deployment name.');
      }
      if (args.allow_writes !== true) {
        return createErrorResponse(
          'WorkatoUnsafeAction: workato_deploy_run writes to the TARGET environment. Pass ' +
            'allow_writes:true once the plan has been reviewed.',
        );
      }
      const deploymentId = args.deployment_id;
      const timeoutMs = Math.min(
        Math.max(
          typeof args.timeout_ms === 'number' ? args.timeout_ms : RUN_DEFAULT_TIMEOUT_MS,
          5_000,
        ),
        RUN_MAX_TIMEOUT_MS,
      );
      const deadline = Date.now() + timeoutMs;

      const tab = await findWorkatoTab(args.tabId);
      await assertExpectedContext(args, tab.tabId);
      const path = `/web_api/deployments/${deploymentId}`;
      let dep = (await request(tab.tabId, 'GET', `${path}.json`))?.result;
      if (!dep) throw new DeployApiError(`Deployment ${deploymentId} came back empty.`);

      let retried = false;
      const startDeploy = async (retry: boolean) => {
        await request(tab.tabId, 'PUT', `${path}/start_deploy.json`, {
          include_tags: dep.include_tags ?? true,
          retry_deploy: retry,
        });
        if (retry) retried = true;
      };

      const initial = decideRun(dep);
      if (initial.kind === 'not_ready') {
        return createErrorResponse(
          `Deployment ${deploymentId} is in state ${dep.state}, not ready to deploy. Run ` +
            'workato_deploy_plan first (it calculates the diff).',
        );
      }
      if (initial.kind === 'failed') {
        return textResult(
          `deployment ${deploymentId} failed: ${dep.error ?? dep.state}`,
          runPayload(dep, deploymentId),
          true,
        );
      }
      if (initial.kind === 'finished') {
        return textResult(
          `deployment ${deploymentId} was already deployed`,
          runPayload(dep, deploymentId, { already_finished: true }),
        );
      }
      if (initial.kind === 'needs_stop') {
        if (args.allow_stop_running !== true) {
          return textResult(
            `deployment ${deploymentId} needs running target recipes stopped`,
            runPayload(dep, deploymentId, {
              status: 'needs_stop',
              next: this.stopHint(deploymentId),
            }),
          );
        }
        await startDeploy(true);
      }
      if (initial.kind === 'start') {
        await request(tab.tabId, 'PUT', `${path}.json`, {
          title: args.title,
          description: typeof args.description === 'string' ? args.description : '',
          reviewer_ids: [],
          environment_id: dep.environment_id,
        });
        await startDeploy(false);
      }
      // initial.kind === 'poll' falls through: a deploy already in flight is only watched.

      if (args.wait === false) {
        dep = (await request(tab.tabId, 'GET', `${path}.json`))?.result ?? dep;
        return textResult(
          `deployment ${deploymentId} started (state ${dep.state})`,
          runPayload(dep, deploymentId, {
            next: 'Call workato_deploy_run again with the same deployment_id: it only polls a deploy in flight.',
          }),
        );
      }

      for (;;) {
        await sleep(POLL_INTERVAL_MS);
        dep = (await request(tab.tabId, 'GET', `${path}.json`))?.result ?? dep;
        const decision = decideRun(dep);
        if (decision.kind === 'finished') {
          return textResult(
            `deployment ${deploymentId} "${dep.title ?? args.title}" finished`,
            runPayload(dep, deploymentId, retried ? { stopped_and_restarted: true } : {}),
          );
        }
        if (decision.kind === 'needs_stop') {
          if (args.allow_stop_running === true && !retried) {
            await startDeploy(true);
            continue;
          }
          return textResult(
            `deployment ${deploymentId} needs running target recipes stopped`,
            runPayload(dep, deploymentId, {
              status: 'needs_stop',
              next: retried
                ? 'Workato asked to stop recipes again after the retry; check them in the UI.'
                : this.stopHint(deploymentId),
            }),
            retried,
          );
        }
        if (decision.kind === 'failed') {
          return textResult(
            `deployment ${deploymentId} failed: ${dep.error ?? dep.state}`,
            runPayload(dep, deploymentId),
            true,
          );
        }
        if (Date.now() + POLL_INTERVAL_MS >= deadline) {
          return textResult(
            `deployment ${deploymentId} still in progress (state ${dep.state})`,
            runPayload(dep, deploymentId, {
              still_running: true,
              next: 'Call workato_deploy_run again with the same deployment_id: it only polls a deploy in flight.',
            }),
          );
        }
      }
    } catch (err) {
      return createErrorResponse(`workato_deploy_run failed: ${errorText(err)}`);
    }
  }

  private stopHint(deploymentId: number): string {
    return (
      'Nothing was changed yet. Workato stops the recipes in recipes_to_stop, deploys and restarts ' +
      `them when you call workato_deploy_run(deployment_id:${deploymentId}, title, allow_writes:true, ` +
      'allow_stop_running:true). Recipes with jobs in progress cannot be stopped.'
    );
  }
}

export const workatoDeploymentsListTool = new WorkatoDeploymentsListTool();
export const workatoDeployPlanTool = new WorkatoDeployPlanTool();
export const workatoDeployRunTool = new WorkatoDeployRunTool();
