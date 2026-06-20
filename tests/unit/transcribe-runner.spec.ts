/**
 * tests/unit/transcribe-runner.spec.ts — the `transcribe` job runner, driven by
 * the REAL SidecarManager over the fake-port harness, with whisper INJECTED (no
 * real binary). Proves: progress + per-word/segment partials stream, the
 * terminal `done` carries the frozen `JobResult['transcribe']` shape, and the
 * job-termination invariant holds (PRD §6.2 / §10.2).
 */

import { describe, expect, it } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarManager, type EventPort } from '@main/services/sidecar-manager'
import { createTranscribeRunner } from '@main/services/jobs/transcribe-runner'
import { jobEvents, type MessagePortLike } from '@renderer/hooks/useJob'
import { transcriptFixture } from '../fixtures/contract'
import type { JobEventFor } from '@shared/jobs'
import type { ParsedTranscript } from '@main/services/whisper-parse'

/** A fake whisper run that streams two words then resolves a parsed transcript. */
function fakeWhisper(): ReturnType<typeof createTranscribeRunner> {
  return createTranscribeRunner({
    resolveModelPath: () => '/models/ggml-base.bin',
    isModelInstalled: () => true,
    runWhisper: async (o) => {
      o.onProgress?.(20)
      o.onWord?.({ word: 'Hello', start: 0.05, end: 0.47, confidence: 0 })
      o.onProgress?.(60)
      o.onWord?.({ word: 'world.', start: 0.47, end: 1.24, confidence: 0 })
      o.onProgress?.(100)
      const parsed: ParsedTranscript = {
        language: 'en',
        words: transcriptFixture.words,
        segments: transcriptFixture.segments
      }
      return parsed
    }
  })
}

function eventPortFor(mgr: SidecarManager): { port: EventPort; consume: MessagePortLike } {
  const { port1, port2 } = new MessageChannel()
  port1.start()
  const port: EventPort = {
    postMessage: (v) => port2.postMessage(v),
    close: () => port2.close(),
    on: (ev, l) => port2.on(ev, l as () => void),
    start: () => port2.start()
  }
  void mgr
  return { port, consume: port1 as unknown as MessagePortLike }
}

describe('transcribe-runner: streams words/segments then a contract-valid done', () => {
  it('emits progress + partials and a terminal done with language/segments/words', async () => {
    const mgr = new SidecarManager()
    const runner = fakeWhisper()
    // register via the public seam
    const { registerRunner, getRunner } = await import('@main/services/sidecar-manager')
    if (!getRunner('transcribe')) registerRunner('transcribe', runner)

    const { port, consume } = eventPortFor(mgr)
    mgr.startJob('transcribe', { projectId: 'p1', wavPath: '/tmp/a.wav', model: 'base' }, port)

    const seen: string[] = []
    let done: JobEventFor<'transcribe'> | null = null
    let partialWords = 0
    for await (const ev of jobEvents<'transcribe'>(consume)) {
      seen.push(ev.t)
      if (ev.t === 'partial') partialWords += ev.data.words.length
      if (ev.t === 'done') done = ev
    }

    expect(seen).toContain('progress')
    expect(seen).toContain('partial')
    expect(seen[seen.length - 1]).toBe('done')
    expect(partialWords).toBeGreaterThan(0)
    expect(done).not.toBeNull()
    expect(done!.t).toBe('done')
    if (done!.t === 'done') {
      expect(done!.result.language).toBe('en')
      expect(done!.result.segments.length).toBeGreaterThan(0)
      expect(done!.result.words.length).toBeGreaterThan(0)
    }
  })
})

describe('transcribe-runner: missing model surfaces a typed input error', () => {
  it('throws when the model is not installed (no silent hang)', async () => {
    const runner = createTranscribeRunner({
      resolveModelPath: () => '/models/ggml-base.bin',
      isModelInstalled: () => false,
      runWhisper: async () => {
        throw new Error('should not be called')
      }
    })
    const emit = {
      progress: () => {},
      partial: () => {},
      done: () => {},
      error: () => {}
    }
    await expect(
      runner({ projectId: 'p1', wavPath: '/tmp/a.wav', model: 'base' }, emit, {
        signal: new AbortController().signal,
        trackPid: () => {},
        jobId: 'j1'
      })
    ).rejects.toThrow(/model.*not installed|not installed/i)
  })
})

describe('transcribe-runner: reclaims its <base>.json scratch (audit fix openclip-5ji/qgr)', () => {
  const ctx = { signal: new AbortController().signal, trackPid: () => {}, jobId: 'jX' }
  const emit = { progress: () => {}, partial: () => {}, done: () => {}, error: () => {} }

  it('removes the whisper <outBase>.json after a successful run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-transcribe-'))
    let writtenJson = ''
    const runner = createTranscribeRunner({
      resolveModelPath: () => '/m.bin',
      isModelInstalled: () => true,
      runWhisper: async (o) => {
        writtenJson = `${o.outBase}.json`
        writeFileSync(writtenJson, '{}')
        return {
          language: 'en',
          words: transcriptFixture.words,
          segments: transcriptFixture.segments
        }
      }
    })
    try {
      await runner(
        { projectId: 'p1', wavPath: join(dir, 'audio.16k.wav'), model: 'base' },
        emit,
        ctx
      )
      expect(writtenJson).not.toBe('')
      expect(existsSync(writtenJson)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes the <outBase>.json even when whisper throws (no leaked scratch)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-transcribe-'))
    let writtenJson = ''
    const runner = createTranscribeRunner({
      resolveModelPath: () => '/m.bin',
      isModelInstalled: () => true,
      runWhisper: async (o) => {
        writtenJson = `${o.outBase}.json`
        writeFileSync(writtenJson, '{}')
        throw new Error('whisper boom')
      }
    })
    try {
      await expect(
        runner({ projectId: 'p1', wavPath: join(dir, 'audio.16k.wav'), model: 'base' }, emit, ctx)
      ).rejects.toThrow(/boom/)
      expect(existsSync(writtenJson)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('transcribe-runner: requested language is authoritative (Part I cross-language)', () => {
  const ctx = { signal: new AbortController().signal, trackPid: () => {}, jobId: 'j1' }
  const emit = { progress: () => {}, partial: () => {}, done: () => {}, error: () => {} }

  it('passes the requested language to whisper (-l) and uses it over the detected label', async () => {
    let passedLang: string | undefined = 'UNSET'
    const runner = createTranscribeRunner({
      resolveModelPath: () => '/m.bin',
      isModelInstalled: () => true,
      runWhisper: async (o) => {
        passedLang = o.language
        return {
          language: 'en', // whisper guessed wrong / reported English
          words: transcriptFixture.words,
          segments: transcriptFixture.segments
        }
      }
    })
    const result = await runner(
      { projectId: 'p1', wavPath: '/a.wav', model: 'base', language: 'id' },
      emit,
      ctx
    )
    expect(passedLang).toBe('id') // `-l id` reached whisper
    expect(result.language).toBe('id') // the requested language wins over 'en'
  })

  it('falls back to the detected language when none was requested (auto-detect)', async () => {
    const runner = createTranscribeRunner({
      resolveModelPath: () => '/m.bin',
      isModelInstalled: () => true,
      runWhisper: async () => ({
        language: 'fr',
        words: transcriptFixture.words,
        segments: transcriptFixture.segments
      })
    })
    const result = await runner({ projectId: 'p1', wavPath: '/a.wav', model: 'base' }, emit, ctx)
    expect(result.language).toBe('fr')
  })
})
