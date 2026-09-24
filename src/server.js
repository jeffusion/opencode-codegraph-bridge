import { Plugin } from "@opencode/plugin"
import { createCodeGraphPlugin } from "./internal.js"
import legacy from "./legacy.js"

const plugin = Plugin.define({
  id: "opencode-codegraph-bridge",
  setup(ctx) {
    return createCodeGraphPlugin()(ctx)
  },
})

export default Object.assign(plugin, {
  server(input, options) {
    return legacy(input, options)
  },
})
