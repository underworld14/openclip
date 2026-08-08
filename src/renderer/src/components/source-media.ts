/**
 * source-media — build the `openclip-media://` URL the PreviewPlayer's `<video>`
 * loads for the source-video path (TIMELINE spine, plan E.5 / PRD §6.6).
 *
 * The renderer CANNOT import the main process (lint `import/no-restricted-paths`:
 * "Renderer must not import from main"), and the source path lives in the Project
 * document the renderer already holds. So the URL encoding is duplicated here in
 * the trivial form and kept in lockstep with `main/utils/media-protocol.ts`
 * (`mediaUrlForPath`) — a round-trip unit test asserts the two agree (encode in
 * the renderer, decode in main).
 *
 * Encoding (mirrors the main side): take the absolute path, percent-encode each
 * path SEGMENT (so spaces / unicode / `#` / `?` survive), and prefix the
 * privileged scheme + the `file` host. The leading slash is preserved as the
 * URL path so `pathToFileURL`/`fileURLToPath` on the main side reconstruct the
 * exact absolute path.
 *
 *   /Users/me/My Movie.mp4  →  openclip-media://file/Users/me/My%20Movie.mp4
 */

/** Kept identical to `MEDIA_SCHEME` in main/utils/media-protocol.ts. */
export const MEDIA_SCHEME = 'openclip-media'

/**
 * Build the preview URL for an absolute source path, or `null` for an
 * empty/missing path (the PreviewPlayer renders an empty state then).
 *
 * Encoding contract (audit fix openclip-10m — corrected from the old `pathToFileURL`
 * claim): each `/`-separated path segment is percent-encoded with
 * `encodeURIComponent`, and the MAIN-side decoder `pathFromMediaUrl` decodes each
 * segment with `decodeURIComponent`. The round-trip relies on the
 * `encodeURIComponent`/`decodeURIComponent` SYMMETRY (asserted by source-media.spec),
 * NOT on `pathToFileURL` parity — `encodeURIComponent` actually escapes MORE than
 * `pathToFileURL` (e.g. `+`→`%2B`). `pathToFileURL` is used only LATER, by the main
 * protocol handler to feed `net.fetch`, after `pathFromMediaUrl` has already decoded.
 * Do not "fix" one side to real `pathToFileURL` semantics or you break the byte
 * equality the round-trip test depends on.
 */
export function sourceMediaUrl(absPath: string | null | undefined): string | null {
  if (!absPath) return null
  // Percent-encode each '/'-separated segment; pathFromMediaUrl decodes the same way.
  const encoded = absPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `${MEDIA_SCHEME}://file${encoded.startsWith('/') ? '' : '/'}${encoded}`
}
