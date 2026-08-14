/**
 * src/main/services/reframe-cache.ts — remember the computed `ReframePlan`
 * (FEAT-rmh08k).
 *
 * `docs/auto-reframe-design.md:50` asks for this explicitly ("cache the plan per
 * clip id + bounds") and nothing implemented it, so EVERY export of the same
 * clip at the same bounds re-ran the entire face pipeline: an ffmpeg decode pass
 * sampling at 2 fps, YuNet ONNX inference on every sampled frame, and then a
 * second `tblend` motion pass. Re-exporting after nudging a caption colour paid
 * the whole cost again — and face analysis is the slowest phase of an export.
 *
 * WHAT IS IN THE KEY. Everything that changes the plan, on the openclip-d2s
 * lesson: a cache keyed on less than its inputs is worse than no cache, because
 * it returns a confidently wrong answer instead of a slow right one. So the
 * bounds (a trim invalidates), the source mtime (re-importing or re-encoding the
 * file invalidates), the sample rate, AND the aspect + mode — a plan built for
 * 9:16 crops a different column than one built for 1:1, and `split` and `auto`
 * produce structurally different plans from identical samples.
 *
 * `null` IS A RESULT. "No usable face — centre-crop" costs exactly as much to
 * compute as a plan does, so it is cached too. That is why entries are wrapped
 * (`{plan: …}`) rather than stored bare: `undefined` from a lookup means "never
 * computed", and it must stay distinguishable from a cached `null`.
 *
 * The store is a single JSON file in the project's existing cache dir — the same
 * tier as the content-addressed WAV cache, with the same durability: it survives
 * an app restart, and losing it costs time rather than data.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AspectRatio } from '@shared/schema'
import type { ReframePlan } from '@shared/reframe-plan'

/** File name inside `cacheDirFor(projectId)`. */
export const REFRAME_CACHE_FILE = 'reframe-plans.json'

/**
 * How many entries a project keeps. A project has tens of clips, each with a
 * handful of trims; a few hundred is generous and bounds the file to a few tens
 * of KB. Eviction is oldest-written-first.
 */
export const MAX_ENTRIES = 200

export interface ReframeCacheKeyArgs {
  clipId: string
  /** RESOLVED bounds — a trim must invalidate, which is why these are the edited ones. */
  startTime: number
  endTime: number
  /** Source mtime in ms; a re-encoded or re-downloaded file invalidates. */
  sourceMtimeMs: number
  sampleFps: number
  aspect: AspectRatio
  mode: 'auto' | 'split'
}

/**
 * The cache key. Times are rounded to milliseconds so a float that differs in the
 * 15th decimal — which a trim drag can easily produce — does not miss a cache it
 * should hit.
 */
export function reframeCacheKey(args: ReframeCacheKeyArgs): string {
  const ms = (n: number): number => Math.round(n * 1000)
  return createHash('sha256')
    .update(
      JSON.stringify([
        args.clipId,
        ms(args.startTime),
        ms(args.endTime),
        Math.round(args.sourceMtimeMs),
        args.sampleFps,
        args.aspect,
        args.mode
      ])
    )
    .digest('hex')
    .slice(0, 32)
}

/** One entry. `plan: null` is a real, cacheable answer — see the header. */
interface CacheEntry {
  plan: ReframePlan | null
  /** Insertion order, for eviction. Monotonic within a file, not a wall clock. */
  seq: number
}

interface CacheFile {
  version: 1
  seq: number
  entries: Record<string, CacheEntry>
}

const EMPTY: CacheFile = { version: 1, seq: 0, entries: {} }

/**
 * Read the store, or an empty one.
 *
 * NEVER throws. A corrupt or partially-written cache file must degrade to "cache
 * miss", not to a failed export — this is an optimisation, and an optimisation
 * that can break the feature it optimises is a liability.
 */
function readFile(dir: string): CacheFile {
  try {
    const raw = readFileSync(join(dir, REFRAME_CACHE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as CacheFile
    if (parsed?.version !== 1 || typeof parsed.entries !== 'object' || !parsed.entries) return EMPTY
    return { version: 1, seq: Number(parsed.seq) || 0, entries: parsed.entries }
  } catch {
    return EMPTY
  }
}

/**
 * Look up a plan.
 *
 * Returns `{ plan }` on a hit (where `plan` may legitimately be `null`) and
 * `undefined` on a miss. The wrapper is the whole point — see the header.
 */
export function readReframePlan(
  dir: string,
  key: string
): { plan: ReframePlan | null } | undefined {
  const entry = readFile(dir).entries[key]
  return entry ? { plan: entry.plan ?? null } : undefined
}

/**
 * Store a plan, evicting the oldest entries past `MAX_ENTRIES`.
 *
 * Written via a temp file + rename so a crash mid-write leaves the previous file
 * intact rather than a truncated one — the read path tolerates corruption, but
 * not creating it is better than recovering from it. Never throws: a cache that
 * cannot be written must not fail the export that produced the value.
 */
export function writeReframePlan(dir: string, key: string, plan: ReframePlan | null): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = readFile(dir)
    const seq = file.seq + 1
    const entries: Record<string, CacheEntry> = { ...file.entries, [key]: { plan, seq } }
    const keys = Object.keys(entries)
    if (keys.length > MAX_ENTRIES) {
      // Oldest-written-first. A plan is cheap to recompute relative to the file
      // growing without bound across a long editing session.
      const ordered = keys.sort((a, b) => entries[a].seq - entries[b].seq)
      for (const k of ordered.slice(0, keys.length - MAX_ENTRIES)) delete entries[k]
    }
    const target = join(dir, REFRAME_CACHE_FILE)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, seq, entries } satisfies CacheFile))
    renameSync(tmp, target)
  } catch {
    /* a cache write failure must never fail the export */
  }
}
