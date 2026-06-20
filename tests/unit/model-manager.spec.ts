/**
 * tests/unit/model-manager.spec.ts — unit coverage for the GGML model manager
 * (services/model-manager.ts), PRD §13. Network is INJECTED (no real HF call):
 *   - `modelUrl` builds the verified ggerganov/whisper.cpp resolve URL (the
 *     ggml-org repo 401s — Gate-A finding).
 *   - `downloadModel` streams an injected body to disk, verifies SHA256 against
 *     the expected hash, emits byte-progress, and supports cancel.
 *   - a SHA mismatch rejects and removes the partial file (no corrupt model).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { modelUrl, sha256File, downloadModel } from '@main/services/model-manager'

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

  it('derives the expected SHA from the x-linked-etag header when none is given', async () => {
    const bytes = Buffer.from('hello model')
    const etag = sha256(bytes)
    const dest = join(dir, 'ggml-base.bin')
    const res = await downloadModel({
      model: 'base',
      destPath: dest,
      fetchImpl: fakeFetch(bytes, etag)
    })
    expect(res.bytes).toBe(bytes.length)
    expect(sha256File(dest)).toBe(etag)
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
    const dest = join(dir, 'ggml-base.bin')
    await expect(
      downloadModel({
        model: 'base', // NOT in KNOWN_SHA256 (only `tiny` is pinned)
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
