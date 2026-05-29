/**
 * tests/unit/export-run.spec.ts — the renderer-side export orchestration
 * (EXPORT spine, plan E.5). Mirrors model-download.spec: drives the FULL export
 * UX over the mock bridge + the fake-port harness (the PROVEN streaming-job port
 * path) without React or a real binary:
 *
 *   save dialog → jobs.start('export') → acquireJobPort → jobEvents → done
 *
 * Plus the ExportPanel empty-state markup smoke (vitest env is `node`, so DOM
 * interaction is covered by the pure orchestration above; the live reactive
 * flow is proven in real Chromium by the export E2E).
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMockOpenclip } from '../mocks/openclip'
import { __resetJobPortRegistry } from '@renderer/hooks/jobPort'
import {
  runExport,
  exportToFile,
  openExportFolder,
  defaultClipFileName
} from '@renderer/components/export-run'
import { ExportPanel } from '@renderer/components/ExportPanel'
import type { JobParams } from '@shared/jobs'

const params: JobParams['export'] = {
  projectId: 'p1',
  clipId: 'clip-1',
  sourcePath: '/src/in.mp4',
  startTime: 12,
  endTime: 40,
  aspectRatio: '9:16',
  outputPath: '/Users/me/Movies/clip-1.mp4',
  quality: '1080p'
}

describe('defaultClipFileName', () => {
  it('slugifies a clip title into a safe .mp4 name', () => {
    expect(defaultClipFileName('The Wildest Take!!')).toBe('the-wildest-take.mp4')
    expect(defaultClipFileName('   ')).toBe('clip.mp4')
    expect(defaultClipFileName('a'.repeat(100))).toMatch(/^a{60}\.mp4$/)
  })
})

describe('runExport (over the mock bridge + fake port)', () => {
  beforeEach(() => __resetJobPortRegistry())

  it('streams progress then resolves with the export result (done)', async () => {
    const bridge = createMockOpenclip()
    const pcts: number[] = []
    const result = await runExport({ bridge, params, onProgress: (p) => pcts.push(p) })

    // DEFAULT_SCRIPTS.export ends in a 1080x1920 done.
    expect(result).toMatchObject({ width: 1080, height: 1920 })
    expect(result.outputPath).toBeTruthy()
    expect(pcts.length).toBeGreaterThan(0)
  })

  it('throws on a terminal error event (job-termination invariant)', async () => {
    const bridge = createMockOpenclip({
      scripts: {
        export: {
          steps: [{ t: 'error', code: 'SIDECAR_CRASH', message: 'ffmpeg died', retriable: true }]
        }
      }
    })
    await expect(runExport({ bridge, params })).rejects.toThrow(/export failed.*ffmpeg died/)
  })
})

describe('exportToFile (save dialog → export job)', () => {
  beforeEach(() => __resetJobPortRegistry())

  it('runs the export when the user picks a path', async () => {
    const bridge = createMockOpenclip()
    const outcome = await exportToFile({
      bridge,
      defaultFileName: 'clip.mp4',
      buildParams: (chosen) => ({ ...params, outputPath: chosen }),
      onProgress: () => {}
    })
    expect(outcome.canceled).toBe(false)
    if (!outcome.canceled) {
      expect(outcome.outputPath).toBe('/Users/me/Movies/clip-1.mp4') // mock saveDialog filePath
      expect(outcome.result.width).toBe(1080)
    }
  })

  it('returns {canceled:true} and starts no job when the dialog is dismissed', async () => {
    const bridge = createMockOpenclip()
    // Override saveDialog to report cancellation.
    bridge.system.saveDialog = async () => ({ canceled: true })
    let built = false
    const outcome = await exportToFile({
      bridge,
      defaultFileName: 'clip.mp4',
      buildParams: (chosen) => {
        built = true
        return { ...params, outputPath: chosen }
      }
    })
    expect(outcome).toEqual({ canceled: true })
    expect(built).toBe(false) // no params built ⇒ no job started
  })
})

describe('openExportFolder', () => {
  it('reveals the output path via system.openFolder', async () => {
    const bridge = createMockOpenclip()
    let opened: { path: string } | null = null
    bridge.system.openFolder = async (req) => {
      opened = req as { path: string }
    }
    await openExportFolder(bridge, '/Users/me/Movies/clip-1.mp4')
    expect(opened).toEqual({ path: '/Users/me/Movies/clip-1.mp4' })
  })
})

describe('ExportPanel: empty state (initial store snapshot)', () => {
  it('renders the panel test id and a no-clip prompt with no clips', () => {
    const html = renderToStaticMarkup(createElement(ExportPanel))
    expect(html).toContain('data-testid="export-panel"')
    expect(html.toLowerCase()).toMatch(/no clip|generate or pick/)
  })
})
