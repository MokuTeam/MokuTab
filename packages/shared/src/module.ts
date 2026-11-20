import { type Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * What every side knows about an installed module: its id, its tools and its
 * part of the server instructions. The bridge and the extension each wrap
 * this in their own module object (bridge hooks, extension executors).
 */
export interface ToolModule {
  /** Stable id: the key in the bridge config file, the popup switch, the refusal text. */
  id: string;
  /** Display name. */
  title: string;
  /** Tool schemas, listed only while the module is on. */
  tools: Tool[];
  /** Server-instructions snippet, appended to the core snippet while the module is on. */
  instructions: string;
  /**
   * Old tool names this module keeps working, each mapped to the tool it now
   * names. Listed (with that tool's schema) and routed only while the module
   * is on.
   */
  aliases?: Readonly<Record<string, string>>;
  /** Tools that change nothing: served with readOnlyHint. */
  readOnlyTools?: readonly string[];
  /** Tools whose whole job is to remove something: served with destructiveHint. */
  destructiveTools?: readonly string[];
}

/** Refusal for a call to a tool whose module is switched off. Same wording on both sides. */
export function moduleOffMessage(module: Pick<ToolModule, 'id' | 'title'>, tool: string): string {
  return (
    `Error: ${tool} belongs to the ${module.title} module, which is switched off on this ` +
    `machine. Nothing was sent. Turn it on in the MokuTab popup (Modules).`
  );
}

/** How an alias is listed: a pointer at the tool it names, not a second copy of its docs. */
export function aliasDescription(target: string): string {
  return `Old name of ${target}, kept until 3.0.`;
}

/** Refusal for an alias whose module is switched off; the tool it names works regardless. */
export function aliasOffMessage(
  module: Pick<ToolModule, 'title'>,
  alias: string,
  target: string,
): string {
  return (
    `Error: ${alias} is the old name of ${target}, kept by the ${module.title} module, which ` +
    `is switched off on this machine. Nothing was sent. Call ${target} instead.`
  );
}
