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
 * Uses `encodeURI` semantics per segment via the WHATWG `URL` builder so the
 * percent-encoding matches Node's `pathToFileURL` on the main side (both encode
 * spaces as `%20`, leave `/` as separators, etc.).
 */
export function sourceMediaUrl(absPath: string | null | undefined): string | null {
  if (!absPath) return null
  // Build a file: URL the same way Node's pathToFileURL would, then swap the
  // scheme — this guarantees byte-for-byte agreement with the main decoder.
  const encoded = absPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `${MEDIA_SCHEME}://file${encoded.startsWith('/') ? '' : '/'}${encoded}`
}
