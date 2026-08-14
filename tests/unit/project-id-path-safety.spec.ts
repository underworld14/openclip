/**
 * tests/unit/project-id-path-safety.spec.ts — a projectId must never be able to
 * escape the temp root (BUG-e06a9d).
 *
 * `media-store.ts` has always guarded this with `assertSafeProjectId`, but the
 * guard was only reachable through the media path: `grep -rn assertSafeProjectId
 * src` hit that one file. The temp-path builders in `paths.ts` were a bare
 * `join`, and both entry points that feed them — `JOB_START` (via
 * `job-start-validation.ts`, which only required a non-empty string) and
 * `audio:extract` — passed the renderer's projectId straight through.
 *
 * The practical impact was limited (a locally-generated UUID never takes the
 * branch, and the delete leaf is always a main-generated jobId, so no
 * pre-existing file could be removed) but a compromised renderer could still
 * create directories and drop `*.captions.ass` files outside the temp root. This
 * is defence in depth: guard where the path is BUILT, so every present and
 * future caller is covered, and reject at the trust boundary with a typed error.
 */

import { describe, expect, it } from 'vitest'
import { tempRootFor, jobTempDir, cacheDirFor, openclipTempRoot } from '@main/utils/paths'
import { validateJobStart } from '@main/ipc/job-start-validation'

const BASE = '/tmp/oc-test-base'
const ROOT = openclipTempRoot(BASE)

/** Every id that tries, one way or another, to leave the project's own subtree. */
const TRAVERSALS = [
  '..',
  '../../../../victim',
  '../../..',
  'a/../../b',
  'a/b',
  'a\\b',
  '.',
  '/etc',
  ''
]

describe('paths: temp roots refuse a projectId that is not a single safe segment', () => {
  for (const id of TRAVERSALS) {
    it(`rejects ${JSON.stringify(id)}`, () => {
      expect(() => tempRootFor(id, BASE)).toThrow(/unsafe project id/i)
      expect(() => jobTempDir(id, 'export-1', BASE)).toThrow(/unsafe project id/i)
      expect(() => cacheDirFor(id, BASE)).toThrow(/unsafe project id/i)
    })
  }

  it('still builds the ordinary paths for a normal id', () => {
    expect(tempRootFor('p1', BASE)).toBe(`${ROOT}/p1`)
    expect(jobTempDir('p1', 'export-mfoo-1', BASE)).toBe(`${ROOT}/p1/export-mfoo-1`)
    expect(cacheDirFor('p1', BASE)).toBe(`${ROOT}/p1/cache`)
  })

  it('accepts the UUID shape the app actually generates', () => {
    const uuid = '3f6b2c1e-9a4d-4f7b-8c2e-1a5d9b0f7c33'
    expect(tempRootFor(uuid, BASE)).toBe(`${ROOT}/${uuid}`)
  })

  it('never produces a path outside the temp root for any accepted id', () => {
    for (const id of ['p1', 'A_b-1.2', '3f6b2c1e-9a4d']) {
      expect(jobTempDir(id, 'j1', BASE).startsWith(`${ROOT}/`)).toBe(true)
    }
  })
})

describe('JOB_START: a traversal projectId is rejected at the trust boundary', () => {
  const exportParams = (projectId: string): unknown => ({
    projectId,
    clipId: 'c1',
    sourcePath: '/v/in.mp4',
    outputPath: '/v/out.mp4',
    startTime: 0,
    endTime: 5,
    aspectRatio: '9:16'
  })

  it('rejects a traversal id with a typed INPUT_INVALID rather than spawning', () => {
    expect(() =>
      validateJobStart({ kind: 'export', params: exportParams('../../../../victim') })
    ).toThrow(/INPUT_INVALID/)
  })

  it('rejects a separator in the id', () => {
    expect(() => validateJobStart({ kind: 'export', params: exportParams('a/b') })).toThrow(
      /INPUT_INVALID/
    )
  })

  it('rejects it for transcribe too — same field, same risk', () => {
    expect(() =>
      validateJobStart({
        kind: 'transcribe',
        params: { projectId: '..', wavPath: '/a.wav', model: 'base' }
      })
    ).toThrow(/INPUT_INVALID/)
  })

  it('still accepts an ordinary project id', () => {
    const out = validateJobStart({ kind: 'export', params: exportParams('p1') })
    expect(out.kind).toBe('export')
    expect((out.params as { projectId: string }).projectId).toBe('p1')
  })
})
