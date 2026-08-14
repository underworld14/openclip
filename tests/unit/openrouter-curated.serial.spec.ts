/**
 * tests/unit/openrouter-curated.serial.spec.ts — does the curated shortlist still
 * name models that EXIST? (BUG-2smqpv)
 *
 * The list shipped models their vendors had superseded. Nothing caught it,
 * because nothing could: a fixture-based test can only prove the list matches a
 * fixture we wrote ourselves, which says nothing about OpenRouter's actual
 * catalogue. Staleness here is a fact about the outside world, so the check has
 * to look outside.
 *
 * Note what this can and cannot catch. Running it against the pre-fix list would
 * have PASSED — `anthropic/claude-opus-4.1` is still served by OpenRouter. It
 * catches *disappearance*, not *supersession*, and only a human comparing the
 * survivors against https://openrouter.ai/models catches the latter.
 *
 * So this hits the REAL `/models` endpoint and fails naming any curated id that
 * no longer exists. It is opt-in (`OPENCLIP_CHECK_OPENROUTER=1`) and self-skips
 * otherwise, matching how the repo's other real-dependency suites behave — `npm
 * test` stays green and offline on a bare checkout, and CI never breaks because
 * a third party retired a model overnight.
 *
 * The tagged-`@serial` name keeps it off the parallel pool: it is network I/O
 * against a rate-limited public endpoint.
 *
 *   OPENCLIP_CHECK_OPENROUTER=1 npx vitest run tests/unit/openrouter-curated.serial.spec.ts
 */

import { describe, expect, it } from 'vitest'
import {
  RECOMMENDED_OPENROUTER_MODELS,
  createDefaultFetcher,
  orderForPicker,
  type OpenRouterRawModel
} from '@main/services/openrouter-models'

const ENABLED = !!process.env.OPENCLIP_CHECK_OPENROUTER

describe('@serial curated OpenRouter shortlist — live catalogue check', () => {
  it.skipIf(!ENABLED)(
    'every curated id still exists in the live /models response',
    async () => {
      const live = await createDefaultFetcher()({
        apiKey: process.env.OPENROUTER_API_KEY ?? null
      })
      expect(live.length).toBeGreaterThan(0)

      const liveIds = new Set(live.map((m) => m.id))
      const missing = RECOMMENDED_OPENROUTER_MODELS.filter((id) => !liveIds.has(id))
      expect(
        missing,
        `Curated model id(s) are absent from OpenRouter's live catalogue and will be ` +
          `silently dropped from "Recommended": ${missing.join(', ')}. ` +
          `Refresh RECOMMENDED_OPENROUTER_MODELS in src/main/services/openrouter-models.ts ` +
          `against https://openrouter.ai/models.`
      ).toEqual([])
    },
    30_000
  )

  it.skipIf(!ENABLED)(
    'every curated id is structured-output capable (clip detection needs strict JSON)',
    async () => {
      const live = await createDefaultFetcher()({
        apiKey: process.env.OPENROUTER_API_KEY ?? null
      })
      // A curated id that exists but cannot emit structured output is worse than a
      // missing one: `orderForPicker` filters non-structured models out entirely,
      // so it would vanish from the picker with no signal at all.
      const ordered = orderForPicker(live)
      const recommendedIds = new Set(ordered.filter((m) => m.recommended).map((m) => m.id))
      const present = RECOMMENDED_OPENROUTER_MODELS.filter((id) => live.some((m) => m.id === id))
      const droppedForCapability = present.filter((id) => !recommendedIds.has(id))
      expect(
        droppedForCapability,
        `Curated model id(s) exist but are not structured-output capable, so the ` +
          `picker drops them: ${droppedForCapability.join(', ')}.`
      ).toEqual([])
    },
    30_000
  )
})

describe('curated shortlist — offline invariants', () => {
  it('is non-empty and free of duplicates', () => {
    expect(RECOMMENDED_OPENROUTER_MODELS.length).toBeGreaterThan(0)
    expect(new Set(RECOMMENDED_OPENROUTER_MODELS).size).toBe(RECOMMENDED_OPENROUTER_MODELS.length)
  })

  it('uses OpenRouter vendor/model slugs, not bare provider model ids', () => {
    // `claude-opus-5` is the Anthropic API id; OpenRouter namespaces it as
    // `anthropic/claude-opus-5`. A bare id silently never matches the live list.
    for (const id of RECOMMENDED_OPENROUTER_MODELS) {
      expect(id, `${id} should be a "vendor/model" slug`).toMatch(/^[a-z0-9-]+\/\S+$/)
    }
  })

  it('drops a retired id from Recommended rather than offering it', () => {
    // The safety property the whole design rests on, asserted directly: a curated
    // slug absent from the live response must not appear as recommended.
    const live: OpenRouterRawModel[] = [
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        supported_parameters: ['structured_outputs']
      }
    ]
    const out = orderForPicker(live, ['anthropic/retired-model', 'openai/gpt-5'])
    expect(out.map((m) => m.id)).toEqual(['openai/gpt-5'])
    expect(out.find((m) => m.id === 'anthropic/retired-model')).toBeUndefined()
  })
})
