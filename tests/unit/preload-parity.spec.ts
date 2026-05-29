/**
 * tests/unit/preload-parity.spec.ts — plan E.7 drift detection #5:
 * the REAL preload bridge and the MOCK expose IDENTICAL method sets (both typed
 * as the derived `OpenClipBridge`, so they can't silently diverge).
 *
 * To instantiate the real bridge in a Node test we mock `electron` (the preload
 * api builders only need `ipcRenderer`/`contextBridge` to exist). We then build
 * the real `openclip` exactly as the preload would and compare its per-namespace
 * method keys against `createMockOpenclip()`.
 */

import { describe, expect, it, vi, beforeAll } from 'vitest'

// Mock electron BEFORE importing anything that pulls it in.
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn(async () => undefined),
    postMessage: vi.fn(),
    on: vi.fn(),
    send: vi.fn()
  },
  contextBridge: { exposeInMainWorld: vi.fn() }
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

import { createMockOpenclip } from '../mocks/openclip'
import type { OpenClipBridge } from '@preload/index'

const NAMESPACES: Array<keyof OpenClipBridge> = [
  'video',
  'audio',
  'ai',
  'project',
  'settings',
  'model',
  'system'
]

// The real bridge, assembled from the per-domain builders (no contextBridge side
// effects matter — they're mocked).
let realBridge: OpenClipBridge

beforeAll(async () => {
  const { buildVideoApi } = await import('@preload/api/video')
  const { buildAudioApi } = await import('@preload/api/audio')
  const { buildAiApi } = await import('@preload/api/ai')
  const { buildProjectApi } = await import('@preload/api/project')
  const { buildSettingsApi } = await import('@preload/api/settings')
  const { buildModelApi } = await import('@preload/api/model')
  const { buildSystemApi } = await import('@preload/api/system')
  const { buildJobsApi } = await import('@preload/api/jobs')
  realBridge = {
    video: buildVideoApi(),
    audio: buildAudioApi(),
    ai: buildAiApi(),
    project: buildProjectApi(),
    settings: buildSettingsApi(),
    model: buildModelApi(),
    system: buildSystemApi(),
    jobs: buildJobsApi()
  }
})

function methodKeys(ns: Record<string, unknown>): string[] {
  return Object.keys(ns).sort()
}

describe('preload parity: real bridge method-set === mock method-set', () => {
  it('exposes the same top-level namespaces', () => {
    const mock = createMockOpenclip()
    expect(Object.keys(realBridge).sort()).toEqual(Object.keys(mock).sort())
  })

  it.each(NAMESPACES)('namespace "%s" has identical method names', (ns) => {
    const mock = createMockOpenclip()
    const realNs = realBridge[ns] as Record<string, unknown>
    const mockNs = mock[ns] as Record<string, unknown>
    expect(methodKeys(mockNs)).toEqual(methodKeys(realNs))
  })

  it('derives the expected camelCased method names (spot-check)', () => {
    expect(methodKeys(realBridge.video)).toEqual(['export', 'import'])
    expect(methodKeys(realBridge.audio)).toEqual(['extract'])
    expect(methodKeys(realBridge.ai)).toEqual([
      'enhanceCaptions',
      'generateClips',
      'generateTitles'
    ])
    expect(methodKeys(realBridge.settings)).toEqual(['apiKeyStatus', 'get', 'set', 'setApiKey'])
    expect(methodKeys(realBridge.model)).toEqual(['download', 'status'])
    expect(methodKeys(realBridge.system)).toEqual([
      'checkUpdate',
      'openDialog',
      'openFolder',
      'saveDialog'
    ])
  })

  it('both bridges expose a jobs API with start + cancel', () => {
    const mock = createMockOpenclip()
    expect(typeof realBridge.jobs.start).toBe('function')
    expect(typeof realBridge.jobs.cancel).toBe('function')
    expect(typeof mock.jobs.start).toBe('function')
    expect(typeof mock.jobs.cancel).toBe('function')
  })
})
