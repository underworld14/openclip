// @vitest-environment jsdom
/**
 * tests/unit/project-management.spec.tsx — projects can be managed, and a failed
 * load says so (FEAT-905vk4).
 *
 * Every project row was an open-only button. `projectActions.remove` existed with
 * ZERO callers, and there was no rename, duplicate or reveal anywhere: a project
 * could be created and opened, never managed. Worse, both the Dashboard and the
 * Welcome screen called `void open(row.id)` — DISCARDING the promise — so a
 * project whose file had moved or gone corrupt produced no spinner, no toast and
 * no error. It simply did nothing, forever, with no way to find out why.
 *
 * The swallowed rejection is the one that mattered most, and it is the first
 * thing asserted here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { installRendererEnv } from '../harness/renderer-env'
import { useProjectStore } from '@renderer/stores/projectStore'
import { projectActions } from '@renderer/hooks/useProject'
import { Dashboard } from '@renderer/components/Dashboard'
import { createMockOpenclip } from '../mocks/openclip'
import { projectFixture } from '../fixtures/contract'
import type { Project } from '@shared/schema'

const META = [
  { id: 'p1', name: 'First Project', updatedAt: Date.now() - 1000, path: '/proj/p1.ocproj' },
  { id: 'p2', name: 'Second Project', updatedAt: Date.now() - 5000, path: '/proj/p2.ocproj' }
]

beforeEach(() => {
  installRendererEnv()
  // Seed the BRIDGE, not just the store: `useProject` refreshes recents from
  // `project:list` on mount, which would otherwise replace a seeded store list
  // with the mock's own — and the rows under test would be the wrong projects.
  window.openclip.project.list = async () => META
  useProjectStore.setState({ currentProject: null, recentProjects: META })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * Open a row's `⋯` menu.
 *
 * `user-event`, not `fireEvent`: Radix triggers listen for the full pointer
 * sequence and a synthetic `click` alone does not open them.
 */
async function openMenu(projectId: string): Promise<void> {
  const trigger = screen
    .getAllByTestId('project-menu')
    .find((t) => t.getAttribute('data-project-id') === projectId)!
  await userEvent.click(trigger)
}

describe('a failed load is REPORTED, not discarded', () => {
  it('toasts when opening a project rejects', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '' as never)
    // The exact failure the ticket describes: the `.ocproj` has moved.
    window.openclip.project.load = async () => {
      throw new Error('ENOENT: no such file')
    }
    render(<Dashboard />)
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('project-open')[0])
    })
    await waitFor(() => expect(error).toHaveBeenCalled())
    expect(error.mock.calls[0][0]).toMatch(/could not open/i)
    expect(String((error.mock.calls[0][1] as { description?: string })?.description)).toContain(
      'ENOENT'
    )
  })

  it('shows a busy state while the load is in flight', async () => {
    // A click used to give NO sign of life at all.
    let release: (p: Project) => void = () => {}
    window.openclip.project.load = () =>
      new Promise<Project>((res) => {
        release = res
      })
    render(<Dashboard />)
    const row = screen.getAllByTestId('project-open')[0]
    await act(async () => {
      fireEvent.click(row)
    })
    expect(screen.getAllByTestId('project-open')[0].getAttribute('aria-busy')).toBe('true')
    expect(screen.getAllByTestId('project-open')[0].textContent).toMatch(/opening/i)

    await act(async () => {
      release(projectFixture)
    })
    await waitFor(() =>
      expect(screen.getAllByTestId('project-open')[0].getAttribute('aria-busy')).toBe('false')
    )
  })
})

describe('the row menu', () => {
  it('offers rename, duplicate, reveal and delete', async () => {
    render(<Dashboard />)
    await openMenu('p1')
    for (const id of [
      'project-rename',
      'project-duplicate',
      'project-reveal',
      'project-delete'
    ] as const) {
      expect(screen.getByTestId(id), id).toBeTruthy()
    }
  })

  it('reveals the project FILE, not a guessed directory', async () => {
    const openFolder = vi.fn(async () => undefined)
    window.openclip.system.openFolder = openFolder
    render(<Dashboard />)
    await openMenu('p1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-reveal'))
    })
    expect(openFolder).toHaveBeenCalledWith({ path: '/proj/p1.ocproj' })
  })
})

describe('delete is confirmed — there is no undo', () => {
  it('does not delete on the menu item alone', async () => {
    const del = vi.fn(async () => ({ deleted: true }))
    window.openclip.project.delete = del
    render(<Dashboard />)
    await openMenu('p1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-delete'))
    })
    expect(del).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-delete-confirm')).toBeTruthy()
  })

  it('deletes only after the confirmation', async () => {
    const del = vi.fn(async () => ({ deleted: true }))
    window.openclip.project.delete = del
    render(<Dashboard />)
    await openMenu('p1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-delete'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-delete-confirm-yes'))
    })
    expect(del).toHaveBeenCalledWith({ id: 'p1' })
  })

  it('cancel dismisses without deleting', async () => {
    const del = vi.fn(async () => ({ deleted: true }))
    window.openclip.project.delete = del
    render(<Dashboard />)
    await openMenu('p1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-delete'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-delete-cancel'))
    })
    expect(del).not.toHaveBeenCalled()
    expect(screen.queryByTestId('project-delete-confirm')).toBeNull()
  })
})

describe('inline rename', () => {
  it('writes the new name on Enter', async () => {
    // Captured rather than read off `mock.calls`, whose element type vitest
    // widens to `never[]` for a zero-arg fn signature.
    const saved: Project[] = []
    const save = async ({ project }: { project: Project }): Promise<{ path: string }> => {
      saved.push(project)
      return { path: '/proj/p1.ocproj' }
    }
    window.openclip.project.save = save
    window.openclip.project.load = async () => ({
      ...projectFixture,
      id: 'p1',
      name: 'First Project'
    })
    render(<Dashboard />)
    await openMenu('p1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-rename'))
    })
    const input = screen.getByTestId('project-rename-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toBe('Renamed')
  })

  it('Escape abandons the edit without writing', async () => {
    const save = vi.fn(async () => ({ path: '/x' }))
    window.openclip.project.save = save
    render(<Dashboard />)
    await openMenu('p1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-rename'))
    })
    const input = screen.getByTestId('project-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Nope' } })
      fireEvent.keyDown(input, { key: 'Escape' })
    })
    expect(save).not.toHaveBeenCalled()
    expect(screen.queryByTestId('project-rename-input')).toBeNull()
  })
})

// ============================================================================
// The action core, tested directly against the mock bridge.
// ============================================================================

describe('projectActions.rename', () => {
  it('loads, renames and saves — no new IPC channel needed', async () => {
    const bridge = createMockOpenclip()
    const saved: Project[] = []
    bridge.project.load = async () => ({ ...projectFixture, id: 'p1', name: 'Old' })
    bridge.project.save = async ({ project }) => {
      saved.push(project)
      return { path: '/x' }
    }
    const actions = projectActions(bridge, useProjectStore)
    const out = await actions.rename('p1', '  New name  ')
    expect(out.name).toBe('New name') // trimmed
    expect(saved[0].name).toBe('New name')
    expect(saved[0].id).toBe('p1') // same project, not a copy
  })

  it('refuses an empty name rather than writing a nameless project', async () => {
    const bridge = createMockOpenclip()
    const actions = projectActions(bridge, useProjectStore)
    await expect(actions.rename('p1', '   ')).rejects.toThrow(/cannot be empty/i)
  })

  it('does NOT switch the editor to the project it renamed', async () => {
    // Renaming a project from the recents list must not yank the user out of
    // whatever they were editing.
    const bridge = createMockOpenclip()
    bridge.project.load = async () => ({ ...projectFixture, id: 'other', name: 'Old' })
    bridge.project.save = async () => ({ path: '/x' })
    const open: Project = { ...projectFixture, id: 'mine', name: 'Mine' }
    useProjectStore.setState({ currentProject: open })

    await projectActions(bridge, useProjectStore).rename('other', 'Renamed')
    expect(useProjectStore.getState().currentProject?.id).toBe('mine')
    expect(useProjectStore.getState().currentProject?.name).toBe('Mine')
  })

  it('DOES update the open project’s in-memory name', async () => {
    // …so the title bar and the recents row cannot disagree.
    const bridge = createMockOpenclip()
    bridge.project.load = async () => ({ ...projectFixture, id: 'mine', name: 'Mine' })
    bridge.project.save = async () => ({ path: '/x' })
    useProjectStore.setState({ currentProject: { ...projectFixture, id: 'mine', name: 'Mine' } })

    await projectActions(bridge, useProjectStore).rename('mine', 'Renamed')
    expect(useProjectStore.getState().currentProject?.name).toBe('Renamed')
  })
})

describe('projectActions.duplicate', () => {
  it('copies under a NEW id with a distinct name', async () => {
    const bridge = createMockOpenclip()
    const saved: Project[] = []
    bridge.project.load = async () => ({ ...projectFixture, id: 'p1', name: 'Original' })
    bridge.project.save = async ({ project }) => {
      saved.push(project)
      return { path: '/x' }
    }
    const copy = await projectActions(bridge, useProjectStore).duplicate('p1')
    expect(copy.id).not.toBe('p1')
    expect(copy.name).toBe('Original copy')
    expect(saved[0].id).toBe(copy.id)
  })

  it('keeps the transcript and clips — that is the point of duplicating', async () => {
    const bridge = createMockOpenclip()
    bridge.project.load = async () => projectFixture
    bridge.project.save = async () => ({ path: '/x' })
    const copy = await projectActions(bridge, useProjectStore).duplicate('p1')
    expect(copy.transcript).toEqual(projectFixture.transcript)
    expect(copy.clips).toEqual(projectFixture.clips)
  })

  it('does NOT inherit the export history', async () => {
    // Those files belong to the original run; claiming them would be a lie about
    // what this copy has produced.
    const bridge = createMockOpenclip()
    bridge.project.load = async () => ({
      ...projectFixture,
      exportHistory: [
        {
          id: 'e1',
          clipId: 'c1',
          outputPath: '/out/a.mp4',
          exportedAt: 1,
          width: 1080,
          height: 1920,
          format: 'mp4' as const
        }
      ]
    })
    bridge.project.save = async () => ({ path: '/x' })
    const copy = await projectActions(bridge, useProjectStore).duplicate('p1')
    expect(copy.exportHistory).toEqual([])
  })

  it('does not switch the editor to the copy', async () => {
    const bridge = createMockOpenclip()
    bridge.project.load = async () => ({ ...projectFixture, id: 'p1' })
    bridge.project.save = async () => ({ path: '/x' })
    useProjectStore.setState({ currentProject: { ...projectFixture, id: 'mine' } })
    await projectActions(bridge, useProjectStore).duplicate('p1')
    expect(useProjectStore.getState().currentProject?.id).toBe('mine')
  })
})
