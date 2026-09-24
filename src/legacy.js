import { normalizeProjectRoot, resolveRuntime } from "./internal.js"
import { updatePluginVersion } from "./update.js"

const SYSTEM_PROMPT = "When CodeGraph tools are available in this session, use their exploration capability first to locate and understand relevant code before broad searches or reading unrelated files. Follow their provided instructions and use returned context for targeted reads; avoid re-fetching context already available. If the tools are unavailable or results are insufficient or stale, fall back to permitted file-reading and search tools."

function fallbackLog(message) {
  console.error(`[opencode-codegraph-bridge] ${message}`)
}

function log(input, message) {
  const appLog = input?.client?.app?.log
  if (typeof appLog === "function") {
    Promise.resolve(appLog.call(input.client.app, {
      body: { service: "opencode-codegraph-bridge", level: "info", message },
    })).catch(() => fallbackLog(message))
    return
  }
  fallbackLog(message)
}

/** OpenCode v1 plugin API adapter. */
export default async function legacy(input, options = {}, dependencies = {}) {
  const enabled = options.enabled !== false
  const resolveRuntimeFn = dependencies.resolveRuntime || resolveRuntime
  const updatePluginVersionFn = dependencies.updatePluginVersion || updatePluginVersion
  let runtime = null
  let managed = enabled
  let configCompleted = false
  let injectedMcp = null
  let updateNotified = false

  const notifyUpdate = async () => {
    if (updateNotified) return
    updateNotified = true
    try {
      await input.client?.tui?.showToast?.({
        body: {
          title: "CodeGraph Bridge",
          message: "Update ready. Restart OpenCode to apply.",
          variant: "info",
          duration: 5000,
        },
      })
    } catch {
      // Notification failure must not turn a completed update into a failure.
    }
  }

  if (managed) {
    try {
      runtime = resolveRuntimeFn()
    } catch (error) {
      managed = false
      log(input, `CodeGraph 依赖不可用，已跳过注册和索引：${error?.message || String(error)}`)
    }
  }

  return {
    config(config) {
      if (enabled) {
        void Promise.resolve().then(() => updatePluginVersionFn(config, {
          onSuccess: (version) => {
            log(input, `opencode-codegraph-bridge updated to ${version}; restart required.`)
            void notifyUpdate()
          },
        })).catch((error) => log(input, `opencode-codegraph-bridge 版本检查已跳过：${error?.message || String(error)}`))
      }
      if (!managed || !runtime) return
      if (Object.prototype.hasOwnProperty.call(config.mcp || {}, "codegraph")) {
        if (config.mcp.codegraph === injectedMcp) return
        managed = false
        log(input, "检测到用户已有 mcp.codegraph 配置，保持原配置并停止插件接管。")
        return
      }
      const project = normalizeProjectRoot(input?.directory, input?.worktree)
      if (!project.root) {
        managed = false
        log(input, `项目根目录不满足条件（${project.reason}），不注册 CodeGraph MCP。`)
        return
      }
      config.mcp ??= {}
      config.mcp.codegraph = {
        type: "local",
        command: [runtime.nodePath, "--liftoff-only", "--disable-warning=ExperimentalWarning", runtime.launcherPath],
        environment: { CODEGRAPH_NO_DOWNLOAD: "1" },
        enabled: true,
      }
      injectedMcp = config.mcp.codegraph
      configCompleted = true
    },
    "experimental.chat.system.transform": async (_event, output) => {
      if (configCompleted && managed && output?.system) output.system.push(SYSTEM_PROMPT)
    },
  }
}
