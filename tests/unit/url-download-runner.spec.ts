/**
 * tests/unit/url-download-runner.spec.ts — the `url-download` job runner over the
 * REAL SidecarManager + fake-port harness, with the download INJECTED. Proves
 * percent/byte partials stream and the terminal `done` carries
 * `JobResult['url-download']` (filePath/title/bytes) — F.4. Mirrors
 * `model-download-runner.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { SidecarManager, type EventPort, type JobEmitter } from '@main/services/sidecar-manager'
import { createUrlDownloadRunner } from '@main/services/jobs/url-download-runner'
import { jobEvents, type MessagePortLike } from '@renderer/hooks/useJob'
import type { JobEventFor } from '@shared/jobs'

describe('url-download-runner: streams progress/byte partials then a contract-valid done', () => {
  it('emits url-download partials and a terminal done with filePath/title/bytes', async () => {
    const runner = createUrlDownloadRunner({
      // Avoid touching the filesystem: supply outDir so defaultResolveOutDir
      // (which mkdirs a temp dir) is bypassed entirely.
      resolveOutDir: () => '/tmp/openclip/downloads/test',
      downloadUrl: async (o) => {
        expect(o.url).toBe('https://youtu.be/M5XbNdzPuDQ')
        expect(o.outDir).toBe('/tmp/openclip/downloads/test')
        o.onPid?.(7777)
        o.onProgress?.({ downloadedBytes: 5_000_000, totalBytes: 50_000_000, pct: 10 })
        o.onProgress?.({ downloadedBytes: 50_000_000, totalBytes: 50_000_000, pct: 100 })
        return { filePath: `${o.outDir}/M5XbNdzPuDQ.mp4`, title: 'Sample', bytes: 50_000_000 }
      }
    })

    const { registerRunner, getRunner } = await import('@main/services/sidecar-manager')
    if (!getRunner('url-download')) registerRunner('url-download', runner)

    const mgr = new SidecarManager()
    const { port1, port2 } = new MessageChannel()
    port1.start()
    const ePort: EventPort = {
      postMessage: (v) => port2.postMessage(v),
      close: () => port2.close(),
      on: (ev, l) => port2.on(ev, l as () => void),
      start: () => port2.start()
    }
    mgr.startJob('url-download', { url: 'https://youtu.be/M5XbNdzPuDQ' }, ePort)

    const seen: string[] = []
    let done: JobEventFor<'url-download'> | null = null
    let lastPartial: { downloadedBytes: number; totalBytes: number; pct: number } | null = null
    for await (const ev of jobEvents<'url-download'>(port1 as unknown as MessagePortLike)) {
      seen.push(ev.t)
      if (ev.t === 'partial') lastPartial = ev.data
      if (ev.t === 'done') done = ev
    }

    expect(seen).toContain('partial')
    expect(seen[seen.length - 1]).toBe('done')
    expect(lastPartial).toEqual({ downloadedBytes: 50_000_000, totalBytes: 50_000_000, pct: 100 })
    expect(done?.t).toBe('done')
    if (done?.t === 'done') {
      expect(done.result.filePath).toMatch(/M5XbNdzPuDQ\.mp4$/)
      expect(done.result.title).toBe('Sample')
      expect(done.result.bytes).toBe(50_000_000)
    }
  })
})

// Direct-invocation tests of the runner factory — assert the SAFETY-RELEVANT
// wiring the SidecarManager-level test can't see: server-side outDir derivation
// (G.2 trust boundary), pid tracking (PRD §17 kill-on-quit), progress emission,
// and that a download rejection is NOT swallowed.
describe('createUrlDownloadRunner: wiring + failure', () => {
  function fakeEmit(): {
    emit: JobEmitter<'url-download'>
    events: Array<{ t: string; pct?: number }>
  } {
    const events: Array<{ t: string; pct?: number }> = []
    return {
      events,
      emit: {
        progress: (pct: number) => events.push({ t: 'progress', pct }),
        partial: () => events.push({ t: 'partial' }),
        done: () => events.push({ t: 'done' }),
        error: () => events.push({ t: 'error' })
      }
    }
  }

  it('derives outDir from jobId (ignoring any renderer-supplied outDir), tracks the pid + signal, emits progress', async () => {
    const tracked: number[] = []
    let resolveArg = ''
    let sawSignal: AbortSignal | undefined
    const runner = createUrlDownloadRunner({
      resolveOutDir: (jobId) => {
        resolveArg = jobId
        return `/tmp/oc/downloads/${jobId}`
      },
      downloadUrl: async (o) => {
        sawSignal = o.signal
        // The renderer outDir must NOT reach the download — server-derived only.
        expect(o.outDir).toBe('/tmp/oc/downloads/JOB1')
        o.onPid?.(7777)
        o.onProgress?.({ downloadedBytes: 1, totalBytes: 2, pct: 50 })
        return { filePath: `${o.outDir}/v.mp4`, bytes: 10 }
      }
    })
    const { emit, events } = fakeEmit()
    const ctx = {
      jobId: 'JOB1',
      signal: new AbortController().signal,
      trackPid: (p: number) => tracked.push(p)
    }
    // Cast: a (malicious) renderer outDir is not in the type, but prove it's ignored.
    const params = { url: 'https://youtu.be/x', outDir: '/evil/autostart' } as unknown as {
      url: string
    }
    const result = await runner(params, emit, ctx)

    expect(resolveArg).toBe('JOB1')
    expect(tracked).toContain(7777)
    expect(sawSignal).toBeInstanceOf(AbortSignal)
    expect(events.some((e) => e.t === 'progress' && e.pct === 50)).toBe(true)
    expect(result.filePath).toMatch(/\/tmp\/oc\/downloads\/JOB1\/v\.mp4$/)
  })

  it('propagates a download rejection (no swallow → maps to a terminal error)', async () => {
    const runner = createUrlDownloadRunner({
      resolveOutDir: () => '/tmp/oc/x',
      downloadUrl: async () => {
        throw new Error('yt-dlp failed: Video unavailable')
      }
    })
    const { emit } = fakeEmit()
    const ctx = {
      jobId: 'J',
      signal: new AbortController().signal,
      trackPid: () => {}
    }
    await expect(runner({ url: 'https://youtu.be/x' }, emit, ctx)).rejects.toThrow(
      /Video unavailable/
    )
  })
})
