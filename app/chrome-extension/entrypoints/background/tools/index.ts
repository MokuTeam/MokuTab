import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { moduleOffMessage } from '@mokuhub/mokutab-shared';
import * as browserTools from './browser';
import { EXTENSION_MODULES } from '../modules';
import { moduleEnabled, type ExtensionModule } from '../extension-module';
import { runExclusiveForTab, runSharedForTab } from './tab-queue';
import { setLeasedTabs } from '../leased-tabs';

const toolsMap = new Map<string, any>(
  Object.values(browserTools as Record<string, any>).map((tool: any) => [tool.name, tool]),
);
/** The module each module tool belongs to. */
const ownerOf = new Map<string, ExtensionModule>();
for (const module of EXTENSION_MODULES) {
  for (const executor of module.executors) {
    toolsMap.set(executor.name, executor);
    ownerOf.set(executor.name, module);
  }
}

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
  /** Tabs leased by agents in this profile; the bridge sends it when there are any. */
  leasedTabs?: number[];
}

/**
 * Handle tool execution
 */
export const handleCallTool = async (param: ToolCallParam) => {
  setLeasedTabs(param.leasedTabs);
  const tool = toolsMap.get(param.name);
  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }
  // A module switched off in the bridge refuses here too: a bridge that did
  // not refuse (an older one, or the native-messaging path) gets the same answer.
  const owner = ownerOf.get(param.name);
  if (owner && !(await moduleEnabled(owner.id))) {
    return createErrorResponse(moduleOffMessage(owner, param.name));
  }
  const tabId = param.args?.tabId;
  // chrome_handle_dialog answers the dialog another call on this tab is blocked
  // on; queueing it behind that call would deadlock the tab.
  if (typeof tabId === 'number' && param.name !== 'chrome_handle_dialog') {
    // A module's fetch-only reads overlap on the tab; everything else takes it alone.
    const queue = owner?.sharesTab?.(param.name) ? runSharedForTab : runExclusiveForTab;
    return queue(tabId, () => executeTool(tool, param, owner));
  }
  return executeTool(tool, param, owner);
};

async function executeTool(tool: any, param: ToolCallParam, owner?: ExtensionModule) {
  try {
    const result = await tool.execute(param.args);
    return owner?.afterCall ? await owner.afterCall(param.name, param.args, result) : result;
  } catch (error) {
    console.error(`Tool execution failed for ${param.name}:`, error);
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
  }
}
