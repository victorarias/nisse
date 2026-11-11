// The tools a conversation on the kernel works with: the tools package's set, where the calls that change things ask
// a person first (D13).
import { defineExtension, type ToolRegistration } from "@nisse/harness"
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
