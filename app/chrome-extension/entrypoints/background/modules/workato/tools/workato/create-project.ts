import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { fetchFoldersInPage, findFolderNode } from './folders';

/**
 * workato_create_project / workato_update_project — project management.
 *
 * POST /web_api/projects.json {name} → { result: { id, name, folder_id, ... } }
 * PUT  /web_api/projects/f<root_folder_id>.json {name?, color?, icon?} → { result: project }
 * (captured + verified live 2026-07-15; note the update URL takes the project's
 * ROOT FOLDER id with an `f` prefix, not the project id. Partial bodies work —
 * omitted fields keep their current value.)
 * The returned folder_id is the project's root folder — the parent_id to use
 * when creating folders/recipes inside the project.
 */

interface CreateProjectInPageResult {
  ok: boolean;
  project?: {
    project_id: string;
    name: string;
    folder_id: number;
    description: string | null;
    project_type: string;
  };
  failure?: {
    stage: 'csrf' | 'write' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based
 * (see pull-recipe.ts for why async/await is forbidden here).
 */
function createProjectInPage(name: string): Promise<CreateProjectInPageResult> {
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
        stage: 'csrf',
        message:
          'could not find CSRF token in XSRF-TOKEN-V2 cookie or meta tag; ensure the active tab is a logged-in Workato page',
      },
    });
  }
  return fetch('/web_api/projects.json', {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({ name: name }),
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'write' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `POST /web_api/projects.json returned HTTP ${r.status}`,
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
      const res = (json as any)?.result;
      if (!res || res.id == null || typeof res.folder_id !== 'number') {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: JSON.stringify(json).slice(0, 1024),
            message: 'Unexpected response shape — missing result.id / result.folder_id.',
          },
        };
      }
      return {
        ok: true,
        project: {
          project_id: String(res.id),
          name: String(res.name ?? ''),
          folder_id: res.folder_id,
          description: res.description != null ? String(res.description) : null,
          project_type: String(res.project_type ?? 'standard'),
        },
      };
    }),
  );
}

interface UpdateProjectInPageResult {
  ok: boolean;
  project?: {
    project_id: string;
    name: string;
    folder_id: number;
    color: string | null;
    description: string | null;
    project_type: string;
  };
  failure?: {
    stage: 'csrf' | 'write' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based.
 */
function updateProjectInPage(
  rootFolderId: number,
  name: string | null,
  color: string | null,
  icon: string | null,
): Promise<UpdateProjectInPageResult> {
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
        stage: 'csrf',
        message:
          'could not find CSRF token in XSRF-TOKEN-V2 cookie or meta tag; ensure the active tab is a logged-in Workato page',
      },
    });
  }
  const body: Record<string, unknown> = {};
  if (name !== null) body.name = name;
  if (color !== null) body.color = color;
  if (icon !== null) body.icon = icon;
  return fetch(`/web_api/projects/f${rootFolderId}.json`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify(body),
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'write' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `PUT /web_api/projects/f${rootFolderId}.json returned HTTP ${r.status}`,
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
      const res = (json as any)?.result;
      if (!res || res.id == null) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: JSON.stringify(json).slice(0, 1024),
            message: 'Unexpected response shape — missing result.id.',
          },
        };
      }
      return {
        ok: true,
        project: {
          project_id: String(res.id),
          name: String(res.name ?? ''),
          folder_id: typeof res.folder_id === 'number' ? res.folder_id : rootFolderId,
          color: res.color != null ? String(res.color) : null,
          description: res.description != null ? String(res.description) : null,
          project_type: String(res.project_type ?? 'standard'),
        },
      };
    }),
  );
}

class WorkatoCreateProjectTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.CREATE_PROJECT;

  async execute(args: { name: string; tabId?: number }): Promise<ToolResult> {
    try {
      if (typeof args?.name !== 'string' || args.name.trim().length === 0) {
        return createErrorResponse('Param [name] must be a non-empty string');
      }
      const tab = await findWorkatoTab(args.tabId);

      let result: CreateProjectInPageResult;
      let succeededAfterTimeout = false;
      try {
        result = await runInWorkatoTab(tab.tabId, createProjectInPage, [args.name], {
          retryOnTimeout: false,
        });
      } catch (err) {
        const isTimeout =
          err instanceof WorkatoDispatchError &&
          err.code === 'ScriptExecutionFailed' &&
          /timed out/i.test(err.message);
        if (!isTimeout) throw err;
        // Write timed out — check the folder tree for a project root with this
        // name before reporting failure (never blind-retry a create).
        let created: CreateProjectInPageResult['project'] | undefined;
        try {
          const tree = await runInWorkatoTab(tab.tabId, fetchFoldersInPage, []);
          if (tree.ok && tree.raw) {
            const root = tree.raw.folders.find((f) => f.name === args.name);
            if (root && findFolderNode(tree.raw.folders, root.id)?.parent === null) {
              created = {
                project_id: String(root.project_id ?? ''),
                name: root.name,
                folder_id: root.id,
                description: null,
                project_type: String(root.project_type ?? 'standard'),
              };
            }
          }
        } catch {
          /* verification failed — fall through to original error */
        }
        if (!created) throw err;
        result = { ok: true, project: created };
        succeededAfterTimeout = true;
      }

      if (!result.ok || !result.project) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
            (result.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      const payload: Record<string, unknown> = { ...result.project };
      if (succeededAfterTimeout) payload.succeeded_after_timeout = true;
      return {
        content: [
          {
            type: 'text',
            text:
              `created project "${result.project.name}" (project_id ${result.project.project_id}, ` +
              `root folder ${result.project.folder_id})\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_create_project failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

class WorkatoUpdateProjectTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.UPDATE_PROJECT;

  async execute(args: {
    folder_id: number;
    name?: string;
    color?: string;
    icon?: string;
    tabId?: number;
  }): Promise<ToolResult> {
    try {
      if (typeof args?.folder_id !== 'number' || !Number.isFinite(args.folder_id)) {
        return createErrorResponse(
          "Param [folder_id] must be a finite number — the project's ROOT folder id " +
            '(top-level `id` in workato_list_folders, or folder_id from workato_create_project)',
        );
      }
      const name = typeof args.name === 'string' && args.name.trim().length > 0 ? args.name : null;
      const color = typeof args.color === 'string' && args.color.length > 0 ? args.color : null;
      const icon = typeof args.icon === 'string' ? args.icon : null;
      if (name === null && color === null && icon === null) {
        return createErrorResponse(
          'Provide [name] (rename), [color], and/or [icon] — at least one is required',
        );
      }
      const tab = await findWorkatoTab(args.tabId);

      let result: UpdateProjectInPageResult;
      let succeededAfterTimeout = false;
      try {
        result = await runInWorkatoTab(
          tab.tabId,
          updateProjectInPage,
          [args.folder_id, name, color, icon],
          { retryOnTimeout: false },
        );
      } catch (err) {
        const isTimeout =
          err instanceof WorkatoDispatchError &&
          err.code === 'ScriptExecutionFailed' &&
          /timed out/i.test(err.message);
        if (!isTimeout) throw err;
        // Verify whether the update actually landed before reporting failure.
        let verified: UpdateProjectInPageResult['project'] | undefined;
        try {
          const tree = await runInWorkatoTab(tab.tabId, fetchFoldersInPage, []);
          if (tree.ok && tree.raw) {
            const root = tree.raw.folders.find((f) => f.id === args.folder_id);
            const nameOk = root && (name === null || root.name === name);
            const colorOk = root && (color === null || String(root.color ?? '') === color);
            if (root && nameOk && colorOk) {
              verified = {
                project_id: String(root.project_id ?? ''),
                name: root.name,
                folder_id: root.id,
                color: root.color != null ? String(root.color) : null,
                description: null,
                project_type: String(root.project_type ?? 'standard'),
              };
            }
          }
        } catch {
          /* verification failed — fall through to original error */
        }
        if (!verified) throw err;
        result = { ok: true, project: verified };
        succeededAfterTimeout = true;
      }

      if (!result.ok || !result.project) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
            (result.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      const payload: Record<string, unknown> = { ...result.project };
      if (succeededAfterTimeout) payload.succeeded_after_timeout = true;
      return {
        content: [
          {
            type: 'text',
            text: `updated project "${result.project.name}" (project_id ${result.project.project_id})\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_update_project failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoCreateProjectTool = new WorkatoCreateProjectTool();
export const workatoUpdateProjectTool = new WorkatoUpdateProjectTool();
