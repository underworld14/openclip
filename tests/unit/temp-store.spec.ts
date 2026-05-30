/**
 * tests/unit/temp-store.spec.ts — the launch-time orphan-temp sweep (audit fix
 * openclip-2j3), against a REAL temp filesystem (mirrors media-store.spec). Lays
 * out a `<root>` tree shaped like `openclipTempRoot()` and asserts the sweep:
 *   - PRESERVES every project's content-addressed `cache/`,
 *   - PRESERVES any `<jobId>` listed as active,
 *   - REMOVES every stale `<projectId>/<jobId>` and stale `downloads/<jobId>`,
 *   - is best-effort + no-ops on a missing root.
 *
 * The root is INJECTED, so the sweep is exercised Electron-free.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepOrphanTemp } from '@main/services/temp-store'

let root: string

async function makeDir(...segs: string[]): Promise<string> {
  const dir = join(root, ...segs)
  await mkdir(dir, { recursive: true })
  return dir
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'oc-temp-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('sweepOrphanTemp', () => {
  it('preserves cache/ + active jobs, removes stale job dirs (project + downloads)', async () => {
    // Project "p1": a cache dir, an ACTIVE job, and a STALE job.
    const cache = await makeDir('p1', 'cache')
    await writeFile(join(cache, 'audio.16k.wav'), 'WAV') // a real cached artifact
    const activeJob = await makeDir('p1', 'job-active')
    const staleJob = await makeDir('p1', 'job-stale')
    // The downloads subtree: an ACTIVE download + a STALE one.
    const activeDl = await makeDir('downloads', 'dl-active')
    const staleDl = await makeDir('downloads', 'dl-stale')

    const { removed } = await sweepOrphanTemp(['job-active', 'dl-active'], root)

    // Stale scratch is reclaimed…
    expect(existsSync(staleJob)).toBe(false)
    expect(existsSync(staleDl)).toBe(false)
    // …while cache + active jobs survive.
    expect(existsSync(cache)).toBe(true)
    expect(existsSync(join(cache, 'audio.16k.wav'))).toBe(true)
    expect(existsSync(activeJob)).toBe(true)
    expect(existsSync(activeDl)).toBe(true)

    expect(removed.sort()).toEqual(['downloads/dl-stale', 'p1/job-stale'])
  })

  it('NEVER sweeps cache/ even when no jobs are active', async () => {
    const cache = await makeDir('p1', 'cache')
    await writeFile(join(cache, 'x.wav'), 'X')
    const job = await makeDir('p1', 'job-1')

    const { removed } = await sweepOrphanTemp([], root)

    expect(existsSync(cache)).toBe(true) // cache preserved
    expect(existsSync(job)).toBe(false) // orphan job removed
    expect(removed).toEqual(['p1/job-1'])
  })

  it('no-ops on a missing root (returns no removals)', async () => {
    const missing = join(tmpdir(), 'oc-temp-does-not-exist-xyz')
    expect((await sweepOrphanTemp(['j'], missing)).removed).toEqual([])
  })

  it('handles a project with only a cache dir (nothing to remove)', async () => {
    await makeDir('p1', 'cache')
    const { removed } = await sweepOrphanTemp([], root)
    expect(removed).toEqual([])
    expect(existsSync(join(root, 'p1', 'cache'))).toBe(true)
  })
})
