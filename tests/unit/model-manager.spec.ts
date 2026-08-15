/**
 * tests/unit/model-manager.spec.ts — unit coverage for the GGML model manager
 * (services/model-manager.ts), PRD §13. Network is INJECTED (no real HF call):
 *   - `modelUrl` builds the verified ggerganov/whisper.cpp resolve URL (the
 *     ggml-org repo 401s — Gate-A finding).
 *   - `downloadModel` streams an injected body to disk, verifies SHA256 against
 *     the expected hash, emits byte-progress, and supports cancel.
 *   - a SHA mismatch rejects and removes the partial file (no corrupt model).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  modelUrl,
  sha256File,
  downloadModel,
  deleteModel,
  MODEL_ASSETS
} from '@main/services/model-manager'

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** A fetch-like that streams `bytes` with a content-length + an etag SHA. */
function fakeFetch(bytes: Buffer, etag?: string): typeof fetch {
  return (async () => {
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k: string): string | null => {
          if (k.toLowerCase() === 'content-length') return String(bytes.length)
          if (k.toLowerCase() === 'x-linked-size') return String(bytes.length)
          if (k.toLowerCase() === 'x-linked-etag') return etag ? `"${etag}"` : null
          return null
        }
      },
      body: Readable.toWeb(Readable.from([bytes]))
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('model-manager: HF resolve URL (Gate-A: ggerganov, not ggml-org)', () => {
  it('builds https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<size>.bin', () => {
    expect(modelUrl('base')).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
    )
    expect(modelUrl('large-v3')).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin'
    )
  })
})

describe('model-manager: downloadModel (injected network)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openclip-models-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('streams bytes to disk, emits byte-progress, verifies SHA, returns path+bytes', async () => {
    const bytes = Buffer.from('the quick brown fox'.repeat(1000))
    const expected = sha256(bytes)
    const dest = join(dir, 'ggml-tiny.bin')
    const progress: Array<{ received: number; total: number }> = []

    const res = await downloadModel({
      model: 'tiny',
      destPath: dest,
      expectedSha256: expected,
      fetchImpl: fakeFetch(bytes, expected),
      onProgress: (received, total) => progress.push({ received, total })
    })

    expect(res.path).toBe(dest)
    expect(res.bytes).toBe(bytes.length)
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest).equals(bytes)).toBe(true)
    expect(sha256File(dest)).toBe(expected)
    // Progress was reported and the final report equals the total.
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1].received).toBe(bytes.length)
    expect(progress[progress.length - 1].total).toBe(bytes.length)
  })

  it('derives the expected SHA from the x-linked-etag header for an UNPINNED model', async () => {
    // Was `model: 'base'`. Every offered model is pinned now (BUG-45xt77), and
    // the pin deliberately WINS over a header — so the etag fallback can only be
    // exercised by a model with no manifest entry, which is exactly the case it
    // exists for: a size added to the enum before anyone pins it.
    const bytes = Buffer.from('hello model')
    const etag = sha256(bytes)
    const dest = join(dir, 'ggml-future.bin')
    const res = await downloadModel({
      model: 'future-size' as never,
      destPath: dest,
      fetchImpl: fakeFetch(bytes, etag)
    })
    expect(res.bytes).toBe(bytes.length)
    expect(sha256File(dest)).toBe(etag)
  })

  it('refuses bytes whose etag disagrees with the pinned hash (republished model)', async () => {
    // A pin and an etag that differ means the hub republished the file. Installing
    // the new bytes silently would defeat the point of pinning.
    const bytes = Buffer.from('republished payload')
    const dest = join(dir, 'ggml-base.bin')
    await expect(
      downloadModel({ model: 'base', destPath: dest, fetchImpl: fakeFetch(bytes, sha256(bytes)) })
    ).rejects.toThrow(/no longer matches/i)
    expect(existsSync(dest)).toBe(false)
  })

  it('reports an INDETERMINATE total (0) when nothing knows the size (openclip-flg)', async () => {
    // xet/LFS-backed model served via a redirect: no x-linked-size AND no
    // content-length. The total must stay 0 (indeterminate), NOT be faked to
    // `received` (which made the runner show a stuck near-100% bar from chunk 1).
    // Uses an UNPINNED model, since a pinned one now supplies its own total.
    const bytes = Buffer.from('xet-lfs-model-bytes')
    const etag = sha256(bytes)
    const dest = join(dir, 'ggml-future.bin')
    const totals: number[] = []
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (k: string): string | null =>
          k.toLowerCase() === 'x-linked-etag' ? `"${etag}"` : null
      },
      body: Readable.toWeb(Readable.from([bytes]))
    })) as unknown as typeof fetch

    await downloadModel({
      model: 'future-size' as never,
      destPath: dest,
      fetchImpl,
      onProgress: (_received, total) => totals.push(total)
    })
    expect(totals.length).toBeGreaterThan(0)
    expect(totals.every((t) => t === 0)).toBe(true)
  })

  it('falls back to the PINNED size when the server reports none (BUG-45xt77)', async () => {
    // The CDN can answer without content-length. A pinned model still knows how
    // big it is, so the bar should be real rather than a bare byte counter.
    const bytes = Buffer.from('bytes')
    const dest = join(dir, 'ggml-base.bin')
    const totals: number[] = []
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: { get: (): string | null => null },
      body: Readable.toWeb(Readable.from([bytes]))
    })) as unknown as typeof fetch

    await downloadModel({
      model: 'base',
      destPath: dest,
      expectedSha256: sha256(bytes),
      fetchImpl,
      onProgress: (_r, total) => totals.push(total)
    }).catch(() => {})
    expect(totals.every((t) => t === MODEL_ASSETS.base.bytes)).toBe(true)
  })

  it('rejects + removes the partial file on a SHA mismatch (no corrupt model)', async () => {
    const bytes = Buffer.from('corrupt-ish payload')
    const dest = join(dir, 'ggml-tiny.bin')
    await expect(
      downloadModel({
        model: 'tiny',
        destPath: dest,
        expectedSha256: 'deadbeef'.repeat(8), // wrong
        fetchImpl: fakeFetch(bytes, undefined)
      })
    ).rejects.toThrow(/sha|checksum|mismatch/i)
    expect(existsSync(dest)).toBe(false)
  })

  it('refuses to keep an UNVERIFIABLE model: no expected SHA, no etag, not in KNOWN_SHA256 (openclip-t1b)', async () => {
    const bytes = Buffer.from('unverifiable multi-GB-ish model bytes')
    const dest = join(dir, 'ggml-future.bin')
    await expect(
      downloadModel({
        // A model with NO manifest entry: every offered size is pinned now, so
        // this path is only reachable for an id the manifest does not cover.
        model: 'future-size' as never,
        destPath: dest,
        // no expectedSha256, and fakeFetch with no etag ⇒ nothing to verify against
        fetchImpl: fakeFetch(bytes, undefined)
      })
    ).rejects.toThrow(/unable to verify|cannot verify|integrity/i)
    // The unverified download must NOT be left on disk.
    expect(existsSync(dest)).toBe(false)
  })

  it('still rejects a WRONG payload for a pinned model via mismatch, not the unverifiable path', async () => {
    // `tiny` is pinned in KNOWN_SHA256; a wrong payload fails by mismatch (proving
    // the t1b fix does not over-reject the pinned-hash verification path).
    const dest = join(dir, 'ggml-tiny.bin')
    await expect(
      downloadModel({
        model: 'tiny',
        destPath: dest,
        fetchImpl: fakeFetch(Buffer.from('not the real tiny model'), undefined)
      })
    ).rejects.toThrow(/mismatch/i)
    expect(existsSync(dest)).toBe(false)
  })

  it('cancels the body reader and tears down on abort (audit fix openclip-0wn)', async () => {
    const ac = new AbortController()
    const cancel = vi.fn(async () => {})
    let reads = 0
    // First read yields a chunk; the second never resolves, so the pump sits waiting
    // until the abort fires — at which point the reader MUST be cancelled.
    const reader = {
      read: (): Promise<{ done: boolean; value?: Uint8Array }> =>
        new Promise((res) => {
          reads += 1
          if (reads === 1) res({ done: false, value: new Uint8Array([1, 2, 3]) })
          // reads >= 2: intentionally never resolves
        }),
      cancel,
      releaseLock: () => {}
    }
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => reader }
    })) as unknown as typeof fetch

    const dest = join(dir, 'ggml-base.bin')
    const p = downloadModel({ model: 'base', destPath: dest, fetchImpl, signal: ac.signal })
    await new Promise((r) => setTimeout(r, 15)) // let the pump consume the first chunk
    ac.abort()
    await expect(p).rejects.toThrow(/cancel/i)
    expect(cancel).toHaveBeenCalled() // reader torn down, not left pinned until GC
    expect(existsSync(dest)).toBe(false) // partial cleaned up
  })

  it('rejects when the HTTP status is not ok (e.g. ggml-org 401)', async () => {
    const dest = join(dir, 'ggml-tiny.bin')
    const failing = (async () =>
      ({
        ok: false,
        status: 401,
        headers: { get: () => null }
      }) as unknown as Response) as unknown as typeof fetch
    await expect(
      downloadModel({ model: 'tiny', destPath: dest, fetchImpl: failing })
    ).rejects.toThrow(/401|download/i)
    expect(existsSync(dest)).toBe(false)
  })

  it('aborts mid-stream when the signal fires', async () => {
    const bytes = Buffer.alloc(1_000_000, 7)
    const dest = join(dir, 'ggml-tiny.bin')
    const controller = new AbortController()
    controller.abort()
    await expect(
      downloadModel({
        model: 'tiny',
        destPath: dest,
        fetchImpl: fakeFetch(bytes, sha256(bytes)),
        signal: controller.signal
      })
    ).rejects.toThrow(/abort|cancel/i)
    expect(existsSync(dest)).toBe(false)
  })
})

// ── FEAT-1k76hk: reclaiming model disk ───────────────────────────────────────
describe('deleteModel', () => {
  it('removes an installed model and reports the bytes reclaimed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclip-mm-del-'))
    try {
      const file = join(dir, 'ggml-base.bin')
      writeFileSync(file, Buffer.alloc(2048))
      const res = deleteModel('base', { filePath: () => file })
      expect(res).toEqual({ model: 'base', deleted: true, freedBytes: 2048 })
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent — deleting a model that is not installed is not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclip-mm-del2-'))
    try {
      const res = deleteModel('turbo', { filePath: () => join(dir, 'nope.bin') })
      expect(res).toEqual({ model: 'turbo', deleted: false, freedBytes: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
