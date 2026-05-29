/**
 * src/main/ipc/audio.ts — audio control-plane handler (T-Media, E.3).
 *
 * Wires AUDIO_EXTRACT (PRD §6.1): probe the source for duration, then extract a
 * 16kHz mono WAV via FFmpeg (content-addressed cached, PRD §17). Returns the WAV
 * path so the renderer can hand it to the `transcribe` job.
 *
 * Extraction is short and request/response here; long, streaming work
 * (transcribe/export/model-download) goes through JOB_START instead (PRD §10.2).
 */

import { IPCChannels } from '@shared/channels'
import type { IpcContext } from './index'
import { extractAudio } from '@main/services/ffmpeg-extract'
import { probeVideo } from '@main/utils/ffprobe'

export function registerAudioHandlers(ctx: IpcContext): void {
  ctx.ipcMain.handle(
    IPCChannels.AUDIO_EXTRACT,
    async (_e, req: { projectId: string; sourcePath: string }): Promise<{ wavPath: string }> => {
      // E2E fake-sidecar mode (plan E.10): skip the real ffmpeg decode so the
      // vertical-slice E2E can drive extract→transcribe without a media file.
      if (process.env.OPENCLIP_FAKE_TRANSCRIBE) {
        return { wavPath: `/tmp/openclip/${req.projectId}/cache/audio.16k.wav` }
      }
      // Probe duration so extraction progress can be computed; tolerate probe
      // failure (extraction still works, just without a duration denominator).
      let durationSec: number | undefined
      try {
        durationSec = (await probeVideo(req.sourcePath)).duration
      } catch {
        durationSec = undefined
      }
      const { wavPath } = await extractAudio({
        projectId: req.projectId,
        sourcePath: req.sourcePath,
        durationSec
      })
      return { wavPath }
    }
  )
}
