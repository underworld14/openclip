/**
 * media-store — the persistent, app-OWNED source-video store (Part H).
 *
 * URL/YouTube downloads are ADOPTED into `<userData>/media/<projectId>/<file>` so
 * they survive OS temp cleanup, persist with the project, and are reclaimed when
 * the project is deleted (or on a launch-time orphan sweep). File-imported
 * originals live OUTSIDE this tree and are NEVER touched.
 *
 * Electron-free (the media root is injected), mirroring `project-store.ts`, so it
 * is unit-testable against a real temp filesystem.
 */

import { basename, dirname, join, resolve, sep } from 'node:path'
import { copyFile, mkdir, readdir, rename, rm, unlink } from 'node:fs/promises'

export class MediaStoreError extends Error {
  constructor(
    readonly code: 'INVALID' | 'IO',
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'MediaStoreError'
  }
}

/** A project id must be a single path segment (no separators / `..`) — trust boundary. */
export function assertSafeProjectId(projectId: string): string {
  if (!projectId || /[\\/]/.test(projectId) || projectId === '.' || projectId === '..') {
    throw new MediaStoreError('INVALID', `unsafe project id: ${JSON.stringify(projectId)}`)
  }
  return projectId
}

/** `<mediaRoot>/<projectId>` (pure). */
export function projectMediaDir(mediaRoot: string, projectId: string): string {
  return join(mediaRoot, assertSafeProjectId(projectId))
}

/**
 * Destination path when adopting `srcPath` for `projectId` (pure). Validates BOTH
 * the projectId (via projectMediaDir) AND the source basename — a `.`/`..`/
 * separator basename could otherwise collapse the dest out of `media/<projectId>/`
 * (trust boundary: srcPath/projectId reach here from the renderer over IPC).
 */
export function adoptedMediaPath(mediaRoot: string, projectId: string, srcPath: string): string {
  const base = basename(srcPath)
  if (!base || base === '.' || base === '..' || /[\\/]/.test(base)) {
    throw new MediaStoreError('INVALID', `unsafe source filename: ${JSON.stringify(base)}`)
  }
  return join(projectMediaDir(mediaRoot, projectId), base)
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code
}

/**
 * MOVE a downloaded file into `<mediaRoot>/<projectId>/<basename>` and return the
 * new absolute path. Uses `rename`; on a cross-volume `EXDEV` it falls back to
 * copy + best-effort unlink of the source. Throws `MediaStoreError('IO')` if the
 * file cannot be placed (the caller surfaces it and keeps the temp file).
 */
export async function adoptIntoMedia(
  srcPath: string,
  projectId: string,
  mediaRoot: string
): Promise<string> {
  // Single source of truth for the dest path; validates projectId + basename.
  const dest = adoptedMediaPath(mediaRoot, projectId, srcPath)
  const destDir = dirname(dest)
  // Defense-in-depth: the resolved dest must stay inside the per-project dir.
  if (!resolve(dest).startsWith(resolve(destDir) + sep)) {
    throw new MediaStoreError('INVALID', `adopt dest escapes media dir: ${dest}`)
  }
  try {
    await mkdir(destDir, { recursive: true })
    try {
      await rename(srcPath, dest)
    } catch (err) {
      if (!isErrnoCode(err, 'EXDEV')) throw err
      // Cross-volume: copy then best-effort remove the source. A leftover temp
      // file is reclaimed by OS temp cleanup (the launch sweep only scans
      // <userData>/media, NOT the temp downloads tree).
      await copyFile(srcPath, dest)
      await unlink(srcPath).catch(() => {})
    }
    return dest
  } catch (cause) {
    if (cause instanceof MediaStoreError) throw cause
    throw new MediaStoreError('IO', `failed to adopt ${srcPath} into media/${projectId}`, cause)
  }
}

/**
 * COPY an app-owned source into `<mediaRoot>/<projectId>/<basename>` and return
 * the new absolute path — unlike `adoptIntoMedia`, the source is left in place
 * (it belongs to the project being duplicated). Used by `project:duplicate`
 * (EPIC-k83ghw / BUG-tdgtfb): without a real copy, a duplicated project's
 * `sourceVideo.path` pointed at the ORIGINAL project's app-owned media dir, so
 * deleting the original (which reclaims `media/<projectId>/`) silently
 * destroyed the duplicate's video too.
 */
export async function copyIntoMedia(
  srcPath: string,
  projectId: string,
  mediaRoot: string
): Promise<string> {
  const dest = adoptedMediaPath(mediaRoot, projectId, srcPath)
  const destDir = dirname(dest)
  if (!resolve(dest).startsWith(resolve(destDir) + sep)) {
    throw new MediaStoreError('INVALID', `copy dest escapes media dir: ${dest}`)
  }
  try {
    await mkdir(destDir, { recursive: true })
    await copyFile(srcPath, dest)
    return dest
  } catch (cause) {
    if (cause instanceof MediaStoreError) throw cause
    throw new MediaStoreError('IO', `failed to copy ${srcPath} into media/${projectId}`, cause)
  }
}

/**
 * Remove a project's OWNED media dir `<mediaRoot>/<projectId>/` (idempotent).
 * Structurally can only ever touch `media/<projectId>/`, so a user's original
 * (file import, outside `mediaRoot`) is unreachable.
 */
export async function deleteProjectMedia(
  projectId: string,
  mediaRoot: string
): Promise<{ deleted: boolean }> {
  const dir = projectMediaDir(mediaRoot, projectId)
  try {
    await rm(dir, { recursive: true, force: true })
    return { deleted: true }
  } catch (cause) {
    throw new MediaStoreError('IO', `failed to delete media for ${projectId}`, cause)
  }
}

/**
 * Reclaim orphaned media: remove every `<mediaRoot>/<id>/` whose id is NOT in
 * `referencedProjectIds` (downloads from crashed/abandoned imports). Best-effort
 * per entry (one failure doesn't abort); a missing root is a no-op. Returns the
 * removed ids for logging.
 */
export async function sweepOrphanMedia(
  referencedProjectIds: Iterable<string>,
  mediaRoot: string
): Promise<{ removed: string[] }> {
  const referenced = new Set(referencedProjectIds)
  let entries: string[]
  try {
    entries = await readdir(mediaRoot)
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return { removed: [] }
    throw new MediaStoreError('IO', `failed to read media root ${mediaRoot}`, err)
  }
  const removed: string[] = []
  for (const id of entries) {
    if (referenced.has(id)) continue
    try {
      await rm(join(mediaRoot, id), { recursive: true, force: true })
      removed.push(id)
    } catch {
      /* best-effort — skip this entry, keep sweeping */
    }
  }
  return { removed }
}
