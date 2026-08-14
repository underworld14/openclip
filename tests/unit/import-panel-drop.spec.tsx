// @vitest-environment jsdom
/**
 * tests/unit/import-panel-drop.spec.tsx — ImportPanel's drag-and-drop handler
 * (FEAT-26tkya, test #4 in the ticket's value order).
 *
 * "Drop a video file" is the first acceptance criterion of PRD §6.1 and the copy
 * the Welcome screen has always shown, but the handler had no coverage of any
 * kind: it is pure DOM event wiring, so it was unreachable from a `node`-env
 * suite and never touched by an E2E (which all call `runImportPipeline` rather
 * than dispatching a real drop).
 *
 * The behaviours that matter are the three the handler special-cases: a normal
 * video path, an item with no path on disk (Electron removed `File.path`, so a
 * dragged bookmark/URL yields nothing from `webUtils.getPathForFile`), and a
 * drop that arrives while an import is already running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import type { OpenClipBridge } from '@preload/index'
import type { ModelStatus } from '@shared/channels'
import type { WhisperModelSize } from '@shared/jobs'
import { installRendererEnv } from '../harness/renderer-env'
import { ImportPanel } from '@renderer/components/ImportPanel'

let bridge: OpenClipBridge

/** Build a DataTransfer-ish payload jsdom will hand to the drop handler. */
function dropWith(name: string): { dataTransfer: unknown } {
  const file = new File(['x'], name, { type: 'video/mp4' })
  return { dataTransfer: { files: [file], types: ['Files'] } }
}

/** Make `getPathForFile` return a chosen absolute path (or '' for "no path"). */
function pathIs(b: OpenClipBridge, path: string): void {
  b.files.getPathForFile = vi.fn(() => path)
}

beforeEach(() => {
  bridge = installRendererEnv()
  // Hold the model probe open so an import stays observably in-flight.
  bridge.model.status = vi.fn(
    async (req: { model?: WhisperModelSize }): Promise<ModelStatus[]> => [
      { model: req.model ?? 'base', installed: true, path: '/m.bin', bytes: 1 }
    ]
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ImportPanel: drop with a real video path', () => {
  it('starts an import for the dropped file and shows no warning', async () => {
    pathIs(bridge, '/Users/me/Movies/talk.mp4')
    const importVideo = vi.fn(bridge.video.import)
    bridge.video.import = importVideo

    render(<ImportPanel />)
    await act(async () => {
      fireEvent.drop(screen.getByTestId('import-panel'), dropWith('talk.mp4'))
    })

    await waitFor(() => expect(importVideo).toHaveBeenCalledTimes(1))
    expect(importVideo.mock.calls[0][0]).toMatchObject({ filePath: '/Users/me/Movies/talk.mp4' })
    expect(screen.queryByTestId('import-drop-warning')).toBeNull()
  })
})

describe('ImportPanel: drop with nothing on disk', () => {
  it('explains the problem and does NOT start an import', async () => {
    pathIs(bridge, '')
    const importVideo = vi.fn(bridge.video.import)
    bridge.video.import = importVideo

    render(<ImportPanel />)
    await act(async () => {
      fireEvent.drop(screen.getByTestId('import-panel'), dropWith('bookmark.webloc'))
    })

    expect(screen.getByTestId('import-drop-warning').textContent).toMatch(/no file on disk/i)
    expect(importVideo).not.toHaveBeenCalled()
  })
})

describe('ImportPanel: drop of a non-video extension', () => {
  it('warns but still imports — ffprobe is the real authority on what decodes', async () => {
    pathIs(bridge, '/Users/me/Documents/notes.pdf')
    const importVideo = vi.fn(bridge.video.import)
    bridge.video.import = importVideo

    render(<ImportPanel />)
    await act(async () => {
      fireEvent.drop(screen.getByTestId('import-panel'), dropWith('notes.pdf'))
    })

    expect(screen.getByTestId('import-drop-warning').textContent).toMatch(
      /doesn't look like a video/i
    )
    await waitFor(() => expect(importVideo).toHaveBeenCalledTimes(1))
  })
})

describe('ImportPanel: drop while an import is already running', () => {
  it('is ignored rather than starting a second, competing import', async () => {
    pathIs(bridge, '/Users/me/Movies/first.mp4')
    // Keep the first import in flight for the duration of the test.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const importVideo = vi.fn(async () => {
      await gate
      return { sourceVideo: undefined as never }
    })
    bridge.video.import = importVideo as unknown as OpenClipBridge['video']['import']

    render(<ImportPanel />)
    await act(async () => {
      fireEvent.drop(screen.getByTestId('import-panel'), dropWith('first.mp4'))
    })
    await waitFor(() => expect(screen.getByTestId('import-progress')).toBeTruthy())

    pathIs(bridge, '/Users/me/Movies/second.mp4')
    await act(async () => {
      fireEvent.drop(screen.getByTestId('import-panel'), dropWith('second.mp4'))
    })

    expect(importVideo).toHaveBeenCalledTimes(1)
    await act(async () => {
      release()
      await gate
    })
  })
})
