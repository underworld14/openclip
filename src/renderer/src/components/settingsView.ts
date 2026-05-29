/**
 * settingsView.ts — pure presentation helpers for SettingsPanel (T-AI, plan
 * E.3). Extracted from the `.tsx` so they are unit-testable without a DOM and so
 * the component file only exports components (react-refresh).
 *
 * `keyStatusLabel` summarizes key presence WITHOUT ever exposing the key (only
 * the last4 fragment — PRD §12.2).
 */

import type { AIProvider } from '@shared/schema'
import type { ApiKeyStatus } from '@shared/channels'

const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  ollama: 'Ollama (local)'
}

export function providerLabel(provider: AIProvider): string {
  return PROVIDER_LABELS[provider]
}

/** Summarize key status WITHOUT ever exposing the key (only last4). */
export function keyStatusLabel(status: ApiKeyStatus | undefined): string {
  if (!status || !status.hasKey) return 'No key set'
  return `Key set ••••${status.last4 ?? ''}`
}

export const PROVIDERS: AIProvider[] = ['openai', 'anthropic', 'google', 'ollama']
