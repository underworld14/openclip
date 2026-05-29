/**
 * tests/unit/url-download.spec.ts — the pure yt-dlp `--newline` progress parser
 * + the `downloadUrl` service with an INJECTED fake subprocess (no real network
 * / no real yt-dlp). Proves: percentage + size parsing across the in-progress
 * and terminal line forms, the final-path extraction, progress streaming, the
 * abort→cancel/kill path, and the typed failure when no path is printed (F.4).
 */

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import {
  parseProgress,
  parseProgressChunk,
  parseFinalFilePath,
  ytDlpFlags,
  downloadUrl,
  type YtDlpSubprocess
} from '@main/services/url-download'

// ── parseProgress (pure) ──────────────────────────────────────────────────────

describe('parseProgress: yt-dlp --newline [download] lines → {downloaded,total,pct}', () => {
  it('parses an in-progress line with an approximate (~) size', () => {
    const p = parseProgress('[download]  10.5% of ~  50.00MiB at  2.00MiB/s ETA 00:20')
    expect(p).not.toBeNull()
    expect(p!.pct).toBeCloseTo(10.5)
    expect(p!.totalBytes).toBe(Math.round(50 * 1024 ** 2))
    expect(p!.downloadedBytes).toBe(Math.round((50 * 1024 ** 2 * 10.5) / 100))
  })

  it('parses the terminal 100% line (exact size, "in 00:25")', () => {
    const p = parseProgress('[download] 100% of 50.00MiB in 00:25')
    expect(p).not.toBeNull()
    expect(p!.pct).toBe(100)
    expect(p!.totalBytes).toBe(Math.round(50 * 1024 ** 2))
    expect(p!.downloadedBytes).toBe(Math.round(50 * 1024 ** 2))
  })

  it('handles GiB / KiB units', () => {
    expect(parseProgress('[download]  50.0% of 1.50GiB')!.totalBytes).toBe(
      Math.round(1.5 * 1024 ** 3)
    )
    expect(parseProgress('[download]   1.0% of 512.00KiB')!.totalBytes).toBe(Math.round(512 * 1024))
  })

  it('returns a pct with zeroed bytes when the size is unknown', () => {
    const p = parseProgress('[download]   5.0% of Unknown')
    expect(p).not.toBeNull()
    expect(p!.pct).toBe(5)
    expect(p!.totalBytes).toBe(0)
    expect(p!.downloadedBytes).toBe(0)
  })

  it('returns null for non-progress lines', () => {
    expect(parseProgress('[info] Downloading 1 format(s): 137+140')).toBeNull()
    expect(parseProgress('[Merger] Merging formats into "M5XbNdzPuDQ.mp4"')).toBeNull()
    expect(parseProgress('/tmp/openclip/downloads/j1/M5XbNdzPuDQ.mp4')).toBeNull()
    expect(parseProgress('')).toBeNull()
  })

  it('clamps pct to [0,100]', () => {
    expect(parseProgress('[download] 0.0% of 10.00MiB')!.pct).toBe(0)
    expect(parseProgress('[download] 100.0% of 10.00MiB')!.pct).toBe(100)
  })
})

describe('parseProgressChunk: returns the LAST progress sample in a multi-line chunk', () => {
  it('takes the most recent percentage from a batched chunk', () => {
    const chunk = [
      '[download]  10.0% of ~50.00MiB',
      '[download]  20.0% of ~50.00MiB',
      '[download]  30.0% of ~50.00MiB'
    ].join('\n')
    const p = parseProgressChunk(chunk)
    expect(p!.pct).toBe(30)
  })
  it('returns null when the chunk has no progress line', () => {
    expect(parseProgressChunk('[info] ...\n[Merger] ...')).toBeNull()
  })
})

// ── parseFinalFilePath (pure) ─────────────────────────────────────────────────

describe('parseFinalFilePath: extracts the after_move:filepath print line', () => {
  it('returns the printed absolute path, ignoring [..] log lines', () => {
    const stdout = [
      '[download]  10.0% of ~50.00MiB',
      '[download] 100% of 50.00MiB in 00:25',
      '[Merger] Merging formats into "M5XbNdzPuDQ.mp4"',
      '/tmp/openclip/downloads/j1/M5XbNdzPuDQ.mp4'
    ].join('\n')
    expect(parseFinalFilePath(stdout)).toBe('/tmp/openclip/downloads/j1/M5XbNdzPuDQ.mp4')
  })
  it('returns null when no path is printed', () => {
    expect(parseFinalFilePath('[download] 100% of 50.00MiB\n[info] done')).toBeNull()
  })
})

// ── ytDlpFlags (pure, asserts the TOS-grounded invocation) ────────────────────

describe('ytDlpFlags: the exact yt-dlp invocation', () => {
  it('uses newline progress, bv*+ba/b → mp4, no playlist, our ffmpeg, printed path', () => {
    const flags = ytDlpFlags('/out/dir', '/bundle/ffmpeg-dir')
    expect(flags).toMatchObject({
      newline: true,
      output: join('/out/dir', '%(id)s.%(ext)s'),
      format: 'bv*+ba/b',
      mergeOutputFormat: 'mp4',
      noPlaylist: true,
      ffmpegLocation: '/bundle/ffmpeg-dir',
      print: 'after_move:filepath',
      restrictFilenames: true
    })
  })
})

// ── downloadUrl with an injected fake subprocess ──────────────────────────────

/** A fake youtube-dl-exec subprocess: emits scripted stdout lines, then resolves. */
function makeFakeSubprocess(opts: {
  lines: string[]
  finalStdout: string
  pid?: number
  hang?: boolean
}): { subprocess: YtDlpSubprocess; emitAll: () => void } {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  let resolveFn: (v: { stdout?: string; stderr?: string }) => void = () => {}
  let rejectFn: (e: unknown) => void = () => {}
  const promise = new Promise<{ stdout?: string; stderr?: string }>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })
  let cancelled = false
  const subprocess: YtDlpSubprocess = {
    pid: opts.pid ?? 4242,
    stdout: { on: (e, cb) => stdout.on(e, cb) },
    stderr: { on: (e, cb) => stderr.on(e, cb) },
    cancel: () => {
      cancelled = true
      rejectFn(new Error('cancelled'))
    },
    kill: () => {
      cancelled = true
      rejectFn(new Error('killed'))
    },
    then: promise.then.bind(promise)
  }
  const emitAll = (): void => {
    for (const l of opts.lines) stdout.emit('data', Buffer.from(l + '\n'))
    if (!opts.hang && !cancelled) resolveFn({ stdout: opts.finalStdout })
  }
  return { subprocess, emitAll }
}

describe('downloadUrl: streams parsed progress and resolves with the merged path + bytes', () => {
  it('emits progress samples and returns {filePath,bytes} from the printed path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-urldl-'))
    const filePath = join(dir, 'M5XbNdzPuDQ.mp4')
    writeFileSync(filePath, Buffer.alloc(1234))

    const lines = [
      '[download]  10.0% of ~50.00MiB',
      '[download]  60.0% of ~50.00MiB',
      '[download] 100% of 50.00MiB in 00:25',
      `[Merger] Merging formats into "${filePath}"`
    ]
    const { subprocess, emitAll } = makeFakeSubprocess({
      lines,
      finalStdout: lines.join('\n') + `\n${filePath}\n`
    })

    const seen: number[] = []
    let trackedPid = -1
    const resultP = downloadUrl({
      url: 'https://youtu.be/M5XbNdzPuDQ',
      outDir: dir,
      ffmpegDir: '/bundle/ffmpeg-dir',
      onProgress: (p) => seen.push(p.pct),
      onPid: (pid) => (trackedPid = pid),
      exec: () => subprocess
    })
    // Drive the scripted output then await the result.
    emitAll()
    const result = await resultP

    expect(trackedPid).toBe(4242)
    expect(seen).toEqual([10, 60, 100])
    expect(result.filePath).toBe(filePath)
    expect(result.bytes).toBe(1234)
  })

  it('throws a typed error when yt-dlp prints no resolvable file path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-urldl-'))
    const { subprocess, emitAll } = makeFakeSubprocess({
      lines: ['[download] 100% of 50.00MiB'],
      finalStdout: '[download] 100% of 50.00MiB\n[info] done\n'
    })
    const p = downloadUrl({
      url: 'https://x',
      outDir: dir,
      ffmpegDir: '/f',
      exec: () => subprocess
    })
    emitAll()
    await expect(p).rejects.toThrow(/could not resolve the downloaded file path/i)
  })

  it('honors an already-aborted signal (no work, cancelled error)', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      downloadUrl({
        url: 'https://x',
        outDir: '/tmp',
        ffmpegDir: '/f',
        signal: ac.signal,
        exec: () => {
          throw new Error('exec should not be called when pre-aborted')
        }
      })
    ).rejects.toThrow(/cancelled/i)
  })

  it('cancels the subprocess when the signal aborts mid-flight', async () => {
    const ac = new AbortController()
    const cancel = vi.fn()
    const subprocess: YtDlpSubprocess = {
      pid: 9,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      cancel,
      kill: vi.fn(),
      then: new Promise<{ stdout?: string }>(() => {}).then.bind(
        new Promise<{ stdout?: string }>(() => {})
      )
    }
    const p = downloadUrl({
      url: 'https://x',
      outDir: '/tmp',
      ffmpegDir: '/f',
      signal: ac.signal,
      exec: () => subprocess
    })
    ac.abort()
    // The abort listener fires synchronously on abort().
    expect(cancel).toHaveBeenCalled()
    // Prevent an unhandled rejection: the never-resolving promise won't settle,
    // so attach a catch and don't await it.
    void p.catch(() => {})
  })
})
