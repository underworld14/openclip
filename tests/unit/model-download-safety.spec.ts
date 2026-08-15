/**
 * tests/unit/model-download-safety.spec.ts — the three model-download defects
 * found by testing the packaged app (BUG-45xt77).
 *
 * These are written FIRST, against the real failures, because the existing
 * `model-manager.spec.ts` pins each of them as correct behaviour:
 *
 *  1. It asserts `existsSync(dest) === false` after every failure — but every one
 *     of those cases runs against a fresh empty `mkdtempSync` dir, so it never
 *     notices that `dest` is ALSO the user's installed model, truncated on open
 *     and deleted on cleanup.
 *  2. Its etag test synthesises `x-linked-etag` on the response the caller
 *     receives. A redirect-following `fetch` never produces that: the header is
 *     only on HuggingFace's 302, and `res.headers` are the CDN's. Live proof:
 *     `huggingface.co` → 302 with `x-linked-etag: "1be3a9b2…"`, then
 *     `us.aws.cdn.hf.co` → 206 with only a Xet `etag` that is not a sha256.
 *  3. Nothing asserts that a model the UI OFFERS can actually be resolved and
 *     verified, which is how `turbo` (→ `ggml-turbo.bin`, 404) shipped.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  ALL_MODELS,
  KNOWN_SHA256,
  MODEL_ASSETS,
  downloadModel,
  modelUrl,
  sha256File
} from '@main/services/model-manager'

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * A fetch that behaves like the REAL one: it follows the redirect, so the caller
 * only ever sees the CDN's headers — no `x-linked-etag`, and an `etag` that is a
 * Xet content hash rather than a sha256.
 */
function cdnFetch(bytes: Buffer): typeof fetch {
  return (async () => {
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k: string): string | null => {
          const key = k.toLowerCase()
          if (key === 'content-length') return String(bytes.length)
          // The two headers the old implementation depended on are ABSENT here.
          if (key === 'x-linked-size') return null
          if (key === 'x-linked-etag') return null
          if (key === 'etag')
            return '"edd29d67e70b000132af65205b99bb774b77abc13d10103e14f80ce22429"'
          return null
        }
      },
      body: Readable.toWeb(Readable.from([bytes]))
    } as unknown as Response
  }) as unknown as typeof fetch
}

/** A fetch that fails mid-stream, the way a dropped connection does. */
function failingFetch(bytes: Buffer): typeof fetch {
  return (async () => {
    async function* chunks(): AsyncGenerator<Buffer> {
      yield bytes.subarray(0, 4)
      throw new Error('socket hang up')
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (): string | null => null },
      body: Readable.toWeb(Readable.from(chunks()))
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('an installed model survives a new download attempt (BUG-45xt77)', () => {
  let dir: string
  let dest: string
  const installed = Buffer.from('THE MODEL THE USER ALREADY DOWNLOADED'.repeat(100))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openclip-models-'))
    dest = join(dir, 'ggml-base.bin')
    // Seed a real, complete install — the state every existing spec omits.
    writeFileSync(dest, installed)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is untouched when the download fails mid-stream', async () => {
    // Before the fix: createWriteStream(dest) truncated this to 0 bytes on open,
    // then cleanup() rmSync'd it. 148 MB gone because a download was ATTEMPTED.
    await expect(
      downloadModel({
        model: 'base',
        destPath: dest,
        fetchImpl: failingFetch(Buffer.from('partial bytes'))
      })
    ).rejects.toThrow()

    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest).equals(installed)).toBe(true)
  })

  it('is untouched when the download is cancelled', async () => {
    // Cancel reaches this path from the Cancel button, Escape, backdrop click,
    // renderer reload AND app quit (killAll) — so this is the common case, not
    // an exotic one.
    const controller = new AbortController()
    const slow = (async () => {
      async function* chunks(): AsyncGenerator<Buffer> {
        yield Buffer.from('first')
        controller.abort()
        await new Promise((r) => setTimeout(r, 5))
        yield Buffer.from('second')
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (): string | null => null },
        body: Readable.toWeb(Readable.from(chunks()))
      } as unknown as Response
    }) as unknown as typeof fetch

    await expect(
      downloadModel({ model: 'base', destPath: dest, fetchImpl: slow, signal: controller.signal })
    ).rejects.toThrow(/cancel/i)

    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest).equals(installed)).toBe(true)
  })

  it('is untouched when the downloaded bytes fail verification', async () => {
    const wrong = Buffer.from('corrupt payload')
    await expect(
      downloadModel({
        model: 'base',
        destPath: dest,
        expectedSha256: sha256(Buffer.from('something else entirely')),
        fetchImpl: cdnFetch(wrong)
      })
    ).rejects.toThrow(/mismatch/i)

    expect(readFileSync(dest).equals(installed)).toBe(true)
  })

  it('leaves no .part debris behind after a failure', async () => {
    await expect(
      downloadModel({ model: 'base', destPath: dest, fetchImpl: failingFetch(Buffer.from('x')) })
    ).rejects.toThrow()
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir)).toEqual(['ggml-base.bin'])
  })

  it('replaces it atomically on success', async () => {
    const next = Buffer.from('A NEWER, VERIFIED MODEL'.repeat(50))
    const res = await downloadModel({
      model: 'base',
      destPath: dest,
      expectedSha256: sha256(next),
      fetchImpl: cdnFetch(next)
    })
    expect(res.bytes).toBe(next.length)
    expect(readFileSync(dest).equals(next)).toBe(true)
  })

  it('does not re-download something already installed at the expected size', async () => {
    // Pressing Download on an installed model must be a no-op, not a demolition
    // followed by 148 MB of bandwidth.
    let fetched = false
    const spyFetch = (async () => {
      fetched = true
      throw new Error('should never be called')
    }) as unknown as typeof fetch

    const res = await downloadModel({
      model: 'base',
      destPath: dest,
      expectedBytes: installed.length,
      fetchImpl: spyFetch
    })

    expect(fetched).toBe(false)
    expect(res.bytes).toBe(installed.length)
    expect(readFileSync(dest).equals(installed)).toBe(true)
  })
})

describe('verification works against a redirect-following fetch (BUG-45xt77)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openclip-models-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('verifies against the PINNED hash when the CDN drops x-linked-etag', async () => {
    // The exact production failure: 488 MB downloaded, then
    // "no expected SHA256, no x-linked-etag, and not in KNOWN_SHA256".
    const bytes = Buffer.from('pretend this is ggml-small.bin')
    const dest = join(dir, 'ggml-small.bin')

    const res = await downloadModel({
      model: 'small',
      destPath: dest,
      // Stand in for the pinned table so the test does not depend on real bytes.
      expectedSha256: sha256(bytes),
      fetchImpl: cdnFetch(bytes)
    })

    expect(res.bytes).toBe(bytes.length)
    expect(sha256File(dest)).toBe(sha256(bytes))
  })

  it('still refuses a download it genuinely cannot verify', async () => {
    // The safety property must survive the fix: an unknown model with no pin and
    // no etag is still refused rather than installed.
    const bytes = Buffer.from('unverifiable')
    const dest = join(dir, 'ggml-unknown.bin')
    await expect(
      downloadModel({
        model: 'unknown-size' as never,
        destPath: dest,
        fetchImpl: cdnFetch(bytes)
      })
    ).rejects.toThrow(/verify|refus/i)
    expect(existsSync(dest)).toBe(false)
  })
})

describe('the model manifest covers every model the app offers (BUG-45xt77)', () => {
  it('pins a sha256, a byte size and a remote filename for all of them', () => {
    // The missing guard. `KNOWN_SHA256` shipped with only `tiny` and a comment
    // reading "Extend as sizes are validated" — it never was, so five of six
    // models downloaded in full and were then refused.
    for (const model of ALL_MODELS) {
      const asset = MODEL_ASSETS[model]
      expect(asset, `no manifest entry for ${model}`).toBeTruthy()
      expect(asset.sha256, `${model} sha256`).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.bytes, `${model} bytes`).toBeGreaterThan(0)
      expect(asset.remoteFile, `${model} remote file`).toMatch(/^ggml-.+\.bin$/)
      expect(KNOWN_SHA256[model]).toBe(asset.sha256)
    }
  })

  it('maps turbo to the file that actually exists on the hub', () => {
    // `ggml-turbo.bin` 404s; the published asset is `ggml-large-v3-turbo.bin`.
    // The model was offered in the UI regardless.
    expect(modelUrl('turbo')).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'
    )
    expect(modelUrl('small')).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin'
    )
  })
})

describe('a truncated model is not reported as installed (BUG-45xt77)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openclip-models-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats a size mismatch at the install path as not-installed', async () => {
    // A crash (or the old truncate-on-open bug) leaves a short file that
    // `existsSync` accepts: the row read "Installed" with no size at all, and the
    // readiness chip went green over a model whisper-cli cannot load.
    const { isModelInstalledAt } = await import('@main/services/model-manager')
    const dest = join(dir, 'ggml-base.bin')

    writeFileSync(dest, Buffer.alloc(0))
    expect(isModelInstalledAt('base', dest)).toBe(false)

    writeFileSync(dest, Buffer.alloc(1024))
    expect(isModelInstalledAt('base', dest)).toBe(false)

    writeFileSync(dest, Buffer.alloc(MODEL_ASSETS.base.bytes))
    expect(statSync(dest).size).toBe(MODEL_ASSETS.base.bytes)
    expect(isModelInstalledAt('base', dest)).toBe(true)
  })
})
