/**
 * settingsView.ts — pure presentation helpers for SettingsPanel (T-AI, plan
 * E.3). Extracted from the `.tsx` so they are unit-testable without a DOM and so
 * the component file only exports components (react-refresh).
 *
 * `keyStatusLabel` summarizes key presence WITHOUT ever exposing the key (only
 * the last4 fragment — PRD §12.2).
 */

import type { AIProvider } from '@shared/schema'
import type { ApiKeyStatus, ModelInfo } from '@shared/channels'

const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  ollama: 'Ollama (local)',
  openrouter: 'OpenRouter'
}

export function providerLabel(provider: AIProvider): string {
  return PROVIDER_LABELS[provider]
}

/** Summarize key status WITHOUT ever exposing the key (only last4). */
export function keyStatusLabel(status: ApiKeyStatus | undefined): string {
  if (!status || !status.hasKey) return 'No key set'
  return `Key set ••••${status.last4 ?? ''}`
}

export const PROVIDERS: AIProvider[] = ['openai', 'anthropic', 'google', 'ollama', 'openrouter']

// ── Model-picker pure helpers (Part H — OpenRouter) ──────────────────────────

/** Case-insensitive substring filter over id + name + description (empty → all). */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return models
  return models.filter(
    (m) =>
      m.id.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      (m.description ?? '').toLowerCase().includes(q)
  )
}

/** Split into the recommended (pinned) group and the rest, preserving order. */
export function partitionRecommended(models: ModelInfo[]): {
  recommended: ModelInfo[]
  others: ModelInfo[]
} {
  return {
    recommended: models.filter((m) => m.recommended),
    others: models.filter((m) => !m.recommended)
  }
}

/** "$3.00 / $15.00 per 1M" pricing summary; "Free" / "" when unknown. */
export function formatModelPrice(m: ModelInfo): string {
  const fmt = (n: number | undefined): string | null =>
    n === undefined ? null : n === 0 ? '$0' : `$${n.toFixed(2)}`
  const inp = fmt(m.pricePerMTokIn)
  const out = fmt(m.pricePerMTokOut)
  if (inp === null && out === null) return ''
  if (inp === '$0' && out === '$0') return 'Free'
  return `${inp ?? '?'} / ${out ?? '?'} per 1M`
}
