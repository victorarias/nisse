// The tools a conversation on the kernel works with: the tools package's set, where the calls that change things ask
// a person first (D13), and code mode, which models that take only code mode are offered instead of them.
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@nisse/codemode"
import type { CodemodeSandbox } from "@nisse/codemode/sandbox"
import { defineExtension, type Extension, type ToolRegistration } from "@nisse/harness"
import {
  createApplyPatchTool,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  rootConversationEnv,
} from "@nisse/tools"

const asking = <T extends ToolRegistration>(tool: T): T => ({ ...tool, asks: true })

export const NisseTools = defineExtension({
  name: "nisse-tools",
  tools: [
    createReadTool(),
    createGrepTool(),
    createGlobTool(),
    asking(createWriteTool()),
    asking(createEditTool()),
    asking(createApplyPatchTool()),
    asking(createBashTool({ prepare: rootConversationEnv })),
  ],
})

/**
 * The `codemode` extension, whose `codemode` tool is offered to the models that take only code mode (F10) and to no
 * other; its scripts call the conversation's other tools, each a nested call that asks like a direct one.
 */
export const codeModeTools = (sandbox: CodemodeSandbox): Extension => {
  const extension = createCodemodeExtension({ sandbox })
  return {
    ...extension,
    tools: extension.tools!.map((tool) => (tool.name === CODEMODE_TOOL_NAME ? { ...tool, codeMode: true } : tool)),
  }
}
