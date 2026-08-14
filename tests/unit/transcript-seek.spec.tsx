// @vitest-environment jsdom
/**
 * tests/unit/transcript-seek.spec.tsx — the transcript is navigable, and can be
 * downloaded (FEAT-vwvgs0).
 *
 * The rows were plain `<li>`s with a timestamp span and a text span — no
 * `onClick`, no `role`, no keyboard affordance. The transcript was a wall of
 * text you could read and nothing else, while every competitor treats it as the
 * primary way to move around the video.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { OpenClipBridge } from '@preload/index'
import { installRendererEnv } from '../harness/renderer-env'
import { useProjectStore } from '@renderer/stores/projectStore'
import { TranscriptPanel } from '@renderer/components/TranscriptPanel'
import type { Transcript } from '@shared/schema'

const TRANSCRIPT: Transcript = {
  language: 'en',
  segments: [
    { id: 's0', start: 0, end: 2.5, text: 'Hello world!', confidence: 0.9 },
    { id: 's1', start: 2.5, end: 5, text: 'Second line.', confidence: 0.9 }
  ],
  words: []
}

let bridge: OpenClipBridge

beforeEach(() => {
  bridge = installRendererEnv()
  useProjectStore.setState({ transcript: TRANSCRIPT, transcriptSearch: '', playhead: 0 })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TranscriptPanel: click to seek', () => {
  it('renders each row as a real button, not an inert list item', () => {
    render(<TranscriptPanel />)
    const rows = screen.getAllByTestId('transcript-seek')
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.tagName).toBe('BUTTON')
  })

  it('moves the playhead to the segment start', async () => {
    render(<TranscriptPanel />)
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('transcript-seek')[1])
    })
    expect(useProjectStore.getState().playhead).toBe(2.5)
  })

  it('marks the row the playhead is inside with aria-current', () => {
    useProjectStore.setState({ playhead: 3 })
    render(<TranscriptPanel />)
    const rows = screen.getAllByTestId('transcript-seek')
    expect(rows[0].getAttribute('aria-current')).toBeNull()
    expect(rows[1].getAttribute('aria-current')).toBe('true')
  })

  it('treats the segment end as exclusive, so exactly one row is current', () => {
    // At t=2.5 the first segment has ended and the second has begun. Marking both
    // would announce two "current" positions to a screen reader.
    useProjectStore.setState({ playhead: 2.5 })
    render(<TranscriptPanel />)
    const current = screen
      .getAllByTestId('transcript-seek')
      .filter((r) => r.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
  })
})

describe('TranscriptPanel: download', () => {
  it('offers all three formats', () => {
    render(<TranscriptPanel />)
    for (const f of ['srt', 'vtt', 'txt']) {
      expect(screen.getByTestId(`transcript-download-${f}`)).toBeTruthy()
    }
  })

  it('sends the transcript and the chosen format to main', async () => {
    const exportTranscript = vi.fn(async (req: { format: string; outputPath: string }) => {
      void req
      return { path: '/out/t.srt' }
    })
    bridge.project.exportTranscript = exportTranscript as never
    bridge.system.saveDialog = vi.fn(async () => ({ canceled: false, filePath: '/out/t.srt' }))

    render(<TranscriptPanel />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('transcript-download-srt'))
    })

    await waitFor(() => expect(exportTranscript).toHaveBeenCalledTimes(1))
    const req = exportTranscript.mock.calls[0][0]
    expect(req.format).toBe('srt')
    expect(req.outputPath).toBe('/out/t.srt')
  })

  it('writes nothing when the save dialog is dismissed', async () => {
    const exportTranscript = vi.fn(async (req: { format: string; outputPath: string }) => {
      void req
      return { path: '' }
    })
    bridge.project.exportTranscript = exportTranscript as never
    bridge.system.saveDialog = vi.fn(async () => ({ canceled: true }))

    render(<TranscriptPanel />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('transcript-download-vtt'))
    })
    expect(exportTranscript).not.toHaveBeenCalled()
  })
})
