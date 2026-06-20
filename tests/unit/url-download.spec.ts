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
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import {
  parseProgress,
  parseProgressChunk,
  parseFinalFilePath,
  parseTitle,
  assertSafeUrl,
  ytdlpErrorMessage,
  ytDlpFlags,
  TITLE_PRINT_PREFIX,
  faststartRemux,
  downloadUrl,
  type YtDlpSubprocess
} from '@main/services/url-download'
import { JobError } from '@shared/jobs'

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
  it('uses newline progress, H.264/AAC mp4 + faststart, no playlist, our ffmpeg, printed path+title', () => {
    const flags = ytDlpFlags('/out/dir', '/bundle/ffmpeg-dir')
    expect(flags).toMatchObject({
      newline: true,
      output: join('/out/dir', '%(id)s.%(ext)s'),
      format: "bv*[vcodec~='^(avc1|h264)']+ba[acodec~='^(mp4a|aac)']/b[ext=mp4]/bv*+ba/b",
      mergeOutputFormat: 'mp4',
      noPlaylist: true,
      ffmpegLocation: '/bundle/ffmpeg-dir',
      print: ['after_move:filepath', `before_dl:${TITLE_PRINT_PREFIX}%(title)j`],
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
      exec: () => subprocess,
      remux: async () => {} // skip the real ffmpeg faststart pass in unit tests
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

  it('SIGTERMs the subprocess when the signal aborts mid-flight', async () => {
    const ac = new AbortController()
    const kill = vi.fn()
    const subprocess: YtDlpSubprocess = {
      pid: 9,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      kill,
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
    // The abort listener fires synchronously on abort(); the real backend exposes
    // only kill() — we SIGTERM (the SidecarManager escalates to SIGKILL).
    expect(kill).toHaveBeenCalledWith('SIGTERM')
    // Prevent an unhandled rejection: the never-resolving promise won't settle,
    // so attach a catch and don't await it.
    void p.catch(() => {})
  })

  it('parses and returns the printed title (G.2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-urldl-'))
    const filePath = join(dir, 'M5XbNdzPuDQ.mp4')
    writeFileSync(filePath, Buffer.alloc(10))
    const finalStdout = `${TITLE_PRINT_PREFIX}"ClickHouse — Database OLAP"\n${filePath}\n` // %(title)j is JSON
    const { subprocess, emitAll } = makeFakeSubprocess({ lines: [], finalStdout })
    const resultP = downloadUrl({
      url: 'https://youtu.be/x',
      outDir: dir,
      ffmpegDir: '/f',
      exec: () => subprocess,
      remux: async () => {}
    })
    emitAll()
    const result = await resultP
    expect(result.title).toBe('ClickHouse — Database OLAP')
    expect(result.filePath).toBe(filePath)
  })

  it('surfaces the real yt-dlp ERROR line and never leaks the command line (G.2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-urldl-'))
    const err = Object.assign(
      new Error(
        'The command spawned as:\n\n  `/abs/path/yt-dlp --newline ...`\n\nexited with: { code: 1 }'
      ),
      { stderr: 'WARNING: something\nERROR: [youtube] xyz: Video unavailable\n' }
    )
    const rejected = Promise.reject(err)
    rejected.catch(() => {}) // mark handled so it isn't an unhandled rejection
    const subprocess: YtDlpSubprocess = {
      pid: 1,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      kill: () => {},
      then: rejected.then.bind(rejected)
    }
    const thrown = (await downloadUrl({
      url: 'https://youtu.be/x',
      outDir: dir,
      ffmpegDir: '/f',
      exec: () => subprocess
    }).catch((e: unknown) => e)) as Error
    expect(thrown.message).toMatch(/Video unavailable/)
    expect(thrown.message).not.toMatch(/command spawned as/i)
  })
})

// ── parseTitle (pure) ───────────────────────────────────────────────────────── //

describe('parseTitle: sentinel-prefixed --print line (%(title)j JSON)', () => {
  it('JSON-decodes the title and ignores path/log lines', () => {
    const stdout = `${TITLE_PRINT_PREFIX}"My Great Video"\n[download] 100%\n/abs/file.mp4\n`
    expect(parseTitle(stdout)).toBe('My Great Video')
  })
  it('keeps a title with embedded special chars on one line (no truncation)', () => {
    // %(title)j escapes a newline as \n → stays a single physical line.
    const stdout = `${TITLE_PRINT_PREFIX}"Pwn\\n/evil/path — & \\"quote\\""\n/abs/file.mp4\n`
    expect(parseTitle(stdout)).toBe('Pwn\n/evil/path — & "quote"')
  })
  it('tolerates a bare (non-JSON) value', () => {
    expect(parseTitle(`${TITLE_PRINT_PREFIX}My Great Video\n`)).toBe('My Great Video')
  })
  it('returns undefined when no title was printed', () => {
    expect(parseTitle('/abs/file.mp4\n')).toBeUndefined()
  })
})

// ── assertSafeUrl (trust boundary) ────────────────────────────────────────────

describe('assertSafeUrl: main-process URL validation (G.2 security)', () => {
  it('accepts http(s) URLs (trimmed)', () => {
    expect(assertSafeUrl('  https://youtu.be/M5XbNdzPuDQ ')).toBe('https://youtu.be/M5XbNdzPuDQ')
    expect(assertSafeUrl('http://example.com/v.mp4')).toBe('http://example.com/v.mp4')
  })
  it('rejects a leading-dash value (argv/flag injection)', () => {
    expect(() => assertSafeUrl('--exec=touch /tmp/pwned')).toThrow(/invalid/i)
    expect(() => assertSafeUrl('-o/tmp/x')).toThrow(/invalid/i)
  })
  it('rejects non-http(s) protocols and garbage', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(/protocol/i)
    expect(() => assertSafeUrl('ftp://x/y')).toThrow(/protocol/i)
    expect(() => assertSafeUrl('not a url')).toThrow(/invalid/i)
    expect(() => assertSafeUrl('')).toThrow(/invalid/i)
  })

  it('rejects with a non-retriable INPUT_INVALID JobError (audit fix openclip-1ly)', () => {
    // An invalid/unsupported URL is PERMANENT — the sidecar must surface it as a
    // non-retriable INPUT_INVALID, not a retriable SIDECAR_CRASH telling the user to
    // retry a doomed operation.
    for (const bad of ['', '-o/x', 'not a url', 'ftp://x/y']) {
      let thrown: unknown
      try {
        assertSafeUrl(bad)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(JobError)
      expect((thrown as JobError).code).toBe('INPUT_INVALID')
      expect((thrown as JobError).retriable).toBe(false)
    }
  })
})

// ── ytdlpErrorMessage (error hygiene) ─────────────────────────────────────────

describe('ytdlpErrorMessage', () => {
  it('prefers the stderr ERROR line, stripped of the ERROR: prefix', () => {
    const err = Object.assign(new Error('The command spawned as: `...`'), {
      stderr: 'WARNING: noise\nERROR: [youtube] abc: Video unavailable\n'
    })
    expect(ytdlpErrorMessage(err)).toBe('[youtube] abc: Video unavailable')
  })
  it('never returns the tinyspawn command-line trace', () => {
    const err = new Error('The command spawned as:\n\n  `/abs/yt-dlp --x`\n\nexited with: code 1')
    const msg = ytdlpErrorMessage(err)
    expect(msg).not.toMatch(/command spawned as/i)
    expect(msg).toBe('yt-dlp failed to download the video')
  })
})

// ── faststartRemux (G.1 — moov atom to the front so <video> loads fast) ───────

describe('faststartRemux', () => {
  it('invokes ffmpeg with -c copy -movflags +faststart and replaces the file on success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-fs-'))
    const fp = join(dir, 'v.mp4')
    writeFileSync(fp, 'ORIGINAL')
    let calledArgs: string[] = []
    await faststartRemux(fp, '/bundle/ffmpeg', {
      run: async (_bin, args) => {
        calledArgs = args
        // simulate ffmpeg writing the faststart output (the tmp path is the last arg)
        writeFileSync(args[args.length - 1], 'FASTSTART')
        return true
      }
    })
    expect(calledArgs).toEqual([
      '-y',
      '-i',
      fp,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      `${fp}.faststart.mp4`
    ])
    expect(readFileSync(fp, 'utf8')).toBe('FASTSTART') // replaced in place
    expect(existsSync(`${fp}.faststart.mp4`)).toBe(false) // tmp renamed away
  })

  it('leaves the original untouched + cleans the tmp when ffmpeg fails (best-effort)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-fs-'))
    const fp = join(dir, 'v.mp4')
    writeFileSync(fp, 'ORIGINAL')
    await faststartRemux(fp, '/bundle/ffmpeg', {
      run: async (_bin, args) => {
        writeFileSync(args[args.length - 1], 'PARTIAL') // a partial output, then failure
        return false
      }
    })
    expect(readFileSync(fp, 'utf8')).toBe('ORIGINAL') // untouched
    expect(existsSync(`${fp}.faststart.mp4`)).toBe(false) // tmp cleaned up
  })

  it('skips entirely (no run) when the signal is already aborted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-fs-'))
    const fp = join(dir, 'v.mp4')
    writeFileSync(fp, 'ORIGINAL')
    const ac = new AbortController()
    ac.abort()
    let ran = false
    await faststartRemux(fp, '/bundle/ffmpeg', {
      signal: ac.signal,
      run: async () => {
        ran = true
        return true
      }
    })
    expect(ran).toBe(false)
    expect(readFileSync(fp, 'utf8')).toBe('ORIGINAL')
  })

  it('tracks the ffmpeg pid via onPid (→ kill-on-quit, PRD §17)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-fs-'))
    const fp = join(dir, 'v.mp4')
    writeFileSync(fp, 'ORIGINAL')
    const pids: number[] = []
    await faststartRemux(fp, '/bundle/ffmpeg', {
      onPid: (p) => pids.push(p),
      run: async (_bin, args, o) => {
        o?.onPid?.(54321)
        writeFileSync(args[args.length - 1], 'FASTSTART')
        return true
      }
    })
    expect(pids).toContain(54321)
  })
})
