import { createCodeGraphPlugin } from "./internal.js"

/**
 * OpenCode 的 legacy loader 要求插件模块的每个 export 都是函数；因此公开
 * 入口只保留这个 default。第二个参数用于 OpenCode 的 plugin tuple options。
 *
 * @param {import("@opencode-ai/plugin").PluginInput} input
 * @param {{ enabled?: boolean }} [options]
 * @returns {Promise<import("@opencode-ai/plugin").Hooks>}
 */
export default async function opencodeCodeGraphBridge(input, options) {
  return createCodeGraphPlugin(options)(input)
}
