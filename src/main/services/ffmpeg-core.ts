/**
 * src/main/services/ffmpeg-core.ts — the FFmpeg/ffprobe spawn wrapper + the
 * stderr→progress parser (TRUNK INFRA, frozen after Stage 3 — plan E.2/E.4).
 *
 * This is the shared core every FFmpeg-using service composes on top of. The
 * fan-out tracks author sibling modules (`ffmpeg-extract`, `ffmpeg-export`,
 * `ffmpeg-caption`) that call `runFfmpeg(...)` here and re-export through the
 * `ffmpeg.ts` barrel — no track ever edits this file (plan E.4 "no shared file").
 *
 * Progress: FFmpeg with `-progress pipe:2 -nostats` emits `key=value` lines on
 * stderr; we parse `out_time_ms`/`out_time_us`/`frame=` and convert to a `pct`
 * given a known total duration, surfaced as a `JobEvent {t:'progress'}` by the
 * caller. We expose a pure `parseFfmpegProgress` so it is unit-testable against
 * canned stderr without spawning anything (PRD §18).
 */

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { ffmpegPath } from '@main/utils/paths'

// ============================================================================
// Progress parsing (pure — unit-tested without a real binary)
// ============================================================================

export interface FfmpegProgress {
  /** Decoded output position in microseconds (from out_time_us/out_time_ms). */
  outTimeUs?: number
  /** Frame number, if FFmpeg reported `frame=`. */
  frame?: number
  /** Encoding speed multiple (e.g. 1.5 => 1.5x realtime), if present. */
  speed?: number
  /** True once FFmpeg reports `progress=end`. */
  done: boolean
}

/**
 * Parse one chunk of FFmpeg `-progress` stderr output into a progress snapshot.
 * Accepts arbitrary chunk boundaries; only fully-seen `key=value` lines are
 * honoured. Unknown keys are ignored.
 */
export function parseFfmpegProgress(chunk: string): FfmpegProgress {
  const out: FfmpegProgress = { done: false }
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim()
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    switch (key) {
      case 'out_time_us':
        out.outTimeUs = Number(value)
        break
      case 'out_time_ms':
        // FFmpeg's `out_time_ms` is actually microseconds (historical quirk);
        // only use it if out_time_us was not already seen in this chunk.
        if (out.outTimeUs === undefined) out.outTimeUs = Number(value)
        break
      case 'frame':
        out.frame = Number(value)
        break
      case 'speed': {
        const n = Number(value.replace(/x$/i, ''))
        if (!Number.isNaN(n)) out.speed = n
        break
      }
      case 'progress':
        if (value === 'end') out.done = true
        break
      default:
        break
    }
  }
  return out
}

/**
 * Convert an FFmpeg progress snapshot to a 0..100 percentage given the known
 * total media duration in seconds. Clamped to [0,100]. Returns `undefined` when
 * no time information is available yet.
 */
export function progressPct(p: FfmpegProgress, totalDurationSec: number): number | undefined {
  if (p.done) return 100
  if (p.outTimeUs === undefined || totalDurationSec <= 0) return undefined
  const pct = (p.outTimeUs / 1_000_000 / totalDurationSec) * 100
  return Math.max(0, Math.min(100, pct))
}

// ============================================================================
// Spawn wrapper
// ============================================================================

export interface RunFfmpegOptions {
  /** Args after the binary. Callers SHOULD include `-progress pipe:2 -nostats`. */
  args: string[]
  /** Total media duration (s) used to compute pct from out_time. */
  totalDurationSec?: number
  /** Invoked with a 0..100 pct + the raw snapshot on each progress chunk. */
  onProgress?: (pct: number | undefined, snapshot: FfmpegProgress) => void
  /** AbortSignal → SIGKILL the child (cooperative cancel; PRD §17). */
  signal?: AbortSignal
  /** Override the ffmpeg binary (defaults to resolved `ffmpegPath()`). */
  binPath?: string
  /**
   * Invoked with the spawned ffmpeg child's PID (audit fix openclip-a00) so a job
   * runner can `ctx.trackPid(pid)` — giving the sidecar an OS-level SIGKILL backstop
   * on quit, in addition to the AbortSignal cancel path. No-op if the spawn yields no pid.
   */
  onSpawn?: (pid: number) => void
  /**
   * Invoked with the child's PID when it EXITS (audit fix openclip-yul) so a runner can
   * `ctx.untrackPid(pid)` — preventing a later quit/cancel from SIGKILLing a PID the OS
   * may have recycled to an unrelated process. Paired with `onSpawn`.
   */
  onExit?: (pid: number) => void
}

export interface RunFfmpegResult {
  code: number | null
  /** Captured stderr (FFmpeg writes logs + progress here). */
  stderr: string
}

/**
 * Spawn FFmpeg, stream `-progress` from stderr to `onProgress`, and resolve when
 * it exits. Rejects on non-zero exit or spawn error (callers map to JobEvent
 * `{t:'error'}`). Honours an AbortSignal for cooperative cancellation.
 */
export function runFfmpeg(opts: RunFfmpegOptions): Promise<RunFfmpegResult> {
  const bin = opts.binPath ?? ffmpegPath()
  return new Promise<RunFfmpegResult>((resolve, reject) => {
    const child: ChildProcessByStdio<null, null, Readable> = spawn(bin, opts.args, {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    // Register the PID so the sidecar can SIGKILL it on quit (audit fix openclip-a00).
    if (typeof child.pid === 'number') opts.onSpawn?.(child.pid)
    let stderr = ''
    // Progress line buffer (audit fix openclip-2p4): FFmpeg's `-progress` writes
    // `key=value\n` lines, but a stderr chunk boundary can split one mid-token
    // (e.g. `out_time_us=12` then `34567\n`). parseFfmpegProgress only honours
    // fully-seen `key=value` pairs, so a split line was silently dropped and that
    // progress sample lost. Carry the trailing partial line across chunks and parse
    // only up to the last newline. (Raw `stderr` accumulation below is unchanged so
    // the error tail still has everything.)
    let progressResidual = ''

    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stderr += text
      if (opts.onProgress) {
        progressResidual += text
        const lastNl = progressResidual.lastIndexOf('\n')
        if (lastNl < 0) return // no complete line yet — wait for more
        const complete = progressResidual.slice(0, lastNl + 1)
        progressResidual = progressResidual.slice(lastNl + 1)
        const snap = parseFfmpegProgress(complete)
        const pct = progressPct(snap, opts.totalDurationSec ?? 0)
        if (pct !== undefined || snap.frame !== undefined || snap.done) {
          opts.onProgress(pct, snap)
        }
      }
    })

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      // Untrack the exited child's PID so a later quit/cancel can't SIGKILL a recycled
      // foreign PID (audit fix openclip-yul).
      if (typeof child.pid === 'number') opts.onExit?.(child.pid)
      if (opts.signal?.aborted) {
        reject(new Error('ffmpeg aborted'))
        return
      }
      if (code === 0) resolve({ code, stderr })
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-2000)}`))
    })
  })
}
