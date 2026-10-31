import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

export const MPL_REPOSITORY = "https://github.com/ivarvong/mpl.git"
export const MPL_REVISION = "c638db3d465be0c5af6c364c60e58fdf1195d51e"
const MPL_RUNTIME_SHA256 = "1d7fd819987ce61f4fdd4a16d7b7a5325e5acdc0bb859f2726f0ee1341c66edb"

const exec = promisify(execFile)
const MARKER = ".mpl-skill.json"

function requireNode24() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10)
  if (major < 24) throw new Error(`mpl skill requires Node.js 24+ (running ${process.version})`)
}

async function requireSourceEntry(root) {
  const entry = join(root, "src", "index.ts")
  let stat
  try {
    stat = await lstat(entry)
  } catch (error) {
    throw new Error(`mpl source entry is missing: ${entry}`, { cause: error })
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`mpl source entry must be a regular file, not a symlink: ${entry}`)
  }
  await access(entry, constants.R_OK)
  return entry
}

async function runtimeDigest(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`unexpected non-file in pinned mpl sources: ${path}`)
    }
  }
  await walk(join(root, "src"))
  files.push(join(root, "package.json"))
  files.sort()
  const hash = createHash("sha256")
  for (const path of files) {
    hash.update(path.slice(root.length + 1))
    hash.update("\0")
    hash.update(await readFile(path))
    hash.update("\0")
  }
  return hash.digest("hex")
}

async function requirePinnedRuntime(root) {
  const found = await runtimeDigest(root)
  if (found !== MPL_RUNTIME_SHA256) {
    throw new Error(`mpl runtime sources at ${root} do not match pinned revision ${MPL_REVISION}`)
  }
}

async function validateManaged(root) {
  let marker
  try {
    marker = JSON.parse(await readFile(join(root, MARKER), "utf8"))
  } catch (error) {
    throw new Error(`invalid mpl cache at ${root}: missing or unreadable ${MARKER}`, { cause: error })
  }
  if (
    marker.repository !== MPL_REPOSITORY ||
    marker.revision !== MPL_REVISION ||
    marker.runtimeSha256 !== MPL_RUNTIME_SHA256
  ) {
    throw new Error(`invalid mpl cache at ${root}: expected official revision ${MPL_REVISION}`)
  }

  // Bootstrap checks out a detached commit, so this verifies the cached Git revision
  // without needing Git (and therefore works from a warm cache while offline).
  const head = (await readFile(join(root, ".git", "HEAD"), "utf8")).trim()
  if (head !== MPL_REVISION) {
    throw new Error(`invalid mpl cache at ${root}: expected HEAD ${MPL_REVISION}, found ${head || "<empty>"}`)
  }
  await requirePinnedRuntime(root)
  return requireSourceEntry(root)
}

async function git(args, options = {}) {
  try {
    return await exec("git", args, {
      ...options,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    const detail = String(error.stderr || error.message).trim()
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`, { cause: error })
  }
}

async function validateOverride(configuredRoot) {
  if (!configuredRoot) throw new Error("MPL_ROOT is set but empty")
  if (!isAbsolute(configuredRoot)) throw new Error(`MPL_ROOT must be an absolute path: ${configuredRoot}`)

  let root
  try {
    root = await realpath(configuredRoot)
  } catch (error) {
    throw new Error(`MPL_ROOT does not exist or is unreadable: ${configuredRoot}`, { cause: error })
  }
  const { stdout } = await git(["-C", root, "rev-parse", "--verify", "HEAD"])
  const revision = stdout.trim()
  if (revision !== MPL_REVISION) {
    throw new Error(`MPL_ROOT must be at pinned revision ${MPL_REVISION}; found ${revision}`)
  }
  try {
    await git(["-C", root, "diff", "--quiet", "HEAD", "--", "src", "package.json"])
  } catch (error) {
    throw new Error(`MPL_ROOT has modified pinned runtime sources; refusing to execute it: ${root}`, { cause: error })
  }
  await requirePinnedRuntime(root)
  return { root, entry: await requireSourceEntry(root), provenance: "override" }
}

function managedRoot() {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  if (!isAbsolute(cacheHome)) throw new Error(`XDG_CACHE_HOME must be an absolute path: ${cacheHome}`)
  return join(cacheHome, "mpl", MPL_REVISION)
}

async function bootstrap(root) {
  const parent = join(root, "..")
  await mkdir(parent, { recursive: true })
  const stage = await mkdtemp(join(parent, `.${MPL_REVISION}.staging-`))
  try {
    await git(["init", "--quiet", stage])
    await git(["-C", stage, "remote", "add", "origin", MPL_REPOSITORY])
    await git(["-C", stage, "fetch", "--quiet", "--depth=1", "origin", MPL_REVISION])
    await git(["-C", stage, "checkout", "--quiet", "--detach", "FETCH_HEAD"])
    const { stdout } = await git(["-C", stage, "rev-parse", "--verify", "HEAD"])
    if (stdout.trim() !== MPL_REVISION) {
      throw new Error(`fetched unexpected mpl revision ${stdout.trim()}`)
    }
    await requireSourceEntry(stage)
    await requirePinnedRuntime(stage)
    await writeFile(
      join(stage, MARKER),
      `${JSON.stringify({ repository: MPL_REPOSITORY, revision: MPL_REVISION, runtimeSha256: MPL_RUNTIME_SHA256 })}\n`,
      { flag: "wx" },
    )

    try {
      await rename(stage, root)
    } catch (error) {
      // Another first-use process may have atomically published the same pin.
      try {
        await validateManaged(root)
      } catch {
        throw error
      }
    }
  } catch (error) {
    throw new Error(
      `Unable to install pinned mpl revision ${MPL_REVISION} from ${MPL_REPOSITORY}. ` +
        `First use requires network access and Git; a completed cache works offline. ${error.message}`,
      { cause: error },
    )
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  await validateManaged(root)
}

/** Load the complete mpl module namespace from an exact, trusted source revision. */
export async function loadMpl() {
  requireNode24()

  let selected
  if (Object.hasOwn(process.env, "MPL_ROOT")) {
    selected = await validateOverride(process.env.MPL_ROOT)
  } else {
    const root = managedRoot()
    try {
      selected = { root, entry: await validateManaged(root), provenance: "cache" }
    } catch {
      let exists = true
      try {
        await access(root)
      } catch {
        exists = false
      }
      if (exists) {
        // The cache may have appeared after the first check in a concurrent setup.
        selected = { root, entry: await validateManaged(root), provenance: "cache" }
      } else {
        await bootstrap(root)
        selected = { root, entry: await validateManaged(root), provenance: "bootstrap" }
      }
    }
  }

  const mpl = await import(pathToFileURL(selected.entry).href)
  if (typeof mpl.subplots !== "function") {
    throw new Error(`Pinned mpl module does not export subplots(): ${selected.entry}`)
  }
  return { ...selected, revision: MPL_REVISION, mpl }
}
