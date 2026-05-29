/**
 * tests/unit/model-download-dialog.spec.ts — ModelDownloadDialog presentation +
 * the pure download orchestration. The model table (size/speed/accuracy, PRD
 * §13/§6.2) is a pure const; `runModelDownload` drives a `model-download` job
 * over the mock bridge's port to completion (byte progress → done). The DOM
 * render is asserted for the closed state (server snapshot) + the model table.
 */

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelDownloadDialog } from '@renderer/components/ModelDownloadDialog'
import { WHISPER_MODEL_TABLE, runModelDownload } from '@renderer/components/model-download'
import { createMockOpenclip } from '../mocks/openclip'

describe('ModelDownloadDialog: model table (PRD §13/§6.2)', () => {
  it('offers every contract model size with size + speed metadata', () => {
    const sizes = WHISPER_MODEL_TABLE.map((m) => m.model)
    expect(sizes).toEqual(['tiny', 'base', 'small', 'medium', 'turbo', 'large-v3'])
    for (const row of WHISPER_MODEL_TABLE) {
      expect(row.sizeLabel).toMatch(/MB|GB/)
      expect(row.speed.length).toBeGreaterThan(0)
      expect(row.accuracy.length).toBeGreaterThan(0)
    }
  })
  it('defaults to base (the MVP default)', () => {
    expect(WHISPER_MODEL_TABLE.find((m) => m.default)?.model).toBe('base')
  })
})

describe('ModelDownloadDialog: closed-state render', () => {
  it('renders nothing when open is false', () => {
    expect(renderToStaticMarkup(createElement(ModelDownloadDialog, { open: false }))).toBe('')
  })
})

describe('runModelDownload: byte-progress over a job port → done', () => {
  it('streams receivedBytes/totalBytes and resolves with the model path', async () => {
    const openclip = createMockOpenclip()
    const progresses: Array<{ received: number; total: number }> = []
    const res = await runModelDownload({
      bridge: openclip,
      model: 'base',
      onProgress: (received, total) => progresses.push({ received, total })
    })
    expect(progresses.length).toBeGreaterThan(0)
    expect(res.model).toBe('base')
    expect(res.path).toMatch(/ggml-base\.bin$/)
    expect(res.bytes).toBeGreaterThan(0)
  })

  it('throws on a terminal error job event', async () => {
    const openclip = createMockOpenclip({
      scripts: {
        'model-download': {
          steps: [{ t: 'error', code: 'TIMEOUT', message: 'network timeout', retriable: true }]
        }
      }
    })
    await expect(runModelDownload({ bridge: openclip, model: 'base' })).rejects.toThrow(
      /timeout|TIMEOUT/i
    )
  })
})
