import { TOOL_NAMES } from '@mokuhub/mokutab-shared';
import { BaseBrowserToolExecutor } from '@/entrypoints/background/tools/base-browser';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { findWorkatoTab, runInWorkatoTab, WorkatoDispatchError } from './tab-dispatch';
import { assertExpectedContext, type ExpectedTabContext } from './session-context';

/**
 * Account (environment) and project properties.
 *
 * Endpoints (captured + verified live 2026-09-08, see
 * docs/design/specs/2026-09-08-account-project-properties-endpoints.md):
 *   GET    /account_properties.json            -> { result: [record] }
 *   POST   /account_properties.json            -> { result: record }
 *   PUT    /account_properties/<id>.json       -> { result: record }
 *   DELETE /account_properties/<id>.json       -> { result: record }
 *
 * One controller serves both scopes: a project property is the same route with
 * `?project_id=<project id>` appended. That is the PROJECT id, not the folder
 * id (workato_list_folders reports both on a project root).
 *
 * Two behaviours worth knowing:
 *   1. Rows are append-only. A successful PUT issues a NEW id and a new
 *      version_no, and requires last_version_no to match the current one.
 *   2. Validation failures come back as HTTP 200 with an error envelope,
 *      { error: { details: { name: ["has already been taken"] } } }, so a
 *      status check alone would read them as success.
 *
 * Workato marks a property sensitive when its name contains password, key or
 * secret, but the JSON API returns the value in the clear regardless: the
 * masking below is this tool's, not the platform's.
 */

interface PageFailure {
  stage: 'csrf' | 'fetch' | 'api' | 'shape';
  status?: number;
  body_excerpt?: string;
  message: string;
}

export interface PropertyRecord {
  id: number;
  name: string;
  value: string;
  version_no: string;
  sensitive: boolean;
}

interface PropertiesInPageResult {
  ok: boolean;
  properties?: PropertyRecord[];
  property?: PropertyRecord;
  /** Message parsed out of Workato's HTTP-200 error envelope, when there was one. */
  api_error?: string;
  failure?: PageFailure;
}

/**
 * Runs in the Workato tab's MAIN world. Self-contained, promise-chain based,
 * every helper declared inline (see pull-recipe.ts for why async/await and
 * module-scope references are forbidden here).
 *
 * op is 'list' | 'create' | 'update' | 'delete'. Unused arguments are null.
 */
export function propertiesInPage(
  op: string,
  projectId: number | null,
  propertyId: number | null,
  name: string | null,
  value: string | null,
  lastVersionNo: string | null,
): Promise<PropertiesInPageResult> {
  function readCookie(n: string): string | null {
    const escaped = n.replace(/[-.+*]/g, '\\$&');
    const m = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function firstApiError(json: any): string | null {
    const err = json && json.error;
    if (err === undefined || err === null) return null;
    if (typeof err === 'string') return err;
    const details = err.details;
    if (details && typeof details === 'object') {
      const parts: string[] = [];
      const keys = Object.keys(details);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const raw = details[key];
        const text = Array.isArray(raw) ? raw.join(', ') : String(raw);
        parts.push(key === 'base' ? text : key + ' ' + text);
      }
      if (parts.length > 0) return parts.join('; ');
    }
    if (typeof err.message === 'string') return err.message;
    return JSON.stringify(err).slice(0, 300);
  }

  function toRecord(raw: any): PropertyRecord {
    return {
      id: typeof raw.id === 'number' ? raw.id : Number(raw.id),
      name: raw.name === undefined || raw.name === null ? '' : String(raw.name),
      value: raw.value === undefined || raw.value === null ? '' : String(raw.value),
      version_no:
        raw.version_no === undefined || raw.version_no === null ? '' : String(raw.version_no),
      sensitive: raw.sensitive === true,
    };
  }

  const query =
    projectId === null || projectId === undefined
      ? ''
      : '?project_id=' + encodeURIComponent(String(projectId));

  let method = 'GET';
  let url = '/account_properties.json' + query;
  let body: string | null = null;
  if (op === 'create') {
    method = 'POST';
    body = JSON.stringify({ account_property: { name: name, value: value } });
  } else if (op === 'update') {
    method = 'PUT';
    url = '/account_properties/' + propertyId + '.json' + query;
    body = JSON.stringify({
      account_property: { name: name, value: value, last_version_no: lastVersionNo },
    });
  } else if (op === 'delete') {
    method = 'DELETE';
    url = '/account_properties/' + propertyId + '.json' + query;
  }

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
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
        failure: {
          stage: 'csrf' as const,
          message:
            'could not find CSRF token in XSRF-TOKEN-V2 cookie or meta tag; ensure the target tab is a logged-in Workato page',
        },
      });
    }
    headers['x-csrf-token'] = csrf;
  }
  if (body !== null) headers['content-type'] = 'application/json';

  const options: RequestInit = { method: method, credentials: 'include', headers: headers };
  if (body !== null) options.body = body;

  return fetch(url, options).then((r) =>
    r.text().then((bodyText) => {
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          failure: {
            stage: 'fetch' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: method + ' ' + url + ' returned HTTP ' + r.status,
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
            body_excerpt: bodyText.slice(0, 1024),
            message: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }
      const apiError = firstApiError(json);
      if (apiError !== null) {
        return {
          ok: false,
          api_error: apiError,
          failure: {
            stage: 'api' as const,
            status: r.status,
            body_excerpt: bodyText.slice(0, 1024),
            message: apiError,
          },
        };
      }
      const result = json && json.result;
      if (op === 'list') {
        if (!Array.isArray(result)) {
          return {
            ok: false,
            failure: {
              stage: 'shape' as const,
              body_excerpt: bodyText.slice(0, 1024),
              message: 'Unexpected response shape: result is not an array.',
            },
          };
        }
        const properties: PropertyRecord[] = [];
        for (let i = 0; i < result.length; i += 1) properties.push(toRecord(result[i]));
        return { ok: true, properties: properties };
      }
      if (!result || typeof result !== 'object') {
        return {
          ok: false,
          failure: {
            stage: 'shape' as const,
            body_excerpt: bodyText.slice(0, 1024),
            message: 'Unexpected response shape: missing result object.',
          },
        };
      }
      return { ok: true, property: toRecord(result) };
    }),
  );
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

export interface ShapedProperty {
  id: number;
  name: string;
  value: string;
  version_no: string;
  sensitive: boolean;
  value_masked?: true;
}

/**
 * The mask the Workato UI shows for a sensitive property: a fixed run of X
 * followed by the last three characters. Short values keep nothing, so the
 * mask can never be most of the secret.
 */
export function maskPropertyValue(value: string): string {
  if (value.length === 0) return '';
  const tail = value.length > 3 ? value.slice(-3) : '';
  return 'XXXXXXXXXX' + tail;
}

/** Response shape for one property, masked unless the caller asked to reveal. */
export function shapeProperty(record: PropertyRecord, reveal: boolean): ShapedProperty {
  if (!record.sensitive || reveal) {
    return {
      id: record.id,
      name: record.name,
      value: record.value,
      version_no: record.version_no,
      sensitive: record.sensitive,
    };
  }
  return {
    id: record.id,
    name: record.name,
    value: maskPropertyValue(record.value),
    version_no: record.version_no,
    sensitive: true,
    value_masked: true,
  };
}

/**
 * Client-side name filter: an exact match wins outright, otherwise every
 * case-insensitive substring match. Workato ignores every search parameter on
 * this route, so the filtering has to happen here.
 */
export function filterPropertiesByName(
  properties: PropertyRecord[],
  name: string,
): PropertyRecord[] {
  const exact = properties.filter((p) => p.name === name);
  if (exact.length > 0) return exact;
  const needle = name.toLowerCase();
  return properties.filter((p) => p.name.toLowerCase().includes(needle));
}

export type NameResolution =
  | { status: 'found'; property: PropertyRecord }
  | { status: 'not_found'; suggestions: string[] }
  | { status: 'ambiguous'; matches: PropertyRecord[] };

/**
 * Resolve one property by name for a delete: exact match first, then a
 * case-insensitive exact match. Anything else is refused rather than guessed.
 */
export function resolvePropertyByName(properties: PropertyRecord[], name: string): NameResolution {
  const exact = properties.filter((p) => p.name === name);
  if (exact.length === 1) return { status: 'found', property: exact[0] };
  if (exact.length > 1) return { status: 'ambiguous', matches: exact };
  const needle = name.toLowerCase();
  const insensitive = properties.filter((p) => p.name.toLowerCase() === needle);
  if (insensitive.length === 1) return { status: 'found', property: insensitive[0] };
  if (insensitive.length > 1) return { status: 'ambiguous', matches: insensitive };
  const suggestions = properties
    .filter((p) => p.name.toLowerCase().includes(needle))
    .map((p) => p.name)
    .slice(0, 5);
  return { status: 'not_found', suggestions };
}

export type UpsertDecision =
  | { action: 'create' }
  | { action: 'update'; id: number; last_version_no: string; current: PropertyRecord }
  | { action: 'conflict'; reason: 'stale_version' | 'case_variant'; message: string };

/**
 * Decide what a `set` does: PUT the exact name when it exists, POST when it
 * does not. A caller-supplied expected_version_no that no longer matches is a
 * conflict here, before any write. A name that differs only in case from an
 * existing property is refused too: creating it would leave two properties
 * that read as one.
 */
export function decideUpsert(
  properties: PropertyRecord[],
  name: string,
  expectedVersionNo?: string,
): UpsertDecision {
  const exact = properties.filter((p) => p.name === name);
  if (exact.length > 0) {
    const current = exact[0];
    if (
      typeof expectedVersionNo === 'string' &&
      expectedVersionNo.length > 0 &&
      expectedVersionNo !== current.version_no
    ) {
      return {
        action: 'conflict',
        reason: 'stale_version',
        message:
          `VersionConflict: property "${name}" is at version_no ${current.version_no} ` +
          `(id ${current.id}), but expected_version_no was ${expectedVersionNo}. ` +
          'Someone else changed it. Re-read it with action "list" and retry.',
      };
    }
    return {
      action: 'update',
      id: current.id,
      last_version_no:
        typeof expectedVersionNo === 'string' && expectedVersionNo.length > 0
          ? expectedVersionNo
          : current.version_no,
      current,
    };
  }
  const needle = name.toLowerCase();
  const variants = properties.filter((p) => p.name.toLowerCase() === needle);
  if (variants.length > 0) {
    return {
      action: 'conflict',
      reason: 'case_variant',
      message:
        `NameCaseMismatch: no property is named exactly "${name}", but ` +
        `"${variants[0].name}" differs only in case. Creating "${name}" would leave two ` +
        'properties that read as one. Use the existing name, or pick a clearly different one.',
    };
  }
  return { action: 'create' };
}

/**
 * Pull a message out of Workato's HTTP-200 error envelope, given the raw body
 * text. Returns null when the body carries no error.
 */
export function parseErrorEnvelope(bodyText: string): string | null {
  let json: any;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const err = json?.error;
  if (err === undefined || err === null) return null;
  if (typeof err === 'string') return err;
  const details = err.details;
  if (details && typeof details === 'object') {
    const parts: string[] = [];
    for (const [key, raw] of Object.entries(details as Record<string, unknown>)) {
      const text = Array.isArray(raw) ? raw.join(', ') : String(raw);
      parts.push(key === 'base' ? text : `${key} ${text}`);
    }
    if (parts.length > 0) return parts.join('; ');
  }
  if (typeof err.message === 'string') return err.message;
  return JSON.stringify(err).slice(0, 300);
}

export function isStaleRowError(message: string): boolean {
  return /stale row/i.test(message);
}

export function isDuplicateNameError(message: string): boolean {
  return /has already been taken/i.test(message);
}

// ---------------------------------------------------------------------------
// workato_properties
// ---------------------------------------------------------------------------

type PropertiesAction = 'list' | 'set' | 'delete';
type PropertiesScope = 'account' | 'project';

interface PropertiesArgs {
  action?: PropertiesAction;
  scope?: PropertiesScope;
  project_id?: number;
  name?: string;
  value?: string;
  rename_to?: string;
  expected_version_no?: string;
  id?: number;
  reveal?: boolean;
  tabId?: number;
  /** Workspace/environment the caller expects this tab to be in (bridge-injected). */
  expected_context?: ExpectedTabContext;
}

function apiErrorResponse(result: PropertiesInPageResult): ToolResult {
  const failure = result.failure;
  const parsed = failure?.body_excerpt ? parseErrorEnvelope(failure.body_excerpt) : null;
  const message = result.api_error ?? parsed ?? failure?.message ?? 'unknown failure';
  return createErrorResponse(
    `WorkatoApiError (${failure?.stage ?? 'unknown'}): ${message}` +
      (failure?.body_excerpt && failure.stage !== 'api'
        ? `\n--- body excerpt ---\n${failure.body_excerpt}`
        : ''),
  );
}

class WorkatoPropertiesTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.WORKATO.PROPERTIES;

  async execute(args: PropertiesArgs): Promise<ToolResult> {
    try {
      const action: PropertiesAction = args?.action ?? 'list';
      if (action !== 'list' && action !== 'set' && action !== 'delete') {
        return createErrorResponse(
          `Param [action] must be one of "list", "set", "delete" (got "${String(args?.action)}")`,
        );
      }
      const scope: PropertiesScope = args?.scope ?? 'account';
      if (scope !== 'account' && scope !== 'project') {
        return createErrorResponse(
          `Param [scope] must be "account" or "project" (got "${String(args?.scope)}")`,
        );
      }
      let projectId: number | null = null;
      if (scope === 'project') {
        if (typeof args?.project_id !== 'number' || !Number.isFinite(args.project_id)) {
          return createErrorResponse(
            'Param [project_id] is required for scope "project" and must be a finite number. ' +
              'It is the PROJECT id, not the folder id: workato_list_folders reports it as ' +
              '`project_id` on each project root folder, next to the folder `id`.',
          );
        }
        projectId = args.project_id;
      } else if (args?.project_id !== undefined) {
        return createErrorResponse(
          'Param [project_id] only applies to scope "project". Pass scope:"project" with it, ' +
            'or drop it to read the account (environment) properties.',
        );
      }
      const reveal = args?.reveal === true;

      const tab = await findWorkatoTab(args?.tabId);

      if (action === 'list') return await this.list(tab.tabId, scope, projectId, args, reveal);
      await assertExpectedContext(args, tab.tabId);
      if (action === 'set') return await this.set(tab.tabId, scope, projectId, args, reveal);
      return await this.delete(tab.tabId, scope, projectId, args, reveal);
    } catch (err) {
      if (err instanceof WorkatoDispatchError) {
        return createErrorResponse(`${err.message}`);
      }
      return createErrorResponse(
        `workato_properties failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async fetchAll(tabId: number, projectId: number | null): Promise<PropertyRecord[]> {
    const result = await runInWorkatoTab(tabId, propertiesInPage, [
      'list',
      projectId,
      null,
      null,
      null,
      null,
    ]);
    if (!result.ok || !result.properties) {
      if (
        projectId !== null &&
        result.failure?.stage === 'fetch' &&
        result.failure.status === 404
      ) {
        throw new WorkatoDispatchError(
          'ProjectNotFound',
          `project_id ${projectId} returned HTTP 404: it is not a project id in this workspace ` +
            '(a folder id gives 404 too). workato_list_folders reports the project_id on a project root.',
        );
      }
      throw new WorkatoDispatchError(
        'UnexpectedShape',
        `property list failed (${result.failure?.stage}): ${
          result.api_error ?? result.failure?.message ?? 'unknown'
        }`,
      );
    }
    return result.properties;
  }

  private async list(
    tabId: number,
    scope: PropertiesScope,
    projectId: number | null,
    args: PropertiesArgs,
    reveal: boolean,
  ): Promise<ToolResult> {
    const all = await this.fetchAll(tabId, projectId);
    const nameFilter = typeof args?.name === 'string' && args.name.length > 0 ? args.name : null;
    const selected = nameFilter === null ? all : filterPropertiesByName(all, nameFilter);

    const payload: Record<string, unknown> = { scope };
    if (projectId !== null) payload.project_id = projectId;
    payload.count = selected.length;
    if (nameFilter !== null) payload.total_count = all.length;
    payload.properties = selected.map((p) => shapeProperty(p, reveal));
    if (scope === 'project' && all.length === 0) {
      payload.note =
        `No properties in project ${projectId}. If that is a surprise, check that ${projectId} ` +
        'is the PROJECT id and not a folder id: workato_list_folders reports both on a project root.';
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
  }

  private async set(
    tabId: number,
    scope: PropertiesScope,
    projectId: number | null,
    args: PropertiesArgs,
    reveal: boolean,
  ): Promise<ToolResult> {
    if (typeof args?.name !== 'string' || args.name.trim().length === 0) {
      return createErrorResponse('Param [name] must be a non-empty string for action "set"');
    }
    if (typeof args.value !== 'string') {
      return createErrorResponse(
        'Param [value] must be a string for action "set" (an empty string is accepted and stores an empty value)',
      );
    }
    if (args.rename_to !== undefined) {
      if (typeof args.rename_to !== 'string' || args.rename_to.trim().length === 0) {
        return createErrorResponse('Param [rename_to] must be a non-empty string when present');
      }
    }
    if (args.id !== undefined) {
      return createErrorResponse(
        'Param [id] applies to action "delete" only. Action "set" resolves the property by [name].',
      );
    }

    const all = await this.fetchAll(tabId, projectId);
    const decision = decideUpsert(all, args.name, args.expected_version_no);
    if (decision.action === 'conflict') return createErrorResponse(decision.message);

    if (decision.action === 'create' && args.rename_to !== undefined) {
      return createErrorResponse(
        `NotFound: no property named "${args.name}" in scope ${scope}, so there is nothing to ` +
          'rename. Drop [rename_to] to create it, or pass the current name in [name].',
      );
    }

    const targetName = args.rename_to ?? args.name;
    const callArgs: [
      string,
      number | null,
      number | null,
      string | null,
      string | null,
      string | null,
    ] =
      decision.action === 'create'
        ? ['create', projectId, null, targetName, args.value, null]
        : ['update', projectId, decision.id, targetName, args.value, decision.last_version_no];
    const result: PropertiesInPageResult = await runInWorkatoTab(
      tabId,
      propertiesInPage,
      callArgs,
      { retryOnTimeout: false },
    );

    if (!result.ok || !result.property) {
      const apiError = result.api_error;
      if (apiError && decision.action === 'update' && isStaleRowError(apiError)) {
        return createErrorResponse(
          `VersionConflict: Workato refused the update of "${args.name}" as a stale row. ` +
            `The update sent last_version_no ${decision.last_version_no}` +
            (decision.last_version_no === decision.current.version_no
              ? ''
              : ` (from expected_version_no; the list showed ${decision.current.version_no})`) +
            '. The property changed between the read and the write. Re-read it with action ' +
            '"list" and retry with the version_no it reports.',
        );
      }
      if (apiError && decision.action === 'create' && isDuplicateNameError(apiError)) {
        return createErrorResponse(
          `DuplicateName: Workato rejected the create of "${targetName}" with "${apiError}". ` +
            "The property was created between this call's read and its write. Re-run the same " +
            'call: it will update the existing property instead.',
        );
      }
      return apiErrorResponse(result);
    }

    const payload: Record<string, unknown> = {
      action: decision.action === 'create' ? 'created' : 'updated',
      scope,
    };
    if (projectId !== null) payload.project_id = projectId;
    payload.property = shapeProperty(result.property, reveal);
    if (decision.action === 'update') {
      payload.previous = { id: decision.current.id, version_no: decision.current.version_no };
      if (args.rename_to !== undefined) payload.renamed_from = args.name;
    }
    const verb = decision.action === 'create' ? 'created' : 'updated';
    return {
      content: [
        {
          type: 'text',
          text:
            `${verb} ${scope} property "${result.property.name}" ` +
            `(id ${result.property.id}, version_no ${result.property.version_no})\n` +
            JSON.stringify(payload),
        },
      ],
      isError: false,
    };
  }

  private async delete(
    tabId: number,
    scope: PropertiesScope,
    projectId: number | null,
    args: PropertiesArgs,
    reveal: boolean,
  ): Promise<ToolResult> {
    const hasId = typeof args?.id === 'number' && Number.isFinite(args.id);
    const hasName = typeof args?.name === 'string' && args.name.trim().length > 0;
    if (!hasId && !hasName) {
      return createErrorResponse(
        'Action "delete" needs [name] (resolved to exactly one property) or [id].',
      );
    }

    const all = await this.fetchAll(tabId, projectId);
    let target: PropertyRecord | undefined;
    if (hasId) {
      target = all.find((p) => p.id === args.id);
      if (!target) {
        return createErrorResponse(
          `NotFound: no property with id ${args.id} in scope ${scope}. Ids change on every ` +
            'update, so one from an earlier read goes stale. Re-read with action "list".',
        );
      }
      if (hasName && target.name !== args.name) {
        return createErrorResponse(
          `Mismatch: id ${args.id} is property "${target.name}", not "${args.name}". ` +
            'Pass one of the two, not a pair that disagrees.',
        );
      }
    } else {
      const resolution = resolvePropertyByName(all, args.name as string);
      if (resolution.status === 'not_found') {
        return createErrorResponse(
          `NotFound: no property named "${args.name}" in scope ${scope}` +
            (resolution.suggestions.length > 0
              ? `. Similar names: ${resolution.suggestions.join(', ')}`
              : ` (${all.length} propert${all.length === 1 ? 'y' : 'ies'} in this scope)`),
        );
      }
      if (resolution.status === 'ambiguous') {
        return createErrorResponse(
          `Ambiguous: "${args.name}" matches ${resolution.matches.length} properties ` +
            `(ids ${resolution.matches.map((p) => p.id).join(', ')}). Pass [id] to pick one.`,
        );
      }
      target = resolution.property;
    }

    const result: PropertiesInPageResult = await runInWorkatoTab(
      tabId,
      propertiesInPage,
      ['delete', projectId, target.id, null, null, null],
      { retryOnTimeout: false },
    );
    if (!result.ok) return apiErrorResponse(result);

    const deleted = result.property ?? target;
    const payload: Record<string, unknown> = { action: 'deleted', scope };
    if (projectId !== null) payload.project_id = projectId;
    payload.property = shapeProperty(deleted, reveal);
    return {
      content: [
        {
          type: 'text',
          text:
            `deleted ${scope} property "${deleted.name}" (id ${deleted.id})\n` +
            JSON.stringify(payload),
        },
      ],
      isError: false,
    };
  }
}

export const workatoPropertiesTool = new WorkatoPropertiesTool();
