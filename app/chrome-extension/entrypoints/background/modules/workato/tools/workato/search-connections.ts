import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { buildSlimConnection, type ConnectionListItem } from './slim-asset';
import { stripConnectionSecrets } from './strip-secrets';

interface SearchConnectionsArgs {
  text?: string;
  folder_id?: number;
  page?: number;
  sort?: 'latest_activity' | 'name' | 'updated_at';
  /**
   * Client-side provider filter (the server's text= only matches names).
   * Walks up to 5 pages collecting connections whose provider equals this
   * (case-insensitive), e.g. 'salesforce', 'netsuite'.
   */
  provider?: string;
  full?: boolean;
  tabId?: number;
}

interface RawSearchResponse {
  result?: {
    items?: unknown[];
    count?: number;
    page?: number;
    per_page?: number;
    provider_filtered?: boolean;
    pages_scanned?: number;
  };
}

interface InPageResult {
  ok: boolean;
  raw?: RawSearchResponse;
  failure?: {
    stage: 'search' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

function searchConnectionsInPage(
  text: string,
  folderId: number | null,
  page: number,
  sort: string,
  provider: string | null,
): Promise<InPageResult> {
  const MAX_PROVIDER_PAGES = 5;
  const fetchOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };

  function buildUrl(p: number): string {
    const params = new URLSearchParams();
    params.set('asset_type', 'connection');
    params.set('sort_term', sort);
    params.set('page', String(p));
    if (text) params.set('text', text);
    if (folderId !== null) params.set('folder_id', String(folderId));
    return `/web_api/mixed_assets.json?${params.toString()}`;
  }

  function fetchPage(
    p: number,
  ): Promise<
    | { ok: true; result: NonNullable<RawSearchResponse['result']> }
    | { ok: false; failure: InPageResult['failure'] }
  > {
    const url = buildUrl(p);
    return fetch(url, fetchOpts).then((r) =>
      r.text().then((bodyText) => {
        if (r.status < 200 || r.status >= 300) {
          return {
            ok: false as const,
            failure: {
              stage: 'search' as const,
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
            ok: false as const,
            failure: {
              stage: 'shape' as const,
              body_excerpt: bodyText.slice(0, 1024),
              message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
            },
          };
        }
        const result = (json as RawSearchResponse).result;
        if (!result || !Array.isArray(result.items)) {
          return {
            ok: false as const,
            failure: {
              stage: 'shape' as const,
              body_excerpt: bodyText.slice(0, 1024),
              message: 'Unexpected response shape — missing result.items array.',
            },
          };
        }
        return { ok: true as const, result };
      }),
    );
  }

  if (!provider) {
    return fetchPage(page).then((res) =>
      res.ok ? { ok: true, raw: { result: res.result } } : { ok: false, failure: res.failure },
    );
  }

  // Provider filter: the endpoint ignores provider=, so walk pages and filter
  // client-side (verified live 2026-07-14).
  const wanted = provider.toLowerCase();
  const matched: unknown[] = [];
  let perPage = 20;
  let totalCount = 0;

  function walk(p: number, pagesScanned: number): Promise<InPageResult> {
    return fetchPage(p).then((res) => {
      if (!res.ok) return { ok: false, failure: res.failure };
      const items = res.result.items ?? [];
      perPage = Number(res.result.per_page ?? 20);
      totalCount = Number(res.result.count ?? 0);
      for (const item of items) {
        const prov = String((item as any)?.provider ?? '').toLowerCase();
        if (prov === wanted) matched.push(item);
      }
      const lastPage = items.length < perPage;
      if (lastPage || pagesScanned >= MAX_PROVIDER_PAGES) {
        return {
          ok: true,
          raw: {
            result: {
              items: matched,
              count: matched.length,
              page,
              per_page: perPage,
              provider_filtered: true,
              pages_scanned: pagesScanned,
            },
          },
        };
      }
      return walk(p + 1, pagesScanned + 1);
    });
  }

  return walk(page, 1);
}

class WorkatoSearchConnectionsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.SEARCH_CONNECTIONS;

  async execute(args: SearchConnectionsArgs): Promise<ToolResult> {
    try {
      const text = typeof args?.text === 'string' ? args.text : '';
      const folderId =
        typeof args?.folder_id === 'number' && Number.isFinite(args.folder_id)
          ? args.folder_id
          : null;
      const page =
        typeof args?.page === 'number' && Number.isFinite(args.page) && args.page >= 1
          ? Math.floor(args.page)
          : 1;
      const sort = args?.sort ?? 'latest_activity';
      const provider =
        typeof args?.provider === 'string' && args.provider.trim().length > 0
          ? args.provider.trim()
          : null;
      const full = args?.full === true;

      const tab = await findWorkatoTab(args.tabId);
      const result = await runInWorkatoTab(tab.tabId, searchConnectionsInPage, [
        text,
        folderId,
        page,
        sort,
        provider,
      ]);

      if (!result.ok) {
        return createErrorResponse(
          `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
            (result.failure?.body_excerpt
              ? `\n--- body excerpt ---\n${result.failure.body_excerpt}`
              : ''),
        );
      }

      const raw = result.raw!.result!;
      // full=true returns list items as Workato sent them, so they go through the
      // same secret strip as the single-connection read: there is no path out of
      // this tool that can carry credential material.
      const payload = full
        ? (stripConnectionSecrets(raw) as typeof raw)
        : {
            count: Number(raw.count ?? 0),
            page: Number(raw.page ?? page),
            per_page: Number(raw.per_page ?? 20),
            ...(raw.provider_filtered
              ? { provider_filtered: true, pages_scanned: raw.pages_scanned }
              : {}),
            connections: (raw.items ?? []).map((item) =>
              buildSlimConnection(item as ConnectionListItem),
            ),
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
        `workato_search_connections failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoSearchConnectionsTool = new WorkatoSearchConnectionsTool();
