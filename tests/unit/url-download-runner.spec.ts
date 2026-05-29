/**
 * tests/unit/url-download-runner.spec.ts — the `url-download` job runner over the
 * REAL SidecarManager + fake-port harness, with the download INJECTED. Proves
 * percent/byte partials stream and the terminal `done` carries
 * `JobResult['url-download']` (filePath/title/bytes) — F.4. Mirrors
 * `model-download-runner.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { SidecarManager, type EventPort } from '@main/services/sidecar-manager'
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
