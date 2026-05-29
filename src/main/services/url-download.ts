/**
 * src/main/services/url-download.ts — download a remote video (YouTube/URL) to
 * disk via the bundled yt-dlp (F.4). Factory-injectable + pure-ish, mirroring
 * `model-manager`: the streaming/progress/cancel logic is unit-testable without
 * a real network call by injecting a fake `exec` (PRD §18, §20.4).
 *
 * yt-dlp is driven through `youtube-dl-exec`'s `create(ytDlpPath())` binding so
 * the SAME binary the prod bundle ships (paths.ytDlpPath) is used. We pass
 * `--newline` so download progress arrives as one line per update on STDOUT
 * (`[download]  xx.x% of ~yyMiB …`), parsed by the pure exported `parseProgress`
 * fn into `{ downloadedBytes, totalBytes, pct }`. `--print after_move:filepath`
 * emits the FINAL merged file path on its own stdout line (deterministic output
 * path, robust to yt-dlp's `%(id)s.%(ext)s` template + the mp4 merge).
 *
 * Cancellation: the runner's `ctx.signal` is wired to `subprocess.cancel?.()`
 * then `subprocess.kill('SIGKILL')`; the pid is registered via `ctx.trackPid`
 * so the SidecarManager also escalates SIGTERM→SIGKILL on quit (PRD §17).
 */

import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ffmpegPath, ytDlpPath } from '@main/utils/paths'

// ============================================================================
// Pure progress parsing (unit-tested; no I/O)
// ============================================================================

/** One parsed yt-dlp `--newline` download-progress sample. */
export interface UrlDownloadProgress {
  downloadedBytes: number
  totalBytes: number
  pct: number
}

const UNIT_MULTIPLIER: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  // yt-dlp usually emits the binary units above, but tolerate decimal too.
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4
}

/** Convert a "12.34MiB" size token to bytes; returns 0 if unparseable. */
function sizeToBytes(value: number, unit: string): number {
  const mult = UNIT_MULTIPLIER[unit]
  return mult ? Math.round(value * mult) : 0
}

/**
 * Parse a single yt-dlp `--newline` stderr/stdout line into a progress sample,
 * or `null` if the line is not a `[download]` percentage line. Handles the
 * approximate size marker (`~`), the in-progress form
 * (`[download]  10.5% of ~  50.00MiB at 2.00MiB/s ETA 00:20`) and the terminal
 * form (`[download] 100% of 50.00MiB in 00:25`). `totalBytes` is derived from
 * the "of <size>" token; `downloadedBytes` is `round(total * pct/100)` (yt-dlp
 * does not print absolute downloaded bytes on the progress line). When the size
 * is unknown, `totalBytes` is 0 and `downloadedBytes` is 0 (pct still tracks).
 */
export function parseProgress(line: string): UrlDownloadProgress | null {
  // Must be a download-progress line with a percentage.
  const pctMatch = line.match(/\[download\]\s+([\d.]+)%/)
  if (!pctMatch) return null
  const pct = Math.min(100, Math.max(0, parseFloat(pctMatch[1])))
  if (Number.isNaN(pct)) return null

  // Optional "of ~ 50.00MiB" (the ~ and surrounding spaces are optional).
  const sizeMatch = line.match(/of\s+~?\s*([\d.]+)\s*([KMGT]i?B|B)\b/)
  let totalBytes = 0
  if (sizeMatch) {
    totalBytes = sizeToBytes(parseFloat(sizeMatch[1]), sizeMatch[2])
  }
  const downloadedBytes = totalBytes > 0 ? Math.round((totalBytes * pct) / 100) : 0
  return { downloadedBytes, totalBytes, pct }
}

/**
 * Scan a chunk of `--newline` output (possibly several lines) and yield the LAST
 * progress sample it contains (yt-dlp may batch several updates per data event).
 * Returns `null` if the chunk has no progress line.
 */
export function parseProgressChunk(chunk: string): UrlDownloadProgress | null {
  let last: UrlDownloadProgress | null = null
  for (const line of chunk.split(/\r?\n|\r/)) {
    const p = parseProgress(line)
    if (p) last = p
  }
  return last
}

/**
 * Pull the `after_move:filepath` print line out of yt-dlp's stdout. We pass
 * `--print after_move:filepath`, so the absolute merged-file path is printed on
 * its OWN line (no `[...]` prefix). We take the LAST such non-progress, non-log,
 * absolute-looking path line.
 */
export function parseFinalFilePath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/)
  let found: string | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('[')) continue // [download], [Merger], [info] …
    if (line.startsWith('WARNING') || line.startsWith('ERROR')) continue
    // A real filesystem path (absolute on posix or a drive letter on win).
    if (line.startsWith('/') || /^[A-Za-z]:[\\/]/.test(line)) found = line
  }
  return found
}

// ============================================================================
// The injectable yt-dlp surface (so tests don't spawn a real process)
// ============================================================================

/** The subset of `youtube-dl-exec`'s subprocess we depend on. */
export interface YtDlpSubprocess {
  pid?: number
  stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  cancel?: () => void
  kill: (signal?: NodeJS.Signals | number) => void
  /** Awaiting the subprocess resolves with the captured stdout/stderr. */
  then: Promise<{ stdout?: string; stderr?: string }>['then']
}

/** `exec(url, flags)` → a subprocess (mirrors youtube-dl-exec's `exec`). */
export type YtDlpExec = (url: string, flags: Record<string, unknown>) => YtDlpSubprocess

export interface UrlDownloadOptions {
  url: string
  /** Directory to download into (the runner passes a per-job temp dir). */
  outDir: string
  /** Progress callback fed by parsed `--newline` lines. */
  onProgress?: (p: UrlDownloadProgress) => void
  /** Cooperative cancel — cancels/kills the subprocess. */
  signal?: AbortSignal
  /** Called once with the spawned pid so the sidecar can kill it on quit. */
  onPid?: (pid: number) => void
  /** Injectable exec (tests). Defaults to a real `create(ytDlpPath())` binding. */
  exec?: YtDlpExec
  /** Injectable ffmpeg dir (tests). Defaults to `dirname(ffmpegPath())`. */
  ffmpegDir?: string
}

export interface UrlDownloadResult {
  filePath: string
  title?: string
  bytes: number
}

/** Lazily build a real `create(ytDlpPath())` exec binding (avoids import cost in tests). */
function defaultExec(): YtDlpExec {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create } = require('youtube-dl-exec') as {
    create: (binPath: string) => { exec: YtDlpExec }
  }
  return create(ytDlpPath()).exec
}

/**
 * The yt-dlp flags we invoke with. Exported so the runner/tests can assert the
 * exact, TOS-grounded invocation (best video+audio merged to mp4, single video,
 * deterministic filename + printed final path, bundled ffmpeg for the merge).
 */
export function ytDlpFlags(outDir: string, ffmpegDir: string): Record<string, unknown> {
  return {
    newline: true, // one progress line per update (parseProgress)
    output: join(outDir, '%(id)s.%(ext)s'),
    format: 'bv*+ba/b', // best video + best audio, else best single stream
    mergeOutputFormat: 'mp4',
    noPlaylist: true, // a single video even if the URL is a playlist item
    ffmpegLocation: ffmpegDir, // use OUR bundled ffmpeg for the mux
    print: 'after_move:filepath', // deterministic final path on stdout
    restrictFilenames: true
  }
}

/**
 * Download a video from `url` into `outDir` via yt-dlp, streaming parsed
 * `--newline` progress and resolving with the final merged file path + size.
 * Cancellation aborts the subprocess. Throws on a non-zero exit / parse failure
 * so the runner maps it to a typed `error` event (no silent hang).
 */
export async function downloadUrl(opts: UrlDownloadOptions): Promise<UrlDownloadResult> {
  if (opts.signal?.aborted) throw new Error('url download cancelled')

  const exec = opts.exec ?? defaultExec()
  const ffmpegDir = opts.ffmpegDir ?? dirname(ffmpegPath())
  const subprocess = exec(opts.url, ytDlpFlags(opts.outDir, ffmpegDir))

  if (typeof subprocess.pid === 'number') opts.onPid?.(subprocess.pid)

  const onData = (chunk: Buffer | string): void => {
    const p = parseProgressChunk(chunk.toString())
    if (p) opts.onProgress?.(p)
  }
  // yt-dlp writes progress to stdout under --newline; tolerate stderr too.
  subprocess.stdout?.on('data', onData)
  subprocess.stderr?.on('data', onData)

  const onAbort = (): void => {
    try {
      subprocess.cancel?.()
    } catch {
      /* best-effort */
    }
    try {
      subprocess.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true })

  let captured: { stdout?: string; stderr?: string }
  try {
    captured = await (subprocess as unknown as Promise<{ stdout?: string; stderr?: string }>)
  } catch (err) {
    if (opts.signal?.aborted) throw new Error('url download cancelled')
    throw err instanceof Error ? err : new Error(`url download failed: ${String(err)}`)
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }

  if (opts.signal?.aborted) throw new Error('url download cancelled')

  const filePath = parseFinalFilePath(captured.stdout ?? '')
  if (!filePath) {
    throw new Error('url download: could not resolve the downloaded file path from yt-dlp output')
  }

  let bytes = 0
  try {
    bytes = statSync(filePath).size
  } catch {
    throw new Error(`url download: downloaded file is missing on disk: ${filePath}`)
  }

  return { filePath, bytes }
}
