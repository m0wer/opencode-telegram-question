import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import pkg from "../package.json"
import plugin from "../src/index"

// Packaging guards for the supported (local-path) install. opencode loads the
// plugin from the file referenced in config: the built dist/index.js (committed
// to git and pointed at by package.json `main`/`exports`). opencode's loader
// requires a default export of `{ id, server: <function> }`. (The `github:`
// install path is intentionally unsupported: opencode git-clones the repo on every
// launch and disposes short-lived commands before the clone finishes, so arborist
// rolls the partial install back — a local path resolves with a cheap stat instead.)
describe("packaging", () => {
  const root = path.join(import.meta.dir, "..")
  const entry = (pkg as { exports?: { ["."]?: { import?: string } }; main?: string }).exports?.["."]?.import ?? pkg.main
  const rel = (entry ?? "").replace(/^\.\//, "")

  test("declares a package entry", () => {
    expect(rel.length).toBeGreaterThan(0)
  })

  test("entry file exists on disk (run `bun run build`)", () => {
    expect(existsSync(path.join(root, rel))).toBe(true)
  })

  test("default export has the shape opencode loads (id + server function)", () => {
    expect(typeof plugin).toBe("object")
    expect(typeof plugin.id).toBe("string")
    expect(plugin.id.length).toBeGreaterThan(0)
    expect(typeof plugin.server).toBe("function")
  })
})
