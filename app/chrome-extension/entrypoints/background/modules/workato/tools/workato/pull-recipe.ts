import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import {
  findWorkatoTab,
  runInWorkatoTab,
  workatoNotFoundHint,
  WorkatoDispatchError,
  type WorkatoTabInfo,
} from './tab-dispatch';
import {
  DEFAULT_INCLUDE,
  findStep,
  flattenAdapterFields,
  inspectStep,
  inspectSteps,
  listStepRefs,
  staticFieldKey,
  toCompactRecipe,
  type IncludeSection,
  type RawNode,
  type RecipeVersion,
  type StaticFieldIndex,
} from './recipe-view';
import { fetchAdapterMetaInPage, findOperationInputFields } from './adapter-meta';
import {
  DEFAULT_COMPACT_BUDGET_CHARS,
  DEFAULT_STEP_BUDGET_CHARS,
  decodeCursor,
  normalizeBudgetChars,
  normalizeMaxItems,
  readPaths,
} from './recipe-projection';
import {
  buildRecipeCodeUrlTemplate,
  cachedRecipeVersions,
  getRecipeSnapshot,
  invalidateRecipeSnapshot,
  putRecipeSnapshot,
} from './recipe-snapshot';

interface PullRecipeArgs {
  recipe_id: number;
  view?: 'compact' | 'full' | 'outline';
  step?: string;
  /** Several step refs read against one snapshot. */
  steps?: string[];
  /** Sections of a step view to return. Default ['mappings','fields']. */
  include?: IncludeSection[];
  /** Exact input paths, returned losslessly. */
  paths?: string[];
  /** Field/datapill/mapping filter. `field_query` is the older name. */
  fields?: string;
  field_query?: string;
  /** Items per list. Default 60, hard max 500. */
  max_items?: number;
  /** Character budget for the response. */
  budget_chars?: number;
  /** Continuation token from a previous truncated response. */
  cursor?: string;
  /** Return {unchanged:true} when the recipe is still at this version. */
  if_version?: number;
  /** In-page script timeout. Default 30000, clamped 10000 to 110000. */
  timeout_ms?: number;
  tabId?: number;
}

interface InPageResult {
  ok: boolean;
  /** present when ok=true and the code fetch was not skipped */
  code?: unknown;
  /** length of the code JSON as the API returned it */
  code_chars?: number;
  /** true when the version was already known to the caller and code was skipped */
  code_skipped?: boolean;
  version?: {
    version_no: number;
    name: string;
    folder_id: number;
    config: string;
    visibility_private: boolean;
    description: string;
    worker_concurrency: number;
    job_data_retention_policy: string;
  };
  /** present when ok=false */
  failure?: {
    stage: 'meta' | 'code' | 'shape';
    status?: number;
    body_excerpt?: string;
    message: string;
  };
}

/**
 * Function executed in the Workato tab's MAIN world. MUST be self-contained
 * and MUST NOT use `async`/`await` — WXT/Vite rewrites async function
 * declarations into a sync wrapper that calls a hoisted `_<name>` helper.
 * Only the wrapper survives `Function.prototype.toString()`, so the helper
 * reference dangles in the page context ("ReferenceError: _pullInPage is not
 * defined"). Promise chains pass through the bundler untouched.
 *
 * Metadata is fetched first and the code is then pinned to the version it
 * reported, so the two halves of the answer describe the same snapshot. When
 * that version is one the caller already holds (`skipVersions`), the code
 * fetch is skipped entirely and `code_skipped` says so.
 */
function pullInPage(
  recipeId: number,
  skipVersions: number[],
  codeUrlTemplate: string,
): Promise<InPageResult> {
  const fetchOpts: RequestInit = {
    credentials: 'include',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  };
  const fetchAndParse = (
    url: string,
  ): Promise<{ status: number; bodyText: string; json: unknown }> =>
    fetch(url, fetchOpts).then((r) =>
      r.text().then((bodyText) => {
        let json: unknown = null;
        try {
          json = JSON.parse(bodyText);
        } catch {
          /* keep raw body for diagnostics */
        }
        return { status: r.status, bodyText, json };
      }),
    );

  return fetchAndParse(`/recipes/${recipeId}.json?error_format=json`).then((meta) => {
    if (meta.status < 200 || meta.status >= 300) {
      return {
        ok: false,
        failure: {
          stage: 'meta' as const,
          status: meta.status,
          body_excerpt: meta.bodyText.slice(0, 1024),
          message: `GET /recipes/${recipeId}.json returned HTTP ${meta.status}`,
        },
      };
    }

    // Shape: meta.result.recipe_data.flow.{version_no,name,folder_id,config,...}
    const flow = (meta.json as any)?.result?.recipe_data?.flow;
    if (!flow) {
      return {
        ok: false,
        failure: {
          stage: 'shape' as const,
          body_excerpt: JSON.stringify({
            meta_keys: Object.keys((meta.json as any) ?? {}),
          }).slice(0, 1024),
          message:
            'Unexpected response shape — missing result.recipe_data.flow. ' +
            'Workato API may have drifted; check SKILL.md.',
        },
      };
    }

    const versionNo = Number(flow.version_no);
    if (!Number.isFinite(versionNo) || versionNo <= 0) {
      return {
        ok: false,
        failure: {
          stage: 'shape' as const,
          body_excerpt: JSON.stringify({ version_no: flow.version_no }).slice(0, 1024),
          message:
            `result.recipe_data.flow.version_no is not a positive finite number ` +
            `(got ${JSON.stringify(flow.version_no)}). Workato API may have drifted.`,
        },
      };
    }

    const version = {
      version_no: versionNo,
      name: String(flow.name ?? ''),
      folder_id: Number(flow.folder_id),
      config: typeof flow.config === 'string' ? flow.config : JSON.stringify(flow.config ?? {}),
      visibility_private: Boolean(flow.visibility_private),
      description: String(flow.description ?? ''),
      worker_concurrency: Number(flow.worker_concurrency ?? 1),
      job_data_retention_policy: String(flow.job_data_retention_policy ?? 'default'),
    };

    if (skipVersions && skipVersions.indexOf(versionNo) >= 0) {
      return { ok: true, code_skipped: true, version: version };
    }

    return fetchAndParse(codeUrlTemplate.replace('{version}', String(versionNo))).then((code) => {
      if (code.status < 200 || code.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'code' as const,
            status: code.status,
            body_excerpt: code.bodyText.slice(0, 1024),
            message: `GET /recipes/${recipeId}/code.json returned HTTP ${code.status}`,
          },
        };
      }

      // code.result === "<stringified JSON of code tree>"
      const codeStr = (code.json as any)?.result;
      if (typeof codeStr !== 'string') {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: JSON.stringify({
              code_keys: Object.keys((code.json as any) ?? {}),
            }).slice(0, 1024),
            message:
              'Unexpected response shape — result is not a code string. ' +
              'Workato API may have drifted; check SKILL.md.',
          },
        };
      }

      let parsedCode: unknown;
      try {
        parsedCode = JSON.parse(codeStr);
      } catch (e) {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: codeStr.slice(0, 1024),
            message: `JSON.parse(code.result) failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }

      return {
        ok: true,
        code: parsedCode,
        code_chars: codeStr.length,
        code_skipped: false,
        version: version,
      };
    });
  });
}

function describeFailure(recipeId: number, result: InPageResult): string {
  return (
    `WorkatoApiError (${result.failure?.stage}): ${result.failure?.message}` +
    workatoNotFoundHint(result.failure?.status) +
    (result.failure?.body_excerpt ? `\n--- body excerpt ---\n${result.failure.body_excerpt}` : '')
  );
}

export type RecipeSnapshotResult =
  | {
      ok: true;
      /** true when if_version matched: no code was fetched */
      unchanged: boolean;
      version: NonNullable<InPageResult['version']>;
      code: RawNode;
      /** true when the code came from the service-worker snapshot cache */
      cacheHit: boolean;
    }
  | { ok: false; error: string };

/**
 * Fetch (or reuse) one recipe snapshot: metadata always fresh, code pinned to
 * the version the metadata reported. Shared by `workato_pull_recipe` and
 * `workato_recipe_grep` so a second read of the same version costs no fetch.
 */
export async function loadRecipeSnapshot(
  tab: WorkatoTabInfo,
  recipeId: number,
  opts: { timeoutMs: number; ifVersion?: number },
): Promise<RecipeSnapshotResult> {
  const template = buildRecipeCodeUrlTemplate(recipeId);
  const skip: number[] = [];
  if (typeof opts.ifVersion === 'number' && opts.ifVersion > 0) skip.push(opts.ifVersion);
  for (const version of cachedRecipeVersions(tab.host, recipeId)) {
    if (skip.indexOf(version) < 0) skip.push(version);
  }

  let result = await runInWorkatoTab(tab.tabId, pullInPage, [recipeId, skip, template], {
    timeoutMs: opts.timeoutMs,
  });
  if (!result.ok || !result.version) {
    return { ok: false, error: describeFailure(recipeId, result) };
  }

  if (typeof opts.ifVersion === 'number' && result.version.version_no === opts.ifVersion) {
    return {
      ok: true,
      unchanged: true,
      version: result.version,
      code: {} as RawNode,
      cacheHit: false,
    };
  }

  let cacheHit = false;
  let code: RawNode | null = null;
  if (result.code_skipped) {
    const cached = getRecipeSnapshot(tab.host, recipeId, result.version.version_no);
    if (cached) {
      code = cached.code;
      cacheHit = true;
    } else {
      // Evicted between the peek and the fetch. Ask again without the skip
      // list rather than serving a version we no longer hold.
      result = await runInWorkatoTab(tab.tabId, pullInPage, [recipeId, [], template], {
        timeoutMs: opts.timeoutMs,
      });
      if (!result.ok || !result.version) {
        return { ok: false, error: describeFailure(recipeId, result) };
      }
      code = result.code as RawNode;
    }
  } else {
    code = result.code as RawNode;
  }

  if (!cacheHit && code) {
    // Older versions of this recipe can never be served again; drop them now
    // rather than waiting for the LRU to reach them.
    invalidateRecipeSnapshot(recipeId);
    putRecipeSnapshot({
      host: tab.host,
      recipe_id: recipeId,
      version_no: result.version.version_no,
      code,
      version: result.version as unknown as RecipeVersion,
      chars: result.code_chars ?? 0,
      stored_at: Date.now(),
    });
  }

  return { ok: true, unchanged: false, version: result.version, code: code as RawNode, cacheHit };
}

/**
 * Steps that declare no input schema of their own but do name an app operation.
 * Those are the ones whose `fields` list would otherwise come back empty, which
 * reads as "this step takes nothing" rather than "the schema lives on the
 * adapter". Connectionless built-ins (logger, py_eval, the Variables actions)
 * are included: `/integrations/meta` describes them like any other adapter.
 */
export function stepsNeedingStaticFields(
  nodes: readonly RawNode[],
): Array<{ provider: string; name: string }> {
  const seen = new Set<string>();
  const wanted: Array<{ provider: string; name: string }> = [];
  for (const node of nodes) {
    const schema = node.extended_input_schema;
    if (Array.isArray(schema) && schema.length > 0) continue;
    const provider = typeof node.provider === 'string' ? node.provider : '';
    const name = typeof node.name === 'string' ? node.name : '';
    if (!provider || !name) continue;
    const key = staticFieldKey(provider, name);
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push({ provider, name });
  }
  return wanted;
}

/** Turn one raw `/integrations/meta` document into the merge index. */
export function buildStaticFieldIndex(
  meta: unknown,
  wanted: ReadonlyArray<{ provider: string; name: string }>,
): StaticFieldIndex {
  const index: StaticFieldIndex = {};
  for (const entry of wanted) {
    const found = findOperationInputFields(meta, entry.provider, entry.name);
    if (!found) continue;
    index[staticFieldKey(entry.provider, entry.name)] = {
      fields: flattenAdapterFields(found.fields),
      // An operation that derives its input per connection/object publishes a
      // floor, not the whole set; saying otherwise would repeat the mistake
      // this merge exists to fix.
      complete: !found.extends_input_schema,
    };
  }
  return index;
}

const INCLUDE_SECTIONS: IncludeSection[] = ['mappings', 'fields', 'datapills', 'schemas', 'code'];

function normalizeStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') return null;
    out.push(entry.trim());
  }
  return out;
}

class WorkatoPullRecipeTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.PULL_RECIPE;

  async execute(args: PullRecipeArgs): Promise<ToolResult> {
    try {
      if (typeof args?.recipe_id !== 'number' || !Number.isFinite(args.recipe_id)) {
        return createErrorResponse('Param [recipe_id] must be a finite number');
      }

      const view = args.view ?? 'compact';
      if (view !== 'compact' && view !== 'full' && view !== 'outline') {
        return createErrorResponse("Param [view] must be 'compact', 'outline', or 'full'");
      }
      if (args.step != null && args.steps != null) {
        return createErrorResponse('Pass either [step] or [steps], not both');
      }

      const stepRefs = normalizeStringArray(args.steps);
      if (stepRefs === null) {
        return createErrorResponse('Param [steps] must be an array of non-empty step refs');
      }
      const refs = args.step != null ? [String(args.step)] : stepRefs;

      const fieldQuery = args.fields ?? args.field_query;
      if (fieldQuery != null && refs.length === 0) {
        return createErrorResponse(
          'Param [fields] (alias [field_query]) requires [step] or [steps]',
        );
      }

      const paths = normalizeStringArray(args.paths);
      if (paths === null) {
        return createErrorResponse('Param [paths] must be an array of non-empty paths');
      }

      let include: IncludeSection[] | undefined;
      if (args.include != null) {
        if (!Array.isArray(args.include)) {
          return createErrorResponse('Param [include] must be an array');
        }
        for (const section of args.include) {
          if (!INCLUDE_SECTIONS.includes(section)) {
            return createErrorResponse(
              `Param [include] accepts ${INCLUDE_SECTIONS.join(', ')}, got "${String(section)}"`,
            );
          }
        }
        include = args.include.length > 0 ? [...args.include] : DEFAULT_INCLUDE;
      }

      let cursorState = null;
      if (args.cursor != null) {
        cursorState = decodeCursor(String(args.cursor));
        if (!cursorState) {
          return createErrorResponse(
            'Param [cursor] is not a cursor this tool produced. Drop it to start over.',
          );
        }
      }

      if (args.if_version != null) {
        if (typeof args.if_version !== 'number' || !Number.isFinite(args.if_version)) {
          return createErrorResponse('Param [if_version] must be a version number');
        }
      }

      const maxItems = normalizeMaxItems(args.max_items);
      const budgetChars = normalizeBudgetChars(
        args.budget_chars,
        refs.length > 0 ? DEFAULT_STEP_BUDGET_CHARS : DEFAULT_COMPACT_BUDGET_CHARS,
      );

      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 30_000, 10_000), 110_000);
      const tab = await findWorkatoTab(args.tabId);
      const snapshot = await loadRecipeSnapshot(tab, args.recipe_id, {
        timeoutMs,
        ifVersion: args.if_version,
      });
      if (!snapshot.ok) return createErrorResponse(snapshot.error);

      if (snapshot.unchanged) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                recipe_id: args.recipe_id,
                version_no: snapshot.version.version_no,
                unchanged: true,
              }),
            },
          ],
          isError: false,
        };
      }

      const code = snapshot.code;
      const version = snapshot.version;
      const versionNo = version.version_no;
      let payload: Record<string, unknown>;

      if (refs.length > 0) {
        const resolved: Array<{ ref: string; node: RawNode }> = [];
        const notFound: string[] = [];
        for (const ref of refs) {
          const node = findStep(code, ref);
          if (node) resolved.push({ ref, node });
          else notFound.push(ref);
        }
        if (resolved.length === 0) {
          const available = listStepRefs(code)
            .map((r) => `${r.n ?? '?'}:${r.as ?? '?'}`)
            .join(', ');
          return createErrorResponse(
            `Step [${notFound.join(', ')}] not found in recipe ${args.recipe_id}. ` +
              `Available steps (number:as): ${available}`,
          );
        }

        // One adapter-meta read for the whole call, and only when the caller
        // asked for fields and at least one resolved step declares none. The
        // fetch is best effort: a failure leaves fields_complete false rather
        // than failing the read.
        let staticFields: StaticFieldIndex | undefined;
        const wantFields = (include ?? DEFAULT_INCLUDE).includes('fields');
        if (view !== 'full' && wantFields) {
          const wanted = stepsNeedingStaticFields(resolved.map((entry) => entry.node));
          if (wanted.length > 0) {
            const providers = [...new Set(wanted.map((entry) => entry.provider))];
            try {
              const meta = await runInWorkatoTab(tab.tabId, fetchAdapterMetaInPage, [providers], {
                timeoutMs: Math.min(timeoutMs, 30_000),
              });
              if (meta.ok) staticFields = buildStaticFieldIndex(meta.meta, wanted);
            } catch {
              /* the adapter meta is an enrichment; the step view stands without it */
            }
          }
        }

        if (view === 'full') {
          payload = {
            recipe_id: args.recipe_id,
            version_no: versionNo,
            version,
            cache_hit: snapshot.cacheHit,
          };
          if (args.step != null) payload.step = resolved[0].node;
          else payload.steps = resolved.map((entry) => entry.node);
          if (notFound.length > 0) payload.not_found = notFound;
          if (paths.length > 0) payload.paths = readPaths(resolved[0].node, paths);
        } else if (args.step != null) {
          payload = {
            ...inspectStep(code, resolved[0].node, args.recipe_id, {
              include,
              fieldQuery,
              paths,
              maxItems,
              budgetChars,
              offsets: cursorState?.o,
              versionNo,
              staticFields,
            }),
            cache_hit: snapshot.cacheHit,
          };
          if (notFound.length > 0) payload.not_found = notFound;
        } else {
          payload = {
            ...inspectSteps(code, resolved, args.recipe_id, {
              include,
              fieldQuery,
              paths,
              maxItems,
              budgetChars,
              offsets: cursorState?.o,
              stepOffset: cursorState?.s,
              versionNo,
              notFound,
              staticFields,
            }),
            cache_hit: snapshot.cacheHit,
          };
        }
      } else if (view === 'full') {
        payload = {
          recipe_id: args.recipe_id,
          code,
          version,
          version_no: versionNo,
          cache_hit: snapshot.cacheHit,
        };
        if (paths.length > 0) payload.paths = readPaths(code, paths);
      } else {
        payload = {
          ...toCompactRecipe(
            code,
            args.recipe_id,
            version as unknown as RecipeVersion,
            view === 'outline',
            {
              maxItems,
              budgetChars,
              offset: cursorState?.o?.steps,
              keepCode: include?.includes('code'),
            },
          ),
          cache_hit: snapshot.cacheHit,
        };
        if (paths.length > 0) payload.paths = readPaths(code, paths);
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
        `workato_pull_recipe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const workatoPullRecipeTool = new WorkatoPullRecipeTool();
