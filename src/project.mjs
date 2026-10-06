import { lstatSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, parse, resolve, sep } from "node:path"
import { spawnSync } from "node:child_process"

export function normalizeRealpath(value) {
  try {
    return realpathSync(resolve(value))
  } catch {
    return null
  }
}

/** OpenCode supplies the root; deliberately do not search its ancestors. */
export function normalizeProjectRoot(directory, worktree) {
  const candidate = typeof worktree === "string" && worktree ? worktree : directory
  if (typeof candidate !== "string" || !candidate) return { root: null, reason: "OpenCode 未提供项目目录" }
  const root = normalizeRealpath(candidate)
  if (!root || !statIsDirectory(root)) return { root: null, reason: "项目目录不存在或不可读" }
  const unsafe = unsafeRootReason(root)
  if (unsafe) return { root: null, reason: `项目根目录过宽（${unsafe}）` }
  try {
    const git = lstatSync(join(root, ".git"))
    if (git.isDirectory() || git.isFile()) return { root }
  } catch { /* A missing Git root must not be indexed. */ }
  return { root: null, reason: "项目根目录不是 Git 根或 worktree（缺少 .git）" }
}

function statIsDirectory(value) {
  try { return statSync(value).isDirectory() } catch { return false }
}

function unsafeRootReason(root) {
  if (root === parse(root).root) return "文件系统根目录"
  const home = normalizeRealpath(homedir()) || resolve(homedir())
  const same = process.platform === "win32" || process.platform === "darwin"
    ? (value) => value.toLowerCase() : (value) => value
  const r = same(root)
  const h = same(home)
  if (r === h) return "用户 home 目录"
  if (h.startsWith(`${r}${sep}`)) return "用户 home 的祖先目录"
  return null
}

/** Codex can open a repository subdirectory; Git is the root authority. */
export function resolveCodexProjectRoot(directory) {
  if (typeof directory !== "string" || !directory) return { root: null, reason: "Codex 未提供项目目录" }
  const cwd = normalizeRealpath(directory)
  if (!cwd || !statIsDirectory(cwd)) return { root: null, reason: "项目目录不存在或不可读" }
  const unsafe = unsafeRootReason(cwd)
  if (unsafe) return { root: null, reason: `项目目录过宽（${unsafe}）` }
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, shell: false,
    // An inherited GIT_DIR/GIT_WORK_TREE must not redirect another session.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  })
  if (result.error || result.status !== 0) return { root: null, reason: "无法确定 Git 项目根目录" }
  return normalizeProjectRoot(result.stdout.trim())
}
