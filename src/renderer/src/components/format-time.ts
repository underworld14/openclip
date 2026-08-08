/**
 * format-time — the SINGLE seconds→display-string formatter (audit fix openclip-64e).
 *
 * Three panels previously reimplemented seconds→string with slightly different
 * precision/overflow rules (`formatTimecode` = M:SS, `formatTime` = M:SS.cs,
 * `formatTimestamp` = m:ss / h:mm:ss). They overlapped heavily but diverged just
 * enough that a reader couldn't tell which differences were intentional. This one
 * function reproduces all three EXACTLY via options, and the three named helpers are
 * now thin wrappers over it — so an hour-rollover/precision tweak lives in one place.
 *
 * Options:
 *   - precision: 'sec' (default) → whole seconds; 'cs' → `.cc` centiseconds (carries
 *     when cs rounds to 100). 'cs' implies `hours:'never'` (no caller needs both).
 *   - hours: 'never' (default) → minutes never roll into an hours field, so a 75-min
 *     clip reads `75:00`; 'auto' → show `h:mm:ss` once ≥ 1h, else `m:ss`.
 */
export interface FormatSecondsOptions {
  precision?: 'sec' | 'cs'
  hours?: 'never' | 'auto'
}

export function formatSeconds(seconds: number, opts: FormatSecondsOptions = {}): string {
  const s = Math.max(0, seconds)

  if (opts.precision === 'cs') {
    const m = Math.floor(s / 60)
    const rem = s - m * 60
    const whole = Math.floor(rem)
    const cs = Math.round((rem - whole) * 100)
    // carry if centiseconds rounded up to 100
    const ss = cs === 100 ? whole + 1 : whole
    const csOut = cs === 100 ? 0 : cs
    return `${m}:${String(ss).padStart(2, '0')}.${String(csOut).padStart(2, '0')}`
  }

  const total = Math.floor(s)
  if (opts.hours === 'auto') {
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const sec = total % 60
    const ss = String(sec).padStart(2, '0')
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
  }

  // hours: 'never' — minutes accumulate without rolling into an hours field.
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}
