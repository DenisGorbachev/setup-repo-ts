import { $, type ProcessPromise, type Shell } from "npm:zx@8.3.2"
import type { AsDir } from "./interfaces/AsDir.ts"
import { dirname, SEPARATOR } from "jsr:@std/path@0.224.0"
import { readAll } from "jsr:@std/io@0.225.2"
import { Target } from "./classes/Target.ts"
import { RepoPathCommit } from "./classes/RepoPathCommit.ts"
import { Lockfile } from "./classes/Lockfile.ts"
import { copy, exists } from "jsr:@std/fs@0.224.0"
import type { SourceLike } from "./interfaces/SourceLike.ts"
import { getBooleanInput } from "./utils.ts"

export const isGitRepo = async (dir: string) => {
  const output = await $({cwd: dir})`git rev-parse --is-inside-work-tree`
  return output.text().trim() === "true"
}

export const isGitRepoClean = async (dir: string) => {
  const output = await $({cwd: dir})`git status --porcelain`
  return output.text().trim() === ""
}

export const ensure = <T>(value: T | null | undefined, err: () => Error) => {
  if (value === null || value === undefined) {
    throw err()
  } else {
    return value
  }
}

export function stub<T>(message = "Implement me"): T {
  throw new Error(message)
}

export const copyOne = (from: AsDir, to: AsDir) => async (path: string) => {
  const source = from.asDir() + SEPARATOR + path
  const target = to.asDir() + SEPARATOR + path
  const targetParent = dirname(target)
  await Deno.mkdir(targetParent, {recursive: true})
  await Deno.copyFile(source, target)
}

export const copyAll = (from: AsDir, to: AsDir) => (paths: string[]) => Promise.all(paths.map(copyOne(from, to)))

export const getGitRemoteUrl = (target: string) => $({cwd: target})`git remote get-url origin`

export const miseTrust = (target: string) => $({cwd: target})`mise trust ${target}/mise.toml`

// Test that everything works
export const lefthookRunPreCommit = (target: string) => $({cwd: target})`lefthook run -f pre-commit`

export const lockfile = (dir: string) => dir + SEPARATOR + "patchlift.lock"

export const withFile = async (path: string, callback: (contentOld: string) => Promise<string>) => {
  using file = await Deno.open(path, {read: true, write: true, create: true})
  await file.lock(true)
  const decoder = new TextDecoder("utf-8")
  const contentOldArray = await readAll(file)
  const contentOldString = decoder.decode(contentOldArray)
  const encoder = new TextEncoder()
  const contentNewString = await callback(contentOldString)
  const contentNewArray = encoder.encode(contentNewString)
  await file.truncate()
  await file.seek(0, Deno.SeekMode.Start)
  await file.write(contentNewArray)
  await file.unlock()
}

/**
 * @return true if the patch has been applied, false otherwise
 */
async function applyPatchMaybe<S>(patch: string, path: string, targetSh: Shell<false, ProcessPromise>): Promise<boolean> {
  if (patch) {
    const patchFilePath = await Deno.makeTempFile({
      prefix: "patch",
    })
    await Deno.writeTextFile(patchFilePath, patch)
    if (await getBooleanInput(`Applying patch from ${patchFilePath} on ${path}. Continue? (Y/n)`)) {
      await targetSh`git apply ${patchFilePath}`
      return true
    } else {
      console.info("Cancelled by user")
      return false
    }
  } else {
    console.info(`Patch for ${path} is empty`)
    return true
  }
}

/**
 * `source` & `paths` are needed (we can't read them from lockfile) because the user should set them in `patchlift.ts`, not in `patchlift.lock`
 *
 * TODO: extend RepoPathCommit to Branch
 */
export const applyPatches = (source: SourceLike, pathsToCopy: string[], pathsToRemove: string[] = []) => async (target: Target) => {
  const targetSh = target.asShell()
  const sourceSh = source.asShell()
  const sourceHead = (await sourceSh`git rev-parse HEAD`).text().trim()
  await withFile(target.lockfile(), async (contentOld) => {
    const lockfile = Lockfile.fromString(contentOld)

    // Process paths to remove
    for (const path of pathsToRemove) {
      const targetPath = target.asDir() + SEPARATOR + path
      const fileExists = await exists(targetPath)

      if (fileExists) {
        if (await getBooleanInput(`Remove ${path} from target? (Y/n)`)) {
          await Deno.remove(targetPath, {recursive: true})
          // Remove from lockfile if exists
          lockfile.rpcs = lockfile.rpcs.filter((rpc) => !(rpc.repo === source.asRepoUrl() && rpc.path === path))
          console.info(`Removed ${path}`)
        } else {
          console.info("Cancelled by user")
        }
      }
    }

    // await sequentially to allow the user to make decisions
    for (const path of pathsToCopy) {
      // NOTE: Can't ask for user input in this function because it is called by `withFile`, which must
      const rpc = lockfile.rpcs.find((rpc) => rpc.repo === source.asRepoUrl() && rpc.path === path)
      if (rpc) {
        const revisionRange = `${rpc.commit}..${sourceHead}`
        const formatPatchProcessOutput = await sourceSh`git format-patch --stdout ${revisionRange} -- ${path}`
        const patch = formatPatchProcessOutput.text()
        const isApplied = await applyPatchMaybe(patch, path, targetSh)
        if (isApplied) {
          rpc.commit = sourceHead
        }
      } else {
        if (await getBooleanInput(`${path} does not have a corresponding commit in a lockfile. Copy the path from source? (Y/n)`)) {
          await copy(source.asDir() + SEPARATOR + path, target.asDir() + SEPARATOR + path, {overwrite: true})
          lockfile.rpcs.push(RepoPathCommit.create(source.asRepoUrl(), path, sourceHead))
        } else {
          console.info("Cancelled by user")
        }
      }
    }
    return lockfile.toString()
  })
}

export const applyPatchesSTP = async (getSource: () => Promise<SourceLike>, targetDir: string | undefined, paths: string[]) => {
  const source = await getSource()
  const target = await Target.create(targetDir)
  return applyPatches(source, paths, [])(target)
}
