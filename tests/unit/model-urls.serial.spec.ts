/**
 * tests/unit/model-urls.serial.spec.ts — @serial: every model the app OFFERS is
 * actually published, at the URL we build, with the SHA256 we pinned
 * (BUG-45xt77).
 *
 * This is the guard that was missing. `turbo` resolved to `ggml-turbo.bin`,
 * which 404s — the real asset is `ggml-large-v3-turbo.bin` — and it was offered
 * in the UI for the entire life of the feature because no test ever asked the
 * hub whether the file existed. Every other model was equally unverified: the
 * hashes came from a hand-copied local file, so five of six could not verify at
 * all.
 *
 * Network, so it self-skips like the other real-dependency smokes: opt in with
 * `OPENCLIP_CHECK_MODEL_URLS=1`. It reads only HEADERS (no model bytes are
 * downloaded), and it deliberately does NOT follow the redirect — the sha256
 * lives on the 302 as `x-linked-etag`, which is the whole subtlety this bug
 * turned on.
 */

import { describe, expect, it } from 'vitest'
import { ALL_MODELS, MODEL_ASSETS, modelUrl } from '@main/services/model-manager'

const ENABLED = process.env.OPENCLIP_CHECK_MODEL_URLS === '1'

describe.skipIf(!ENABLED)('@serial published model assets match the pinned manifest', () => {
  for (const model of ALL_MODELS) {
    it(`${model}: resolves, and its published SHA256 + size match the pin`, async () => {
      const res = await fetch(modelUrl(model), { method: 'GET', redirect: 'manual' })

      // A 404 here is exactly the `turbo` bug: a model offered in the picker
      // that can never install.
      expect(res.status, `${modelUrl(model)} did not redirect (HTTP ${res.status})`).toBe(302)

      const etag = res.headers.get('x-linked-etag')?.replace(/"/g, '').toLowerCase()
      const size = Number(res.headers.get('x-linked-size'))
      expect(etag, `${model}: no x-linked-etag on the redirect`).toBeTruthy()
      expect(etag).toBe(MODEL_ASSETS[model].sha256)
      expect(size).toBe(MODEL_ASSETS[model].bytes)
    }, 30_000)
  }
})
