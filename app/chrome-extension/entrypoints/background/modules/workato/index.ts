/**
 * The Workato module, extension side: its executors and the afterCall hook
 * that appends the tab's workspace context block to every Workato result.
 */

// The id and title only: WORKATO_MODULE would bring every Workato schema along.
import {
  WORKATO_MODULE_ID,
  WORKATO_MODULE_TITLE,
  WORKATO_TAB_SHARED_TOOL_NAMES,
} from '@mokuhub/mokutab-shared';
import type { ExtensionModule, ModuleToolExecutor } from '../../extension-module';
import * as workatoTools from './tools/workato';
import * as workatoUiTools from './tools/workato-ui';
import * as workatoLookupTools from './tools/workato-lookup';
import * as workatoLcapTools from './tools/workato-lcap';
import * as workatoDataTableTools from './tools/workato-data-table';
import * as workatoSessionTools from './tools/workato-session';
import { maybeAppendContextBlock } from './tools/workato/session-context';

const executors = Object.values({
  ...workatoTools,
  ...workatoUiTools,
  ...workatoLookupTools,
  ...workatoLcapTools,
  ...workatoDataTableTools,
  ...workatoSessionTools,
} as Record<string, unknown>).filter(
  (value): value is ModuleToolExecutor =>
    !!value &&
    typeof (value as ModuleToolExecutor).name === 'string' &&
    typeof (value as ModuleToolExecutor).execute === 'function',
);

const TAB_SHARED = new Set(WORKATO_TAB_SHARED_TOOL_NAMES);

const DESCRIPTION_KEY = 'moduleDescription_workato';
const DESCRIPTION = 'Recipes, jobs, connections, tables and Workflow App pages in Workato.';

/** The popup line: the locale's text when there is one, this module's own otherwise. */
function description(): string {
  try {
    return chrome.i18n?.getMessage?.(DESCRIPTION_KEY) || DESCRIPTION;
  } catch {
    return DESCRIPTION;
  }
}

export const workatoExtensionModule: ExtensionModule = {
  id: WORKATO_MODULE_ID,
  title: WORKATO_MODULE_TITLE,
  description: description(),
  executors,
  // Say which tab/workspace the call actually ran in. Best effort: it never
  // turns a successful call into a failure (see maybeAppendContextBlock).
  afterCall: maybeAppendContextBlock,
  // The read tools that are only fetches from the page.
  sharesTab: (name) => TAB_SHARED.has(name),
};
