/**
 * tests/unit/source-media.spec.ts — the source-video preview URL encoding round
 * trip (TIMELINE spine, plan E.5 / PRD §6.6).
 *
 * The renderer builds an `openclip-media://file/...` URL (`sourceMediaUrl`); the
 * main process decodes the SAME scheme back to an absolute path
 * (`pathFromMediaUrl`). The two live in different processes that may not import
 * each other, so the encoding is duplicated — THIS test is the contract that
 * keeps them in lockstep: encode in the renderer, decode in main, get the
 * original path back (and the reverse).
 *
 * `mediaUrlForPath` (main) is asserted byte-equal to `sourceMediaUrl` (renderer)
 * so either side can produce a URL the other accepts.
 */

import { describe, expect, it } from 'vitest'
import { sourceMediaUrl, MEDIA_SCHEME as RENDERER_SCHEME } from '@renderer/components/source-media'
import {
  mediaUrlForPath,
  pathFromMediaUrl,
  MEDIA_SCHEME as MAIN_SCHEME
} from '@main/utils/media-protocol'

const PATHS = [
  '/Users/me/Movies/podcast.mp4',
  '/Users/me/My Movies/the wild take.mov',
  '/tmp/openclip/clip #1 (final).mkv',
  '/Users/me/Vidéos/résumé.mp4',
  '/a/b/c.mp4'
]

describe('source-media scheme name parity', () => {
  it('renderer and main agree on the scheme name', () => {
    expect(RENDERER_SCHEME).toBe(MAIN_SCHEME)
    expect(RENDERER_SCHEME).toBe('openclip-media')
  })
})

describe('sourceMediaUrl (renderer)', () => {
  it('returns null for an empty/missing path', () => {
    expect(sourceMediaUrl(null)).toBeNull()
    expect(sourceMediaUrl(undefined)).toBeNull()
    expect(sourceMediaUrl('')).toBeNull()
  })

  it('builds an openclip-media://file URL with percent-encoded segments', () => {
    expect(sourceMediaUrl('/Users/me/My Movies/clip.mp4')).toBe(
      'openclip-media://file/Users/me/My%20Movies/clip.mp4'
    )
  })
})

describe('renderer ↔ main URL round trip', () => {
  it.each(PATHS)('encode (renderer) → decode (main) recovers the path: %s', (p) => {
    const url = sourceMediaUrl(p)!
    expect(url.startsWith(`${RENDERER_SCHEME}://file`)).toBe(true)
    expect(pathFromMediaUrl(url)).toBe(p)
  })

  it.each(PATHS)('renderer and main produce byte-identical URLs: %s', (p) => {
    expect(sourceMediaUrl(p)).toBe(mediaUrlForPath(p))
  })

  it.each(PATHS)('encode (main) → decode (main) recovers the path: %s', (p) => {
    expect(pathFromMediaUrl(mediaUrlForPath(p))).toBe(p)
  })
})
