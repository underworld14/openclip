// @vitest-environment jsdom
/**
 * tests/unit/settings-panel-copy.spec.tsx — the AI tab explains itself in
 * plain language (EPIC-k83ghw / FEAT-rmgkee).
 *
 * Before this: the packaged app's clean-profile AI tab read "AI Provider
 * (BYOK)" as the first label a new user saw, no link to any provider's key
 * page anywhere in the app, no cost estimate before a key was even saved, and
 * Ollama — the one no-key no-cost path — was indistinguishable from the paid
 * providers in the list. This pins the fix: what's PRESENT (a plain
 * explainer, "Get a key" links, a cost hint, Ollama's free badge) and what's
 * ABSENT (the implementation vocabulary the ticket names).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { OpenClipBridge } from '@preload/index'
import { installRendererEnv } from '../harness/renderer-env'
import { SettingsPanel } from '@renderer/components/SettingsPanel'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import type { AIProvider } from '@shared/schema'

function mount(aiProvider: AIProvider): OpenClipBridge {
  const bridge = installRendererEnv({ settings: { aiProvider, model: '' } })
  bridge.settings.apiKeyStatus = vi.fn(async ({ provider }) => ({ provider, hasKey: false }))
  bridge.ai.listModels = vi.fn(async ({ provider }) => ({
    provider,
    models: [],
    fetchedAt: 1,
    fromCache: false
  })) as unknown as OpenClipBridge['ai']['listModels']
  useSettingsStore.setState({
    models: [],
    modelsFetchedAt: null,
    modelsLoading: false,
    modelsError: null,
    saveError: null
  })
  render(<SettingsPanel />)
  return bridge
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SettingsPanel AI tab: no implementation vocabulary (BUG-rmgkee AC4)', () => {
  it('never renders "BYOK", "safeStorage", or "strict JSON" for any provider', async () => {
    const providers: AIProvider[] = ['openai', 'anthropic', 'ollama', 'openrouter', 'custom']
    for (const provider of providers) {
      mount(provider)
      await waitFor(() => expect(screen.getByLabelText('AI Provider')).toBeTruthy())
      const text = document.body.textContent ?? ''
      expect(text).not.toMatch(/BYOK/)
      expect(text).not.toMatch(/safeStorage/)
      expect(text).not.toMatch(/strict JSON/i)
      cleanup()
    }
  })
})

describe('SettingsPanel AI tab: explains what a key is and who charges (AC2)', () => {
  it('shows a plain-language explainer before any provider-specific field', async () => {
    mount('openai')
    await waitFor(() => expect(screen.getByLabelText('AI Provider')).toBeTruthy())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/only that text is ever sent/i)
    expect(text).toMatch(/you pay them directly/i)
    expect(text).toMatch(/OpenClip never bills you/i)
  })
})

describe("SettingsPanel AI tab: discloses the project's title is sent too (BUG-12bxbk)", () => {
  it('names the title alongside the transcript and explains it defaults to the filename', async () => {
    mount('openai')
    await waitFor(() => expect(screen.getByLabelText('AI Provider')).toBeTruthy())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/transcript and the project’s title/i)
    expect(text).toMatch(/title defaults to the file you imported/i)
  })
})

describe('SettingsPanel AI tab: "Get a key" links (AC1)', () => {
  it('links straight to the real key page for a keyed provider', async () => {
    mount('openai')
    await waitFor(() => expect(screen.getByTestId('get-a-key-link')).toBeTruthy())
    expect(screen.getByTestId('get-a-key-link').getAttribute('href')).toBe(
      'https://platform.openai.com/api-keys'
    )
    // Opens in the OS browser, never inside the app.
    expect(screen.getByTestId('get-a-key-link').getAttribute('target')).toBe('_blank')
  })

  it('has no "Get a key" link for ollama (no key at all) or custom (no fixed page)', async () => {
    mount('ollama')
    await waitFor(() => expect(screen.getByLabelText('AI Provider')).toBeTruthy())
    expect(screen.queryByTestId('get-a-key-link')).toBeNull()
    cleanup()

    mount('custom')
    await waitFor(() => expect(screen.getByLabelText('AI Provider')).toBeTruthy())
    expect(screen.queryByTestId('get-a-key-link')).toBeNull()
  })
})

describe('SettingsPanel AI tab: Ollama is presented as the free, no-key option (AC3)', () => {
  it('shows the free badge for ollama and hides the key field entirely', async () => {
    mount('ollama')
    await waitFor(() => expect(screen.getByTestId('ollama-free-badge')).toBeTruthy())
    expect(screen.getByTestId('ollama-free-badge').textContent).toMatch(/free/i)
    expect(screen.getByTestId('ollama-free-badge').textContent).toMatch(/no key needed/i)
    // A provider that needs no key at all shouldn't show a key field to fill in.
    expect(screen.queryByLabelText(/API key for/)).toBeNull()
  })

  it('does not show the free badge for a paid provider', async () => {
    mount('openai')
    await waitFor(() => expect(screen.getByLabelText('AI Provider')).toBeTruthy())
    expect(screen.queryByTestId('ollama-free-badge')).toBeNull()
  })
})

describe('SettingsPanel AI tab: a rough cost hint (AC2)', () => {
  it('shows a hint for a keyed provider, with no hard dollar figure', async () => {
    mount('openai')
    await waitFor(() => expect(screen.getByTestId('provider-cost-hint')).toBeTruthy())
    expect(screen.getByTestId('provider-cost-hint').textContent).not.toMatch(/\$\d/)
  })
})
