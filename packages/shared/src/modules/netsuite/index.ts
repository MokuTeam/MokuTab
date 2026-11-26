import type { ToolModule } from '../../module';
import { NETSUITE_INSTRUCTIONS } from './instructions';
import { NETSUITE_TOOL_SCHEMAS } from './schemas';
import { NETSUITE_DESTRUCTIVE_TOOL_NAMES, NETSUITE_READ_ONLY_TOOL_NAMES } from './tool-names';

export {
  NETSUITE_TOOL_NAMES,
  NETSUITE_READ_ONLY_TOOL_NAMES,
  NETSUITE_DESTRUCTIVE_TOOL_NAMES,
  NETSUITE_FN_TOOL_NAMES,
} from './tool-names';
export { NETSUITE_TOOL_SCHEMAS } from './schemas';
export { NETSUITE_INSTRUCTIONS } from './instructions';

/** The id and title on their own, for code that needs no schemas (the extension). */
export const NETSUITE_MODULE_ID = 'netsuite';
export const NETSUITE_MODULE_TITLE = 'NetSuite';

export const NETSUITE_MODULE: ToolModule = {
  id: NETSUITE_MODULE_ID,
  title: NETSUITE_MODULE_TITLE,
  tools: NETSUITE_TOOL_SCHEMAS,
  instructions: NETSUITE_INSTRUCTIONS,
  readOnlyTools: NETSUITE_READ_ONLY_TOOL_NAMES,
  destructiveTools: NETSUITE_DESTRUCTIVE_TOOL_NAMES,
};
