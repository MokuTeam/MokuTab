import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { invalidateTabContext } from './session-context';
import {
  resolveEnvironment,
  resolveWorkspace,
  type EnvironmentRef,
  type WorkspaceRef,
} from './deploy-logic';

/**
 * workato_switch_environment: move the session to another environment and/or
 * client workspace.
 *
 * Neither switch is an XHR. The app's own switchers navigate the page (found
 * in the bundle, verified live 2026-09-29):
 *   environment: window.open('/users/switch_environment?environment_id=<id>[&return_to=<path>]', '_self')
 *   workspace:   window.location.href = '/users/switch_team?team_id=<id>&team_name=<name>'
 * The server switches the session and redirects (to return_to, else to /).
 * The session is a cookie of the Chrome PROFILE, so every Workato tab in that
 * profile moves with it; tabs other than the navigated one keep showing their
 * old page until they reload.
 */

const NAVIGATION_TIMEOUT_MS = 45_000;
const AUTH_READ_TIMEOUT_MS = 15_000;

export interface AuthUserSlim {
  ok: boolean;
  workspace?: WorkspaceRef | null;
  environment?: EnvironmentRef | null;
  environments?: EnvironmentRef[];
  teams?: WorkspaceRef[];
  failure?: { stage: 'http' | 'auth' | 'shape'; status?: number; message: string };
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based.
 * Always a fresh read: the switch has to see the session as the server has it.
 */
export function fetchAuthUserSlimInPage(): Promise<AuthUserSlim> {
  function toEnv(value: unknown): EnvironmentRef | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== 'number') return null;
    return { id: v.id, name: String(v.name ?? ''), type: String(v.type ?? '') };
  }
  return fetch('/web_api/auth_user.json', {
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  }).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'http' as const,
            status: r.status,
            message: `GET /web_api/auth_user.json returned HTTP ${r.status}`,
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
            message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }
      const res = json && json.result;
      if (!res || res.authenticated === false) {
        return {
          ok: false,
          failure: { stage: 'auth' as const, message: 'not authenticated to Workato in this tab' },
        };
      }
      const available = Array.isArray(res.available_environments)
        ? res.available_environments
        : Array.isArray(res.all_environments)
          ? res.all_environments
          : [];
      const environments = available
        .map(toEnv)
        .filter((e: EnvironmentRef | null): e is EnvironmentRef => e !== null);
      let environment = toEnv(res.current_environment);
      if (!environment && typeof res.current_environment === 'number') {
        environment =
          environments.find((e: EnvironmentRef) => e.id === res.current_environment) || null;
      }
      const team = res.current_team;
      const workspace =
        team && typeof team.id === 'number' ? { id: team.id, name: String(team.name ?? '') } : null;
      const teams = Array.isArray(res.teams)
        ? res.teams
            .filter((t: any) => t && typeof t.id === 'number')
            .map((t: any) => ({ id: t.id, name: String(t.name ?? '') }))
        : [];
      return { ok: true, workspace, environment, environments, teams };
    }),
  );
}

export async function readAuthUser(
  tabId: number,
): Promise<Required<Omit<AuthUserSlim, 'failure'>>> {
  const res = await runInWorkatoTab(tabId, fetchAuthUserSlimInPage, [], {
    timeoutMs: AUTH_READ_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new WorkatoDispatchError(
      'UnexpectedShape',
      `Could not read the Workato session of tab ${tabId} (${res.failure?.stage}): ${res.failure?.message}`,
    );
  }
  return {
    ok: true,
    workspace: res.workspace ?? null,
    environment: res.environment ?? null,
    environments: res.environments ?? [],
    teams: res.teams ?? [],
  };
}

/**
 * Point the tab at `url` and resolve with the URL it settles on once the load
 * (redirects included) completes.
 */
function navigateAndWait(tabId: number, url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let started = false;
    const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (changeInfo.status === 'loading') started = true;
      if (changeInfo.status === 'complete' && started) {
        cleanup();
        resolve(tab.url ?? '');
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new WorkatoDispatchError(
          'ScriptExecutionFailed',
          `Tab ${tabId} did not finish loading ${url} within ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((err) => {
      cleanup();
      reject(
        new WorkatoDispatchError(
          'ScriptExecutionFailed',
          `Could not navigate tab ${tabId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });
  });
}

interface SessionSide {
  workspace_id: number | null;
  workspace_name: string | null;
  environment: string | null;
  environment_id: number | null;
  environment_type: string | null;
}

function side(auth: {
  workspace: WorkspaceRef | null;
  environment: EnvironmentRef | null;
}): SessionSide {
  return {
    workspace_id: auth.workspace?.id ?? null,
    workspace_name: auth.workspace?.name ?? null,
    environment: auth.environment?.name ?? null,
    environment_id: auth.environment?.id ?? null,
    environment_type: auth.environment?.type ?? null,
  };
}

function sameOrigin(tabUrl: string, path: string): string {
  return new URL(path, tabUrl).toString();
}

interface SwitchArgs {
  environment?: string | number;
  workspace?: string | number;
  return_to?: string;
  tabId?: number;
}

class WorkatoSwitchEnvironmentTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.SWITCH_ENVIRONMENT;

  async execute(args: SwitchArgs): Promise<ToolResult> {
    try {
      const hasEnv =
        args?.environment !== undefined && args.environment !== null && args.environment !== '';
      const hasWs =
        args?.workspace !== undefined && args.workspace !== null && args.workspace !== '';
      if (!hasEnv && !hasWs) {
        return createErrorResponse('Pass [environment], [workspace], or both.');
      }
      if (
        args.return_to !== undefined &&
        (typeof args.return_to !== 'string' || !args.return_to.startsWith('/'))
      ) {
        return createErrorResponse(
          'Param [return_to] must be an app path starting with "/", e.g. "/recipes/123".',
        );
      }

      const tab = await findWorkatoTab(args.tabId);
      const tabInfo = await chrome.tabs.get(tab.tabId);
      const baseUrl = tabInfo.url ?? tab.origin;
      const before = await readAuthUser(tab.tabId);
      let current = before;
      let landedUrl = baseUrl;
      let navigated = false;

      if (hasWs) {
        const candidates: WorkspaceRef[] = [];
        for (const t of [current.workspace, ...current.teams]) {
          if (t && !candidates.some((c) => c.id === t.id)) candidates.push(t);
        }
        const target = resolveWorkspace(args.workspace, candidates);
        if (!target.ok) return createErrorResponse(target.error);
        if (target.value.id !== current.workspace?.id) {
          const url = sameOrigin(
            baseUrl,
            `/users/switch_team?team_id=${encodeURIComponent(String(target.value.id))}` +
              `&team_name=${encodeURIComponent(target.value.name)}`,
          );
          landedUrl = await navigateAndWait(tab.tabId, url, NAVIGATION_TIMEOUT_MS);
          navigated = true;
          invalidateTabContext();
          current = await readAuthUser(tab.tabId);
          if (current.workspace?.id !== target.value.id) {
            return createErrorResponse(
              `Workspace switch did not take: asked for ${target.value.name} (${target.value.id}), ` +
                `the session is in ${current.workspace?.name ?? '?'} (${current.workspace?.id ?? '?'}). ` +
                `Tab ${tab.tabId} is at ${landedUrl}.`,
            );
          }
        }
      }

      if (hasEnv) {
        const target = resolveEnvironment(args.environment, current.environments);
        if (!target.ok) {
          return createErrorResponse(
            `${target.error}` +
              (current.workspace ? ` (workspace ${current.workspace.name})` : '') +
              (navigated ? '. The workspace switch already happened.' : ''),
          );
        }
        if (target.value.id !== current.environment?.id) {
          const returnTo = args.return_to ? `&return_to=${encodeURIComponent(args.return_to)}` : '';
          const url = sameOrigin(
            baseUrl,
            `/users/switch_environment?environment_id=${encodeURIComponent(String(target.value.id))}${returnTo}`,
          );
          landedUrl = await navigateAndWait(tab.tabId, url, NAVIGATION_TIMEOUT_MS);
          navigated = true;
          invalidateTabContext();
          current = await readAuthUser(tab.tabId);
          if (current.environment?.id !== target.value.id) {
            return createErrorResponse(
              `Environment switch did not take: asked for ${target.value.name} (${target.value.id}), ` +
                `the session is in ${current.environment?.name ?? '?'} (${current.environment?.id ?? '?'}). ` +
                `Tab ${tab.tabId} is at ${landedUrl}.`,
            );
          }
        }
      }

      // switch_team takes no return_to: when only the workspace moved, or the
      // environment was already right after it, land the tab on return_to here.
      const landed = navigated ? new URL(landedUrl) : null;
      if (
        landed &&
        args.return_to &&
        landed.pathname + landed.search !== args.return_to.split('#')[0]
      ) {
        landedUrl = await navigateAndWait(
          tab.tabId,
          sameOrigin(baseUrl, args.return_to),
          NAVIGATION_TIMEOUT_MS,
        );
      }

      if (navigated) invalidateTabContext();
      const payload = {
        changed: navigated,
        before: side(before),
        after: side(current),
        tab_id: tab.tabId,
        landed_url: landedUrl,
        note: navigated
          ? 'The session belongs to the Chrome profile: every Workato tab in it is now in the new ' +
            'workspace/environment, and tabs other than this one keep showing their old page until reloaded.'
          : 'Already there; nothing was navigated.',
      };
      const after = payload.after;
      return {
        content: [
          {
            type: 'text',
            text:
              (navigated ? 'switched to' : 'already in') +
              ` workspace ${after.workspace_id ?? '?'} "${after.workspace_name ?? '?'}", ` +
              `environment ${after.environment ?? '?'}\n${JSON.stringify(payload)}`,
          },
        ],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_switch_environment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoSwitchEnvironmentTool = new WorkatoSwitchEnvironmentTool();
