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
 * Cancellation: `ctx.signal` aborts → we `subprocess.kill('SIGTERM')` (the real
 * youtube-dl-exec/tinyspawn subprocess exposes only kill(), no cancel()), letting
 * yt-dlp remove its .part fragments; the pid is registered via `ctx.trackPid` so
 * the SidecarManager escalates SIGTERM→SIGKILL on the tracked pid if it lingers
 * (PRD §17).
 *
 * Output is tuned for the preview `<video>` (Chromium): we prefer H.264+AAC in
 * mp4 (`ytDlpFlags` format ladder) and write the moov atom up front
 * (`-movflags +faststart`) so playback/seeking starts without downloading the
 * whole file (F.4 / G.1).
 */

import { statSync, existsSync, renameSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
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

/**
 * Pull the sentinel-prefixed title line (`OCLIP_TITLE:<title>`) out of yt-dlp's
 * stdout (printed via `--print before_dl:OCLIP_TITLE:%(title)s`). Returns the
 * first title found, or `undefined` if none was printed.
 */
export function parseTitle(stdout: string): string | undefined {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith(TITLE_PRINT_PREFIX)) {
      const rest = line.slice(TITLE_PRINT_PREFIX.length).trim()
      if (!rest) continue
      // Printed via %(title)j (JSON-encoded) so the title is always a single line
      // even if it contains newlines/quotes; JSON.parse it. Tolerate a bare value.
      try {
        const parsed = JSON.parse(rest)
        return typeof parsed === 'string' && parsed ? parsed : undefined
      } catch {
        return rest
      }
    }
  }
  return undefined
}

/**
 * Validate a URL at the MAIN-PROCESS trust boundary before it reaches yt-dlp as
 * positional argv #1 (the renderer's `isUrl` regex is convenience, not security
 * — a compromised renderer could call `jobs.start` directly). Requires an http(s)
 * URL and rejects a leading '-' so the value can never be parsed as a yt-dlp flag
 * (argv injection). Returns the trimmed URL; throws on rejection.
 */
export function assertSafeUrl(raw: string): string {
  const url = (raw ?? '').trim()
  if (!url || url.startsWith('-')) throw new Error('invalid download URL')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('invalid download URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported URL protocol: ${parsed.protocol}`)
  }
  return url
}

/**
 * Turn a youtube-dl-exec/tinyspawn rejection into a clean, user-facing message:
 * prefer the real yt-dlp `ERROR:` line from stderr (e.g. "Video unavailable")
 * and NEVER surface tinyspawn's boilerplate trace, which embeds the full spawned
 * command line + the absolute yt-dlp path (G.2 error surfacing + info hygiene).
 */
export function ytdlpErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { stderr?: unknown; message?: unknown }
  const stderr = typeof e.stderr === 'string' ? e.stderr : ''
  const errLine = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^ERROR\b/i.test(l))
    .pop()
  if (errLine) return errLine.replace(/^ERROR:?\s*/i, '')
  const msg = typeof e.message === 'string' ? e.message : ''
  // tinyspawn's message is "The command spawned as: `<cmd> <flags>` …" — never
  // surface it (leaks the argv + binary path); fall back to a generic message.
  if (msg && !/command spawned as/i.test(msg)) return msg
  return 'yt-dlp failed to download the video'
}

// ============================================================================
// The injectable yt-dlp surface (so tests don't spawn a real process)
// ============================================================================

/** The subset of `youtube-dl-exec`'s subprocess we depend on. */
export interface YtDlpSubprocess {
  pid?: number
  stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
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
  /** Injectable faststart remux (tests). Defaults to `faststartRemux` with our ffmpeg. */
  remux?: (filePath: string) => Promise<void>
}

export interface UrlDownloadResult {
  filePath: string
  title?: string
  bytes: number
}

/** Options for an ffmpeg run / remux: pid registration + cancellation. */
interface FfmpegRunOptions {
  /** Register the spawned pid so the SidecarManager can SIGTERM→SIGKILL it on quit. */
  onPid?: (pid: number) => void
  /** Cancel: SIGKILL the ffmpeg child if this aborts. */
  signal?: AbortSignal
}

/** Run ffmpeg with args; resolves true on a clean exit-0 (best-effort, never throws). */
function runFfmpeg(
  ffmpegBin: string,
  args: string[],
  opts: FfmpegRunOptions = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegBin, args, { stdio: 'ignore' })
    if (typeof p.pid === 'number') opts.onPid?.(p.pid)
    const onAbort = (): void => {
      try {
        p.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (ok: boolean): void => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    p.on('error', () => done(false))
    p.on('close', (code) => done(code === 0))
  })
}

/** Injectable runner type (tests). */
export type FfmpegRunner = (
  bin: string,
  args: string[],
  opts?: FfmpegRunOptions
) => Promise<boolean>

export interface FaststartOptions {
  /** Injectable ffmpeg runner (tests). Defaults to the real `runFfmpeg`. */
  run?: FfmpegRunner
  /** Register the ffmpeg pid (→ ctx.trackPid) so it's killed on quit (PRD §17). */
  onPid?: (pid: number) => void
  /** Cancel the remux on abort; also skips entirely if already aborted. */
  signal?: AbortSignal
}

/**
 * Rewrite an mp4 IN PLACE with the moov atom at the FRONT (`-movflags +faststart`)
 * via `-c copy` (no re-encode → fast) so the preview `<video>` can start playing
 * and seeking without first downloading the whole file (G.1 — fixes the "long
 * wait to load"). Guaranteed for BOTH merged and single-file downloads. Best-
 * effort: on any failure (or cancel) the original file is left untouched (it
 * still plays, just slower). The ffmpeg child is pid-tracked + cancel-aware so a
 * quit/cancel mid-remux never orphans it (PRD §17).
 */
export async function faststartRemux(
  filePath: string,
  ffmpegBin: string,
  opts: FaststartOptions = {}
): Promise<void> {
  if (opts.signal?.aborted) return // don't start a remux for an already-cancelled job
  const run = opts.run ?? runFfmpeg
  const tmp = `${filePath}.faststart.mp4`
  try {
    const ok = await run(
      ffmpegBin,
      ['-y', '-i', filePath, '-c', 'copy', '-movflags', '+faststart', tmp],
      {
        onPid: opts.onPid,
        signal: opts.signal
      }
    )
    // Cancelled mid-remux: discard the (possibly partial) tmp, keep the original.
    if (opts.signal?.aborted || !ok) {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
      return
    }
    if (existsSync(tmp)) renameSync(tmp, filePath)
  } catch {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
  }
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
/**
 * Sentinel prefix for the human-title `--print` line so it is unambiguous to
 * parse out of yt-dlp's stdout (a raw title could otherwise look like anything,
 * incl. a path). Printed via `--print before_dl:OCLIP_TITLE:%(title)s`.
 */
export const TITLE_PRINT_PREFIX = 'OCLIP_TITLE:'

export function ytDlpFlags(outDir: string, ffmpegDir: string): Record<string, unknown> {
  return {
    newline: true, // one progress line per update (parseProgress)
    output: join(outDir, '%(id)s.%(ext)s'),
    // Prefer H.264 video + AAC audio (mp4) so the preview <video> can always
    // decode it; fall back to best mp4, then any best video+audio, then best
    // single stream (G.1 codec robustness — YouTube's "best" is often VP9/AV1
    // which Chromium's <video> may refuse). (faststart is applied AFTER download
    // by faststartRemux — guaranteed for both merged and single-file results.)
    format: "bv*[vcodec~='^(avc1|h264)']+ba[acodec~='^(mp4a|aac)']/b[ext=mp4]/bv*+ba/b",
    mergeOutputFormat: 'mp4',
    noPlaylist: true, // a single video even if the URL is a playlist item
    ffmpegLocation: ffmpegDir, // use OUR bundled ffmpeg for the mux
    // Final merged path (plain abs path → parseFinalFilePath) + the human title
    // (sentinel-prefixed, JSON-encoded via %(title)j so it stays on one line even
    // with newlines/quotes → parseTitle); before_dl prints it before downloading.
    print: ['after_move:filepath', `before_dl:${TITLE_PRINT_PREFIX}%(title)j`],
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

  // Trust boundary: validate the URL here (main process), not only in the
  // renderer — and pass the validated value (never a leading-dash flag) to exec.
  const safeUrl = assertSafeUrl(opts.url)
  const exec = opts.exec ?? defaultExec()
  const ffmpegDir = opts.ffmpegDir ?? dirname(ffmpegPath())
  const subprocess = exec(safeUrl, ytDlpFlags(opts.outDir, ffmpegDir))

  if (typeof subprocess.pid === 'number') opts.onPid?.(subprocess.pid)

  const onData = (chunk: Buffer | string): void => {
    const p = parseProgressChunk(chunk.toString())
    if (p) opts.onProgress?.(p)
  }
  // yt-dlp writes progress to stdout under --newline; tolerate stderr too.
  subprocess.stdout?.on('data', onData)
  subprocess.stderr?.on('data', onData)

  const onAbort = (): void => {
    // The real subprocess exposes only kill(): SIGTERM lets yt-dlp clean up its
    // .part fragments; the SidecarManager escalates to SIGKILL on the tracked
    // pid if it lingers (PRD §17). No cancel() exists on the real backend.
    try {
      subprocess.kill('SIGTERM')
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
    throw new Error(ytdlpErrorMessage(err))
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }

  if (opts.signal?.aborted) throw new Error('url download cancelled')

  const filePath = parseFinalFilePath(captured.stdout ?? '')
  if (!filePath) {
    throw new Error('url download: could not resolve the downloaded file path from yt-dlp output')
  }
  if (!existsSync(filePath)) {
    throw new Error(`url download: downloaded file is missing on disk: ${filePath}`)
  }

  // Faststart-remux so the preview <video> plays/seeks without a full download
  // (G.1). Best-effort + in place; the ffmpeg child is pid-tracked + cancel-aware
  // (via onPid/signal) so a quit/cancel mid-remux can't orphan it (PRD §17).
  const ffmpegBin = join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const remux =
    opts.remux ??
    ((fp: string) => faststartRemux(fp, ffmpegBin, { signal: opts.signal, onPid: opts.onPid }))
  await remux(filePath)

  let bytes = 0
  try {
    bytes = statSync(filePath).size
  } catch {
    throw new Error(`url download: downloaded file is missing on disk: ${filePath}`)
  }

  const title = parseTitle(captured.stdout ?? '')
  return { filePath, title, bytes }
}
