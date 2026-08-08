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
 * SHA verification: HF serves these LFS/xet files with an `x-linked-etag` header
 * that is EXACTLY the file's SHA256 (verified against the local tiny model). We
 * verify the downloaded bytes against the caller-provided hash, else against the
 * etag, else against the bundled `KNOWN_SHA256` table — refusing to keep a file
 * whose hash we cannot confirm OR that mismatches (no corrupt model on disk).
 *
 * Network is injectable (`fetchImpl`) so the streaming/verify/cancel logic is
 * unit-tested without a real HF call (PRD §18).
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
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

/** The verified HF resolve URL for a GGML model (PRD §13 / Gate-A finding). */
export function modelUrl(model: WhisperModelSize): string {
  return `${HF_BASE}/ggml-${model}.bin`
}

/**
 * Known-good SHA256 of the published ggml models (defence-in-depth alongside the
 * HF `x-linked-etag`). Only `tiny` is pinned here (the one the smoke reuses);
 * other sizes verify against the response etag. Extend as sizes are validated.
 */
export const KNOWN_SHA256: Partial<Record<WhisperModelSize, string>> = {
  tiny: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'
}

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

/** Status of one (or all) models on disk: installed + path + bytes (PRD §13). */
export function modelStatus(model?: WhisperModelSize): ModelStatus[] {
  const list = model ? [model] : ALL_MODELS
  return list.map((m) => {
    const path = modelFilePath(m)
    if (existsSync(path)) {
      return { model: m, installed: true, path, bytes: statSync(path).size }
    }
    return { model: m, installed: false }
  })
}

/** Whether a model is present in `userData/models` (first-transcribe gate). */
export function isModelInstalled(model: WhisperModelSize): boolean {
  return existsSync(modelFilePath(model))
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

// ============================================================================
// downloadModel — stream to disk, verify SHA, byte-progress, cancel
// ============================================================================

export interface DownloadModelOptions {
  model: WhisperModelSize
  /** Absolute destination path (defaults to userData/models/ggml-<size>.bin). */
  destPath?: string
  /** Expected SHA256 (else the response etag, else KNOWN_SHA256). */
  expectedSha256?: string
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

  if (opts.signal?.aborted) throw new Error('model download cancelled')

  await mkdir(dirname(dest), { recursive: true })

  const cleanup = (): void => {
    try {
      if (existsSync(dest)) rmSync(dest, { force: true })
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
  const totalBytes = Number.isFinite(sizeHeader) && sizeHeader > 0 ? sizeHeader : 0
  const etagSha = parseEtag(res.headers.get('x-linked-etag'))
  const expected = opts.expectedSha256 ?? etagSha ?? KNOWN_SHA256[opts.model]

  const hash = createHash('sha256')
  let received = 0

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(dest)
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

  return { model: opts.model, path: dest, bytes: received }
}

/** The directory models live in (re-exported for callers/UX). */
export { modelsDir }
