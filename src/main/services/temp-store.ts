/**
 * src/main/services/temp-store.ts — launch-time sweep of orphaned per-job temp
 * scratch (audit fix openclip-2j3).
 *
 * Per-job scratch lives at `<temp>/openclip/<projectId>/<jobId>/` and is deleted
 * in a `finally` by each runner; URL downloads use `<temp>/openclip/downloads/
 * <jobId>/`. A crash/SIGKILL between "create scratch" and "delete in finally"
 * leaves an orphan dir — this sweep reclaims those at launch, mirroring
 * `sweepOrphanMedia` (media-store.ts).
 *
 * What is PRESERVED:
 *   - `<projectId>/cache/` — the CONTENT-ADDRESSED WAV cache (transcribe writes
 *     here, NOT into a job dir). It must NEVER be swept — it's a cache, not
 *     scratch, and is keyed by content so it stays valid across runs.
 *   - any `<jobId>` listed in `activeJobIds` — a job still running right now.
 *
 * Everything else under a `<projectId>/` (stale `<jobId>` dirs) and any stale
 * `downloads/<jobId>` is removed (recursive, force). Best-effort per entry (one
 * failure doesn't abort the sweep); a missing root is a no-op. The root is
 * INJECTED so this stays Electron-free / unit-testable.
 */

import { join } from 'node:path'
import { readdir, rm, stat } from 'node:fs/promises'

/** The top-level child of the temp root that holds URL-download scratch dirs. */
const DOWNLOADS_DIR = 'downloads'
/** The content-addressed cache child of each project temp dir — NEVER swept. */
const CACHE_DIR = 'cache'

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code
}

/** Best-effort `rm -rf` of one path; records it as removed. Never throws. */
async function rmEntry(absPath: string, label: string, removed: string[]): Promise<void> {
  try {
    await rm(absPath, { recursive: true, force: true })
    removed.push(label)
  } catch {
    /* best-effort — skip this entry, keep sweeping */
  }
}

/**
 * Reclaim orphaned per-job temp scratch under `root` (= `openclipTempRoot()`).
 * Preserves every project's `cache/` and any `<jobId>` in `activeJobIds`; removes
 * every other `<projectId>/<jobId>` and every stale `downloads/<jobId>`. Returns
 * the removed labels (`<projectId>/<jobId>` or `downloads/<jobId>`) for logging.
 */
export async function sweepOrphanTemp(
  activeJobIds: Iterable<string>,
  root: string
): Promise<{ removed: string[] }> {
  const active = new Set(activeJobIds)
  let topEntries: string[]
  try {
    topEntries = await readdir(root)
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return { removed: [] }
    throw err
  }

  const removed: string[] = []

  for (const top of topEntries) {
    const topPath = join(root, top)

    // The `downloads/` subtree: each child is a `<jobId>` download scratch dir.
    if (top === DOWNLOADS_DIR) {
      let jobs: string[]
      try {
        jobs = await readdir(topPath)
      } catch {
        continue // not a dir / unreadable → leave it
      }
      for (const jobId of jobs) {
        if (active.has(jobId)) continue
        await rmEntry(join(topPath, jobId), `${DOWNLOADS_DIR}/${jobId}`, removed)
      }
      continue
    }

    // Otherwise `top` is a `<projectId>` dir whose children are `cache` + job dirs.
    let children: string[]
    try {
      // Only descend into directories; a stray file at the root is left alone.
      if (!(await stat(topPath)).isDirectory()) continue
      children = await readdir(topPath)
    } catch {
      continue
    }
    for (const child of children) {
      if (child === CACHE_DIR) continue // NEVER sweep the content-addressed cache
      if (active.has(child)) continue // an active job's live scratch
      await rmEntry(join(topPath, child), `${top}/${child}`, removed)
    }
  }

  return { removed }
}
