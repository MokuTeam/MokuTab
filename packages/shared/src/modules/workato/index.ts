import type { ToolModule } from '../../module';
import { WORKATO_TOOL_ALIASES } from './aliases';
import { WORKATO_INSTRUCTIONS } from './instructions';
import { WORKATO_TOOL_SCHEMAS } from './schemas';
import { WORKATO_DESTRUCTIVE_TOOL_NAMES, WORKATO_READ_ONLY_TOOL_NAMES } from './tool-kinds';

export { WORKATO_TOOL_NAMES } from './tool-names';
export { WORKATO_TOOL_SCHEMAS } from './schemas';
export { WORKATO_INSTRUCTIONS } from './instructions';
export { WORKATO_TOOL_ALIASES } from './aliases';
export {
  WORKATO_DESTRUCTIVE_TOOL_NAMES,
  WORKATO_READ_ONLY_TOOL_NAMES,
  WORKATO_TAB_SHARED_TOOL_NAMES,
} from './tool-kinds';

/**
 * The id and title on their own, for code that needs no schemas (the
 * extension): its bundler keeps a whole object literal when one property is
 * read, so reading WORKATO_MODULE.id would ship every Workato schema with it.
 */
export const WORKATO_MODULE_ID = 'workato';
export const WORKATO_MODULE_TITLE = 'Workato';

export const WORKATO_MODULE: ToolModule = {
  id: WORKATO_MODULE_ID,
  title: WORKATO_MODULE_TITLE,
  tools: WORKATO_TOOL_SCHEMAS,
  instructions: WORKATO_INSTRUCTIONS,
  aliases: WORKATO_TOOL_ALIASES,
  readOnlyTools: WORKATO_READ_ONLY_TOOL_NAMES,
  destructiveTools: WORKATO_DESTRUCTIVE_TOOL_NAMES,
};
