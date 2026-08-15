/**
 * src/main/services/model-manager.ts — GGML whisper model download + presence
 * (T-Media, E.3). PRD §13: models are NOT bundled (75 MB – 2.9 GB); they are
 * streamed on first transcribe from HuggingFace into `userData/models`,
 * SHA-verified, with byte-progress + cancel.
 *
 * Gate-A finding (verified): the `ggml-org/whisper.cpp` repo returns 401. Use
 * the public `ggerganov/whisper.cpp` repo:
 *   https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<size>.bin
 *
 * SHA verification (BUG-45xt77 — this used to be backwards). HF exposes the
 * file's SHA256 as `x-linked-etag`, but ONLY on the huggingface.co 302; `fetch`
 * follows redirects by default, so the headers a caller sees belong to the CDN,
 * which sends a Xet content hash under plain `etag` and no `x-linked-*` at all:
 *
 *   huggingface.co      → 302  x-linked-etag: "1be3a9b2…"  x-linked-size: 487601967
 *   us.aws.cdn.hf.co    → 200  etag: "edd29d67…"   (NOT a sha256)
 *
 * So the etag path was unreachable in production and only `tiny` was pinned —
 * every other model downloaded in full and was then refused as unverifiable.
 * The manifest below now pins all six; the etag is kept as a fallback for a
 * model that has no pin yet, read from a `redirect: 'manual'` probe.
 *
 * Network is injectable (`fetchImpl`) so the streaming/verify/cancel logic is
 * unit-tested without a real HF call (PRD §18).
 */

import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Writable } from 'node:stream'
import { JobError } from '@shared/jobs'
import type { WhisperModelSize } from '@shared/jobs'
import type { ModelStatus, ModelDeleteResult } from '@shared/channels'
import { modelFilePath, modelsDir } from '@main/utils/paths'

// ============================================================================
// URL + known hashes
// ============================================================================

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export interface ModelAsset {
  /**
   * The published filename on the hub. Usually `ggml-<id>.bin`, but NOT always:
   * `turbo` is published as `ggml-large-v3-turbo.bin`, and building the name
   * from the id gave a 404 for a model the UI offered anyway (BUG-45xt77). The
   * LOCAL filename stays `ggml-<id>.bin` — only the remote name varies.
   */
  remoteFile: string
  /** Exact published size. Drives the progress total and the truncation check. */
  bytes: number
  /** Exact published SHA256 (HF's `x-linked-etag` / the LFS oid). */
  sha256: string
}

/**
 * Every model the app offers, pinned.
 *
 * Values cross-verified twice against the hub: the HF API's `lfs.oid`/`size`, and
 * a `curl -D -` probe reading `x-linked-etag`/`x-linked-size` off the 302. Keep
 * both fields in step when adding a model — `model-download-safety.spec.ts`
 * fails the build if any `ALL_MODELS` entry is missing one, which is the guard
 * that was absent when only `tiny` was pinned.
 */
export const MODEL_ASSETS: Record<WhisperModelSize, ModelAsset> = {
  tiny: {
    remoteFile: 'ggml-tiny.bin',
    bytes: 77_691_713,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'
  },
  base: {
    remoteFile: 'ggml-base.bin',
    bytes: 147_951_465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
  },
  small: {
    remoteFile: 'ggml-small.bin',
    bytes: 487_601_967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'
  },
  medium: {
    remoteFile: 'ggml-medium.bin',
    bytes: 1_533_763_059,
    sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208'
  },
  turbo: {
    remoteFile: 'ggml-large-v3-turbo.bin',
    bytes: 1_624_555_275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'
  },
  'large-v3': {
    remoteFile: 'ggml-large-v3.bin',
    bytes: 3_095_033_483,
    sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2'
  }
}

/** The HF resolve URL for a GGML model (PRD §13 / Gate-A finding). */
export function modelUrl(model: WhisperModelSize): string {
  return `${HF_BASE}/${MODEL_ASSETS[model]?.remoteFile ?? `ggml-${model}.bin`}`
}

/**
 * Known-good SHA256 per model, derived from the manifest above so the two can
 * never disagree. Kept as a named export because callers and specs reference it.
 */
export const KNOWN_SHA256: Partial<Record<WhisperModelSize, string>> = Object.fromEntries(
  Object.entries(MODEL_ASSETS).map(([model, asset]) => [model, asset.sha256])
) as Partial<Record<WhisperModelSize, string>>

// ============================================================================
// Presence on disk (MODEL_STATUS)
// ============================================================================

export const ALL_MODELS: WhisperModelSize[] = [
  'tiny',
  'base',
  'small',
  'medium',
  'turbo',
  'large-v3'
]

/**
 * Is there a COMPLETE model at `path`?
 *
 * Presence alone is not enough (BUG-45xt77). A crash mid-download — or, before
 * the temp-file fix, any failed download at all — leaves a short file that
 * `existsSync` accepts: the settings row then read "Installed" with no size at
 * all (`formatBytes(0)` is `''`) and the readiness chip went green over a model
 * whisper-cli cannot load. The published size is pinned, so check it.
 */
export function isModelInstalledAt(model: WhisperModelSize, path: string): boolean {
  if (!existsSync(path)) return false
  const expected = MODEL_ASSETS[model]?.bytes
  if (!expected) return true // unknown model: presence is all we can assert
  return statSync(path).size === expected
}

/** Status of one (or all) models on disk: installed + path + bytes (PRD §13). */
export function modelStatus(model?: WhisperModelSize): ModelStatus[] {
  const list = model ? [model] : ALL_MODELS
  return list.map((m) => {
    const path = modelFilePath(m)
    if (isModelInstalledAt(m, path)) {
      return { model: m, installed: true, path, bytes: statSync(path).size }
    }
    return { model: m, installed: false }
  })
}

/** Whether a model is present in `userData/models` (first-transcribe gate). */
export function isModelInstalled(model: WhisperModelSize): boolean {
  return isModelInstalledAt(model, modelFilePath(model))
}

/** Path seam so the delete path is testable without touching real userData. */
export interface DeleteModelDeps {
  filePath?: (model: WhisperModelSize) => string
}

/**
 * Delete an installed GGML model and report the disk reclaimed (FEAT-1k76hk).
 *
 * Deliberately IDEMPOTENT: deleting a model that is not installed returns
 * `{deleted: false, freedBytes: 0}` rather than throwing. The caller is a
 * settings row whose whole job is "make this model not be on disk" — if it is
 * already gone, that request has been satisfied, and an error would only produce
 * a scary dialog for a state the user wanted anyway.
 */
export function deleteModel(
  model: WhisperModelSize,
  deps: DeleteModelDeps = {}
): ModelDeleteResult {
  const path = (deps.filePath ?? modelFilePath)(model)
  if (!existsSync(path)) return { model, deleted: false, freedBytes: 0 }
  const freedBytes = statSync(path).size
  rmSync(path, { force: true })
  return { model, deleted: true, freedBytes }
}

// ============================================================================
// SHA helpers
// ============================================================================

/** SHA256 of a file on disk, lowercase hex. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Strip the surrounding quotes HF puts around the etag value. */
function parseEtag(raw: string | null): string | undefined {
  if (!raw) return undefined
  const hex = raw.replace(/^"|"$/g, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined
}

/**
 * Read `x-linked-etag` off the 302 that a normal request would follow.
 *
 * This is the only place the header is visible: the CDN response a
 * redirect-following `fetch` returns does not carry it (BUG-45xt77). Used only
 * for a model with no pinned hash, so the pinned path costs no extra request.
 * Best-effort — a failure here just leaves the download unverifiable, which the
 * caller already refuses.
 */
async function probeLinkedEtag(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal })
    return parseEtag(res.headers.get('x-linked-etag'))
  } catch {
    return undefined
  }
}

// ============================================================================
// downloadModel — stream to disk, verify SHA, byte-progress, cancel
// ============================================================================

export interface DownloadModelOptions {
  model: WhisperModelSize
  /** Absolute destination path (defaults to userData/models/ggml-<size>.bin). */
  destPath?: string
  /** Expected SHA256 (else the pinned manifest hash, else a probed etag). */
  expectedSha256?: string
  /**
   * Expected byte size (else the pinned manifest size). Used to skip a download
   * that is already complete on disk, and as the progress total when the server
   * reports none.
   */
  expectedBytes?: number
  /** Byte-count progress (received, total) for resumable progress (PRD §13). */
  onProgress?: (receivedBytes: number, totalBytes: number) => void
  /** Cooperative cancel — aborts the stream + removes the partial file. */
  signal?: AbortSignal
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export interface DownloadModelResult {
  model: WhisperModelSize
  path: string
  bytes: number
}

/**
 * Stream a GGML model to disk with SHA verification. Removes the partial file on
 * any failure (HTTP error, abort, or SHA mismatch) so a corrupt/incomplete model
 * is never left behind. Resolves with the final path + byte count.
 */
export async function downloadModel(opts: DownloadModelOptions): Promise<DownloadModelResult> {
  const dest = opts.destPath ?? modelFilePath(opts.model)
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = modelUrl(opts.model)
  const asset = MODEL_ASSETS[opts.model] as ModelAsset | undefined
  const expectedBytes = opts.expectedBytes ?? asset?.bytes

  if (opts.signal?.aborted) throw new Error('model download cancelled')

  await mkdir(dirname(dest), { recursive: true })

  // Already have it? Do nothing at all. Pressing Download on an installed model
  // used to truncate it on the first byte and then delete it on any hiccup — the
  // "my model vanished and I had to download it again" report (BUG-45xt77).
  if (expectedBytes && existsSync(dest) && statSync(dest).size === expectedBytes) {
    opts.onProgress?.(expectedBytes, expectedBytes)
    return { model: opts.model, path: dest, bytes: expectedBytes }
  }

  // Stream to a per-ATTEMPT temp beside the destination and rename only after the
  // bytes verify — the pattern url-download.ts / ffmpeg-export.ts already use.
  // The random suffix also makes concurrent attempts on one model safe: the job
  // queue allows 4 model-downloads with no per-model dedupe, and two writers on
  // one path interleave into a guaranteed hash mismatch.
  const tmp = `${dest}.${randomBytes(6).toString('hex')}.part`

  const cleanup = (): void => {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    } catch {
      /* best-effort */
    }
  }

  let res: Response
  try {
    res = await fetchImpl(url, { signal: opts.signal })
  } catch (err) {
    cleanup()
    throw err instanceof Error ? err : new Error(`model download failed: ${String(err)}`)
  }

  if (!res.ok || !res.body) {
    cleanup()
    throw new Error(`model download failed: HTTP ${res.status} for ${url}`)
  }

  // Total size for the progress bar. Prefer HF's authoritative `x-linked-size`; a
  // non-finite/absent value resolves to 0 = INDETERMINATE (audit fix openclip-flg):
  // for xet/LFS-backed multi-GB models served via a redirect/CDN, both headers can be
  // missing. We pass the REAL total (0 when unknown) to onProgress below instead of
  // faking it as `received`, so the runner shows a byte counter rather than a
  // misleading near-100% bar from the first chunk.
  const sizeHeader = Number(res.headers.get('x-linked-size') ?? res.headers.get('content-length'))
  const headerTotal = Number.isFinite(sizeHeader) && sizeHeader > 0 ? sizeHeader : 0
  // Prefer the PINNED size: a CDN that reports nothing (or reports a range) used
  // to leave the bar indeterminate for the whole download.
  const totalBytes = headerTotal || expectedBytes || 0

  // Pinned hash first, then whatever the response happened to carry, then a
  // redirect probe. `expected` being undefined is what produced the production
  // failure — the download completed and was refused as unverifiable.
  const pinned = opts.expectedSha256 ?? asset?.sha256
  const responseEtag = parseEtag(res.headers.get('x-linked-etag'))
  const etagSha =
    responseEtag ?? (pinned ? undefined : await probeLinkedEtag(url, fetchImpl, opts.signal))
  const expected = pinned ?? etagSha

  // A pin AND an etag that disagree means the hub republished the file. Installing
  // the new bytes silently would defeat the point of pinning, so refuse and say so.
  if (pinned && responseEtag && responseEtag !== pinned) {
    cleanup()
    throw new JobError(
      'INPUT_INVALID',
      `model ${opts.model}: the published file no longer matches the SHA256 this build pins (published ${responseEtag}, pinned ${pinned}). Refusing to install it.`,
      false
    )
  }

  const hash = createHash('sha256')
  let received = 0

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(tmp)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk)
        received += chunk.length
        opts.onProgress?.(received, totalBytes)
        out.write(chunk, cb)
      }
    })
    // Tear the body stream down deterministically on abort/error (audit fix
    // openclip-0wn): the fetch reader holds a lock + an in-flight read() that the fetch
    // signal alone doesn't settle, and the manual sink is otherwise never destroyed —
    // for a multi-GB cancelled download that pins the reader/socket until GC.
    const teardown = (): void => {
      out.destroy()
      reader.cancel().catch(() => {})
      sink.destroy()
    }
    const onAbort = (): void => {
      teardown()
      reject(new Error('model download cancelled'))
    }
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort()
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    const pump = async (): Promise<void> => {
      for (;;) {
        if (opts.signal?.aborted) throw new Error('model download cancelled')
        const { done, value } = await reader.read()
        if (done) break
        await new Promise<void>((r, j) => sink.write(value, (e) => (e ? j(e) : r())))
      }
    }

    pump()
      .then(
        () =>
          new Promise<void>((r) => {
            out.end(() => r())
          })
      )
      .then(() => {
        opts.signal?.removeEventListener('abort', onAbort)
        resolve()
      })
      .catch((err: unknown) => {
        opts.signal?.removeEventListener('abort', onAbort)
        teardown()
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  }).catch((err) => {
    cleanup()
    throw err
  })

  // Verify the SHA before declaring success. An UNVERIFIABLE download — no explicit
  // expectedSha256, no `x-linked-etag` from HF, and the model isn't pinned in
  // KNOWN_SHA256 — must be REFUSED, not kept (audit fix openclip-t1b). Previously the
  // `if (expected && …)` guard silently skipped verification when `expected` was
  // undefined, so a corrupt/tampered multi-GB model could land on disk whenever HF
  // (or a CDN/proxy) omitted the etag header. Integrity is byte-level here, never a
  // header-only signal.
  const actual = hash.digest('hex')
  if (!expected) {
    cleanup()
    // Reachable only for a model with no manifest entry — every model the app
    // OFFERS is pinned, and a missing pin fails `model-download-safety.spec.ts`.
    // PERMANENT: no expected hash will ever materialize for this model, so retrying is
    // futile — surface as a non-retriable INPUT_INVALID, not a retriable SIDECAR_CRASH
    // (audit fix openclip-1ly).
    throw new JobError(
      'INPUT_INVALID',
      `model ${opts.model}: unable to verify integrity — no expected SHA256, no x-linked-etag, and not in KNOWN_SHA256. Refusing to keep an unverified download.`,
      false
    )
  }
  if (actual !== expected) {
    cleanup()
    throw new Error(
      `model download SHA256 mismatch for ${opts.model}: expected ${expected}, got ${actual}`
    )
  }

  // Verified: NOW it may replace whatever was there. Atomic within the directory,
  // so a reader either sees the old complete model or the new one.
  renameSync(tmp, dest)

  return { model: opts.model, path: dest, bytes: received }
}

/** The directory models live in (re-exported for callers/UX). */
export { modelsDir }
