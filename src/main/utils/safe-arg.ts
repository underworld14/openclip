/**
 * src/main/utils/safe-arg.ts — spawn-boundary guard against OPTION injection
 * (audit fix openclip-6l6).
 *
 * ffmpeg / ffprobe / whisper-cli are spawned WITHOUT a shell, so classic shell
 * injection is impossible. But every one of them parses any argv token that
 * begins with '-' as an OPTION, not a filename. A path argument that begins with
 * '-' (e.g. an attacker-supplied outputPath of '-y' or a sourcePath of
 * '-protocol_whitelist,file,...') would therefore be interpreted as a flag and
 * could alter the encode, change the muxer/protocol, or write a sentinel file.
 *
 * Every real path the app passes is ABSOLUTE (userData, temp scratch, or a path
 * chosen via a native dialog), so a leading dash here is always malformed or
 * hostile input. The arg builders run each path argument through this guard
 * before it reaches spawn()/execFile().
 */

/**
 * Assert that `path` is safe to pass as a positional/value file argument to a
 * spawned binary, and return it unchanged. Throws if it is empty, not a string,
 * or begins with '-' (which the binary would parse as an option). `label` names
 * the argument in the error message for diagnosability.
 */
export function assertSafePathArg(path: string, label = 'path'): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`Unsafe ${label}: expected a non-empty path string`)
  }
  if (path.startsWith('-')) {
    throw new Error(
      `Unsafe ${label}: must not begin with '-' (would be parsed as an option): ${path.slice(0, 60)}`
    )
  }
  return path
}
