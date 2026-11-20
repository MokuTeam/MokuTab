import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';

/**
 * Folder / project-tree tools.
 *
 * Endpoints (captured + verified live 2026-07-15, legacy app.workato.com):
 *   GET    /folders?projects_mode=true   → { result: { folders: [tree], mixed_asset_counters } }
 *   POST   /folders {name, parent_id}    → 201 { result: folder }
 *   PUT    /folders/<id> {name?, parent_id?} → 200 { result: folder } (partial body OK)
 *   DELETE /folders/<id>                 → 200 { success: true }
 *
 * CAUTION (verified live): DELETE on a non-empty folder CASCADES — it silently
 * deletes all contents. The delete tool therefore pre-checks the tree and
 * refuses non-empty folders unless force:true.
 *
 * Top-level entries in the tree are project root folders: `id` is the folder
 * id (usable as parent_id / folder_id), `project_id` is the owning project.
 */

interface PageFailure {
  stage: 'csrf' | 'fetch' | 'write' | 'shape';
  status?: number;
  body_excerpt?: string;
  message: string;
}

export interface RawFolderNode {
  id: number;
  name: string;
  project_id?: string;
  project_type?: string;
  children?: RawFolderNode[];
  flow_count?: number;
  active_flow_count?: number;
  [key: string]: unknown;
}

interface FoldersListInPageResult {
  ok: boolean;
  raw?: { folders: RawFolderNode[]; mixed_asset_counters?: unknown };
  failure?: PageFailure;
}

interface FolderWriteInPageResult {
  ok: boolean;
  folder?: { id: number; name: string; project_id: string };
  failure?: PageFailure;
}

interface FolderDeleteInPageResult {
  ok: boolean;
  failure?: PageFailure;
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based
 * (see pull-recipe.ts for why async/await is forbidden here).
 */
export function fetchFoldersInPage(): Promise<FoldersListInPageResult> {
  return fetch('/folders?projects_mode=true', {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'fetch' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `GET /folders?projects_mode=true returned HTTP ${r.status}`,
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
      const result = (json as any)?.result;
      if (!result || !Array.isArray(result.folders)) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: JSON.stringify(json).slice(0, 1024),
            message: 'Unexpected response shape — missing result.folders array.',
          },
        };
      }
      return { ok: true, raw: result };
    }),
  );
}

function createFolderInPage(name: string, parentId: number): Promise<FolderWriteInPageResult> {
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
  return fetch('/folders', {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({ name: name, parent_id: parentId }),
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'write' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `POST /folders returned HTTP ${r.status}`,
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
      if (!res || typeof res.id !== 'number') {
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
        folder: {
          id: res.id,
          name: String(res.name ?? ''),
          project_id: String(res.project_id ?? ''),
        },
      };
    }),
  );
}

function updateFolderInPage(
  folderId: number,
  name: string | null,
  parentId: number | null,
): Promise<FolderWriteInPageResult> {
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
  if (parentId !== null) body.parent_id = parentId;
  return fetch(`/folders/${folderId}`, {
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
            message: `PUT /folders/${folderId} returned HTTP ${r.status}`,
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
      if (!res || typeof res.id !== 'number') {
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
        folder: {
          id: res.id,
          name: String(res.name ?? ''),
          project_id: String(res.project_id ?? ''),
        },
      };
    }),
  );
}

function deleteFolderInPage(folderId: number): Promise<FolderDeleteInPageResult> {
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
  return fetch(`/folders/${folderId}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
    },
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'write' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `DELETE /folders/${folderId} returned HTTP ${r.status}`,
          },
        };
      }
      return { ok: true };
    }),
  );
}

// ---------------------------------------------------------------------------
// Background-side helpers
// ---------------------------------------------------------------------------

interface SlimFolderNode {
  id: number;
  name: string;
  project_id?: string;
  flow_count?: number;
  active_flow_count?: number;
  counts?: Record<string, number>;
  children?: SlimFolderNode[];
}

/** Count fields other than flow counts, surfaced only when non-zero. */
function extraCounts(node: RawFolderNode): Record<string, number> {
  const extras: Record<string, number> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!key.endsWith('_count') || key === 'flow_count' || key === 'active_flow_count') continue;
    if (typeof value === 'number' && value > 0) extras[key] = value;
  }
  return extras;
}

function slimNode(node: RawFolderNode): SlimFolderNode {
  const slim: SlimFolderNode = { id: node.id, name: node.name };
  if (node.project_id != null) slim.project_id = String(node.project_id);
  if (typeof node.flow_count === 'number') slim.flow_count = node.flow_count;
  if (typeof node.active_flow_count === 'number') slim.active_flow_count = node.active_flow_count;
  const extras = extraCounts(node);
  if (Object.keys(extras).length > 0) slim.counts = extras;
  const children = Array.isArray(node.children) ? node.children : [];
  if (children.length > 0) slim.children = children.map(slimNode);
  return slim;
}

/** Depth-first search for a folder id; returns the node and its parent (null for top-level). */
export function findFolderNode(
  nodes: RawFolderNode[],
  folderId: number,
  parent: RawFolderNode | null = null,
): { node: RawFolderNode; parent: RawFolderNode | null } | null {
  for (const node of nodes) {
    if (node.id === folderId) return { node, parent };
    const hit = findFolderNode(node.children ?? [], folderId, node);
    if (hit) return hit;
  }
  return null;
}

function isDispatchTimeout(err: unknown): boolean {
  return (
    err instanceof WorkatoDispatchError &&
    err.code === 'ScriptExecutionFailed' &&
    /timed out/i.test(err.message)
  );
}

async function fetchFolderTree(
  tabId: number,
): Promise<{ folders: RawFolderNode[]; mixed_asset_counters?: unknown }> {
  const result = await runInWorkatoTab(tabId, fetchFoldersInPage, []);
  if (!result.ok || !result.raw) {
    throw new WorkatoDispatchError(
      'UnexpectedShape',
      `folder tree fetch failed (${result.failure?.stage}): ${result.failure?.message ?? 'unknown'}`,
    );
  }
  return result.raw;
}

function apiErrorResponse(failure: PageFailure | undefined): ToolResult {
  return createErrorResponse(
    `WorkatoApiError (${failure?.stage}): ${failure?.message}` +
      (failure?.body_excerpt ? `\n--- body excerpt ---\n${failure.body_excerpt}` : ''),
  );
}

// ---------------------------------------------------------------------------
// workato_list_folders
// ---------------------------------------------------------------------------

class WorkatoListFoldersTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.LIST_FOLDERS;

  async execute(args: {
    project?: string | number;
    full?: boolean;
    tabId?: number;
  }): Promise<ToolResult> {
    try {
      const tab = await findWorkatoTab(args?.tabId);
      const raw = await fetchFolderTree(tab.tabId);

      if (args?.full === true) {
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], isError: false };
      }

      let roots = raw.folders;
      if (args?.project !== undefined && args.project !== null && args.project !== '') {
        const wanted = String(args.project).toLowerCase();
        roots = raw.folders.filter(
          (f) => String(f.project_id ?? '') === wanted || f.name.toLowerCase() === wanted,
        );
        if (roots.length === 0) {
          const available = raw.folders
            .map((f) => `${f.name} (project_id ${f.project_id}, folder ${f.id})`)
            .join(', ');
          return createErrorResponse(
            `No project matched "${args.project}". Available projects: ${available}`,
          );
        }
      }

      const payload: Record<string, unknown> = {
        project_count: raw.folders.length,
        projects: roots.map(slimNode),
      };
      if (args?.project === undefined && raw.mixed_asset_counters) {
        payload.totals = raw.mixed_asset_counters;
      }
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_list_folders failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// workato_create_folder
// ---------------------------------------------------------------------------

class WorkatoCreateFolderTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.CREATE_FOLDER;

  async execute(args: { name: string; parent_id: number; tabId?: number }): Promise<ToolResult> {
    try {
      if (typeof args?.name !== 'string' || args.name.trim().length === 0) {
        return createErrorResponse('Param [name] must be a non-empty string');
      }
      if (typeof args.parent_id !== 'number' || !Number.isFinite(args.parent_id)) {
        return createErrorResponse(
          'Param [parent_id] must be a finite number (a folder id from workato_list_folders)',
        );
      }
      const tab = await findWorkatoTab(args.tabId);

      let result: FolderWriteInPageResult;
      let succeededAfterTimeout = false;
      try {
        result = await runInWorkatoTab(tab.tabId, createFolderInPage, [args.name, args.parent_id], {
          retryOnTimeout: false,
        });
      } catch (err) {
        if (!isDispatchTimeout(err)) throw err;
        // Write timed out — verify whether the folder actually got created
        // before reporting failure (never blind-retry a create).
        let created: RawFolderNode | undefined;
        try {
          const tree = await fetchFolderTree(tab.tabId);
          const parentHit = findFolderNode(tree.folders, args.parent_id);
          created = (parentHit?.node.children ?? []).find((c) => c.name === args.name);
        } catch {
          /* verification failed — fall through to original error */
        }
        if (!created) throw err;
        result = {
          ok: true,
          folder: {
            id: created.id,
            name: created.name,
            project_id: String(created.project_id ?? ''),
          },
        };
        succeededAfterTimeout = true;
      }

      if (!result.ok || !result.folder) return apiErrorResponse(result.failure);

      const payload: Record<string, unknown> = {
        folder_id: result.folder.id,
        name: result.folder.name,
        project_id: result.folder.project_id,
        parent_id: args.parent_id,
      };
      if (succeededAfterTimeout) payload.succeeded_after_timeout = true;
      return {
        content: [
          {
            type: 'text',
            text: `created folder "${result.folder.name}" (id ${result.folder.id})\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_create_folder failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// workato_update_folder (rename and/or move)
// ---------------------------------------------------------------------------

class WorkatoUpdateFolderTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.UPDATE_FOLDER;

  async execute(args: {
    folder_id: number;
    name?: string;
    parent_id?: number;
    tabId?: number;
  }): Promise<ToolResult> {
    try {
      if (typeof args?.folder_id !== 'number' || !Number.isFinite(args.folder_id)) {
        return createErrorResponse('Param [folder_id] must be a finite number');
      }
      const name = typeof args.name === 'string' && args.name.trim().length > 0 ? args.name : null;
      const parentId =
        typeof args.parent_id === 'number' && Number.isFinite(args.parent_id)
          ? args.parent_id
          : null;
      if (name === null && parentId === null) {
        return createErrorResponse(
          'Provide [name] (rename), [parent_id] (move), or both — at least one is required',
        );
      }
      const tab = await findWorkatoTab(args.tabId);

      let result: FolderWriteInPageResult;
      let succeededAfterTimeout = false;
      try {
        result = await runInWorkatoTab(
          tab.tabId,
          updateFolderInPage,
          [args.folder_id, name, parentId],
          { retryOnTimeout: false },
        );
      } catch (err) {
        if (!isDispatchTimeout(err)) throw err;
        // Verify whether the update actually landed before reporting failure.
        let verified: RawFolderNode | undefined;
        try {
          const tree = await fetchFolderTree(tab.tabId);
          const hit = findFolderNode(tree.folders, args.folder_id);
          if (hit) {
            const nameOk = name === null || hit.node.name === name;
            const parentOk = parentId === null || hit.parent?.id === parentId;
            if (nameOk && parentOk) verified = hit.node;
          }
        } catch {
          /* verification failed — fall through to original error */
        }
        if (!verified) throw err;
        result = {
          ok: true,
          folder: {
            id: verified.id,
            name: verified.name,
            project_id: String(verified.project_id ?? ''),
          },
        };
        succeededAfterTimeout = true;
      }

      if (!result.ok || !result.folder) return apiErrorResponse(result.failure);

      const payload: Record<string, unknown> = {
        folder_id: result.folder.id,
        name: result.folder.name,
        project_id: result.folder.project_id,
      };
      if (parentId !== null) payload.parent_id = parentId;
      if (succeededAfterTimeout) payload.succeeded_after_timeout = true;
      const actions = [name !== null ? 'renamed' : null, parentId !== null ? 'moved' : null]
        .filter(Boolean)
        .join(' + ');
      return {
        content: [
          {
            type: 'text',
            text: `${actions} folder ${result.folder.id} → "${result.folder.name}"\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_update_folder failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// workato_delete_folder
// ---------------------------------------------------------------------------

class WorkatoDeleteFolderTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.DELETE_FOLDER;

  async execute(args: { folder_id: number; force?: boolean; tabId?: number }): Promise<ToolResult> {
    try {
      if (typeof args?.folder_id !== 'number' || !Number.isFinite(args.folder_id)) {
        return createErrorResponse('Param [folder_id] must be a finite number');
      }
      const tab = await findWorkatoTab(args.tabId);

      // Safety pre-check: DELETE cascades on Workato's side (verified live) —
      // deleting a non-empty folder silently deletes everything inside it.
      const tree = await fetchFolderTree(tab.tabId);
      const hit = findFolderNode(tree.folders, args.folder_id);
      if (!hit) {
        return createErrorResponse(
          `FolderNotFound: no folder with id ${args.folder_id} in this workspace (already deleted?). ` +
            'Use workato_list_folders to inspect the tree.',
        );
      }
      if (hit.parent === null) {
        return createErrorResponse(
          `RefusedProjectRoot: folder ${args.folder_id} ("${hit.node.name}") is a project root folder. ` +
            'Deleting it would delete the whole project — do that from the Workato UI if intended.',
        );
      }
      const childCount = (hit.node.children ?? []).length;
      const contents: Record<string, number> = { ...extraCounts(hit.node) };
      if (typeof hit.node.flow_count === 'number' && hit.node.flow_count > 0) {
        contents.flow_count = hit.node.flow_count;
      }
      if (childCount > 0) contents.subfolder_count = childCount;
      if (Object.keys(contents).length > 0 && args.force !== true) {
        return createErrorResponse(
          `RefusedNonEmpty: folder ${args.folder_id} ("${hit.node.name}") is not empty ` +
            `(${JSON.stringify(contents)}). Workato CASCADES this delete — everything inside ` +
            'would be permanently deleted. Move or delete the contents first, or pass force:true ' +
            'only if the user explicitly confirmed cascading deletion.',
        );
      }

      let succeededAfterTimeout = false;
      let result: FolderDeleteInPageResult;
      try {
        result = await runInWorkatoTab(tab.tabId, deleteFolderInPage, [args.folder_id], {
          retryOnTimeout: false,
        });
      } catch (err) {
        if (!isDispatchTimeout(err)) throw err;
        // Verify: if the folder is gone from the tree, the delete landed.
        let gone = false;
        try {
          const after = await fetchFolderTree(tab.tabId);
          gone = findFolderNode(after.folders, args.folder_id) === null;
        } catch {
          /* verification failed — fall through to original error */
        }
        if (!gone) throw err;
        result = { ok: true };
        succeededAfterTimeout = true;
      }

      if (!result.ok) return apiErrorResponse(result.failure);

      const payload: Record<string, unknown> = {
        folder_id: args.folder_id,
        name: hit.node.name,
        deleted: true,
      };
      if (args.force === true && Object.keys(contents).length > 0) {
        payload.cascaded_contents = contents;
      }
      if (succeededAfterTimeout) payload.succeeded_after_timeout = true;
      return {
        content: [
          {
            type: 'text',
            text: `deleted folder ${args.folder_id} ("${hit.node.name}")\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_delete_folder failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoListFoldersTool = new WorkatoListFoldersTool();
export const workatoCreateFolderTool = new WorkatoCreateFolderTool();
export const workatoUpdateFolderTool = new WorkatoUpdateFolderTool();
export const workatoDeleteFolderTool = new WorkatoDeleteFolderTool();
