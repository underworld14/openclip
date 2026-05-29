/**
 * tests/unit/model-download-runner.spec.ts — the `model-download` job runner over
 * the REAL SidecarManager + fake-port harness, with the download INJECTED. Proves
 * byte-progress partials stream and the terminal `done` carries
 * `JobResult['model-download']` (model/path/bytes) — PRD §13 / §10.2.
 */

import { describe, expect, it } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { SidecarManager, type EventPort } from '@main/services/sidecar-manager'
import { createModelDownloadRunner } from '@main/services/jobs/model-download-runner'
import { jobEvents, type MessagePortLike } from '@renderer/hooks/useJob'
import type { JobEventFor } from '@shared/jobs'

describe('model-download-runner: streams byte progress then a contract-valid done', () => {
  it('emits model-download partials and a terminal done with model/path/bytes', async () => {
    const runner = createModelDownloadRunner({
      downloadModel: async (o) => {
        o.onProgress?.(25_000_000, 77_000_000)
        o.onProgress?.(77_000_000, 77_000_000)
        return { model: o.model, path: `/models/ggml-${o.model}.bin`, bytes: 77_000_000 }
      }
    })
    const { registerRunner, getRunner } = await import('@main/services/sidecar-manager')
    if (!getRunner('model-download')) registerRunner('model-download', runner)

    const mgr = new SidecarManager()
    const { port1, port2 } = new MessageChannel()
    port1.start()
    const ePort: EventPort = {
      postMessage: (v) => port2.postMessage(v),
      close: () => port2.close(),
      on: (ev, l) => port2.on(ev, l as () => void),
      start: () => port2.start()
    }
    mgr.startJob('model-download', { model: 'tiny' }, ePort)

    const seen: string[] = []
    let done: JobEventFor<'model-download'> | null = null
    let lastPartial: { receivedBytes: number; totalBytes: number } | null = null
    for await (const ev of jobEvents<'model-download'>(port1 as unknown as MessagePortLike)) {
      seen.push(ev.t)
      if (ev.t === 'partial') lastPartial = ev.data
      if (ev.t === 'done') done = ev
    }

    expect(seen).toContain('partial')
    expect(seen[seen.length - 1]).toBe('done')
    expect(lastPartial).toEqual({ receivedBytes: 77_000_000, totalBytes: 77_000_000 })
    expect(done?.t).toBe('done')
    if (done?.t === 'done') {
      expect(done.result.model).toBe('tiny')
      expect(done.result.path).toMatch(/ggml-tiny\.bin$/)
      expect(done.result.bytes).toBe(77_000_000)
    }
  })
})
