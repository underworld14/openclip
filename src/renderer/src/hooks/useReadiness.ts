/**
 * useReadiness — gathers the three first-run checks and feeds `readinessView`
 * (FEAT-c5a15c).
 *
 * Every input already existed; nothing reported it. The binary probe is a single
 * `system.preflight` call (paths.ts has always resolved these), the key/model
 * come from the settings store, and whisper presence from `model.status`.
 *
 * Deliberately re-probes the whisper model whenever the selected size changes or
 * a download finishes, so the chip flips to green without an app restart.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { readinessView, type ReadinessView } from '@renderer/components/readinessView'
import type { PreflightResult } from '@shared/channels'

export interface UseReadiness extends ReadinessView {
  /** Re-run the whisper-presence check (call after a model download completes). */
  refresh: () => void
  /**
   * The raw preflight probe, for callers that need a binary the three general
   * chips deliberately omit (FEAT-azqfsv).
   *
   * `ytDlp` is the case this exists for: a missing yt-dlp only breaks URL
   * import, so it does not belong in the always-visible chips — but it WAS
   * reported and read by nothing at all, which is precisely how `whisperCli`
   * ended up probed-and-ignored. `null` while the probe is in flight.
   */
  preflight: PreflightResult | null
}

export function useReadiness(): UseReadiness {
  const settings = useSettingsStore((s) => s.settings)
  const keyStatus = useSettingsStore((s) => s.keyStatus)
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  // null until probed: `false` would render a red chip on every first paint and
  // stay red forever if the IPC failed.
  const [whisperInstalled, setWhisperInstalled] = useState<boolean | null>(null)
  const [nonce, setNonce] = useState(0)

  // Binaries can't change while the app runs — probe once.
  useEffect(() => {
    let alive = true
    void window.openclip.system
      .preflight()
      .then((r) => {
        if (alive) setPreflight(r)
      })
      .catch(() => {
        // Leave it null (renders "Checking…") rather than claiming a failure we
        // did not actually observe.
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    void window.openclip.model
      .status({ model: settings.whisperModel })
      .then((rows) => {
        if (alive) setWhisperInstalled(rows.some((r) => r.installed))
      })
      .catch(() => {
        if (alive) setWhisperInstalled(false)
      })
    return () => {
      alive = false
    }
  }, [settings.whisperModel, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  return {
    ...readinessView({
      preflight,
      provider: settings.aiProvider,
      hasKey: keyStatus[settings.aiProvider]?.hasKey ?? false,
      baseUrl: settings.baseUrl,
      model: settings.model,
      whisperModel: settings.whisperModel,
      whisperInstalled
    }),
    refresh,
    preflight
  }
}
