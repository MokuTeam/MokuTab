import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { stripConnectionSecrets } from './strip-secrets';

interface GetConnectionArgs {
  connection_id: number;
  full?: boolean;
  tabId?: number;
}

interface InPageResult {
  ok: boolean;
  raw?: { result?: Record<string, unknown> };
  failure?: {
    stage: 'fetch' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

function getConnectionInPage(connectionId: number): Promise<InPageResult> {
  const url = `/connections/${connectionId}.json`;
  const fetchOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };

  return fetch(url, fetchOpts).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'fetch' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: `GET ${url} returned HTTP ${r.status}`,
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
      const result = (json as { result?: Record<string, unknown> }).result;
      if (!result || typeof result !== 'object') {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: bodyText.slice(0, 1024),
            message: 'Unexpected response shape — missing result object.',
          },
        };
      }
      return { ok: true, raw: { result } };
    }),
  );
}

const SLIM_KEYS = [
  'id',
  'name',
  'provider',
  'folder_id',
  'project_id',
  'recipe_count',
  'authorization_status',
  'authorized_at',
  'connection_lost_at',
  'connection_lost_reason',
  'created_at',
  'updated_at',
] as const;

class WorkatoGetConnectionTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.GET_CONNECTION;

  async execute(args: GetConnectionArgs): Promise<ToolResult> {
    try {
      if (typeof args?.connection_id !== 'number' || !Number.isFinite(args.connection_id)) {
        return createErrorResponse('Param [connection_id] must be a finite number');
      }
      const full = args?.full === true;

      const tab = await findWorkatoTab(args.tabId);
      const result = await runInWorkatoTab(tab.tabId, getConnectionInPage, [args.connection_id]);

      if (!result.ok) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
            (result.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      // Strip secrets BEFORE either slim or full shaping. No escape hatch.
      const stripped = stripConnectionSecrets(result.raw!.result) as Record<string, unknown>;

      let payload: Record<string, unknown>;
      if (full) {
        payload = stripped;
      } else {
        const slim: Record<string, unknown> = {};
        for (const key of SLIM_KEYS) {
          if (key in stripped) slim[key] = stripped[key];
        }
        const config: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(stripped)) {
          if (!(SLIM_KEYS as readonly string[]).includes(k)) {
            config[k] = v;
          }
        }
        slim.config = config;
        payload = slim;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      };
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_get_connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoGetConnectionTool = new WorkatoGetConnectionTool();
