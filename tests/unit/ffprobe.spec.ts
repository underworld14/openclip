/**
 * tests/unit/ffprobe.spec.ts — unit coverage for the PURE ffprobe JSON mapper
 * (utils/ffprobe.ts → `parseFfprobeJson`). The mapper turns the
 * `ffprobe -print_format json -show_format -show_streams` document into the
 * frozen `SourceVideo` shape (PRD §6.1 / §9.3). The real-binary `probeVideo`
 * path is exercised by the @serial smoke; here we pin the pure transform on a
 * canned ffprobe document (PRD §18 "mock at the boundary").
 */

import { describe, expect, it } from 'vitest'
import { parseFfprobeJson, parseFrameRate, NoAudioTrackError } from '@main/utils/ffprobe'
import { SourceVideo } from '@shared/schema'

const FFPROBE_JSON = {
  streams: [
    {
      codec_type: 'video',
      width: 1920,
      height: 1080,
      r_frame_rate: '30000/1001',
      avg_frame_rate: '30000/1001'
    },
    { codec_type: 'audio', sample_rate: '48000', channels: 2 }
  ],
  format: {
    filename: '/tmp/sample.mp4',
    duration: '241.6',
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2'
  }
}

describe('ffprobe: parseFrameRate (ratio string → fps)', () => {
  it('evaluates a num/den ratio rounded to 3 decimals', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2)
    expect(parseFrameRate('25/1')).toBe(25)
    expect(parseFrameRate('30')).toBe(30)
  })
  it('returns 0 for 0/0 and garbage', () => {
    expect(parseFrameRate('0/0')).toBe(0)
    expect(parseFrameRate('')).toBe(0)
  })
})

describe('ffprobe: parseFfprobeJson → SourceVideo (PRD §6.1/§9.3)', () => {
  it('maps the video stream + format into a contract-valid SourceVideo', () => {
    const sv = parseFfprobeJson(FFPROBE_JSON, '/tmp/sample.mp4')
    expect(sv.path).toBe('/tmp/sample.mp4')
    expect(sv.resolution).toEqual({ width: 1920, height: 1080 })
    expect(sv.duration).toBeCloseTo(241.6, 1)
    expect(sv.fps).toBeCloseTo(29.97, 2)
    expect(sv.format).toBe('mov,mp4,m4a,3gp,3g2,mj2')
    // Always satisfies the frozen Zod shape.
    expect(() => SourceVideo.parse(sv)).not.toThrow()
  })

  it('prefers r_frame_rate but falls back to avg_frame_rate', () => {
    const json = {
      streams: [
        { codec_type: 'video', width: 640, height: 480, avg_frame_rate: '24/1' },
        { codec_type: 'audio' }
      ],
      format: { duration: '10', format_name: 'mp4' }
    }
    expect(parseFfprobeJson(json, '/x.mp4').fps).toBe(24)
  })

  it('throws INPUT_INVALID-style error when there is no video stream', () => {
    const json = { streams: [{ codec_type: 'audio' }], format: { duration: '10' } }
    expect(() => parseFfprobeJson(json, '/audio-only.mp3')).toThrow(/no video stream/i)
  })

  // EPIC-k83ghw / BUG-aryvgg: a screen recording with no microphone, a muted
  // export, or silent b-roll used to pass probing, commit a project, and only
  // fail minutes later inside audio extraction with raw ffmpeg output.
  it('throws NoAudioTrackError with a plain, actionable sentence when there is no audio stream', () => {
    const json = {
      streams: [{ codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '30/1' }],
      format: { duration: '10', format_name: 'mp4' }
    }
    expect(() => parseFfprobeJson(json, '/silent.mp4')).toThrow(NoAudioTrackError)
    expect(() => parseFfprobeJson(json, '/silent.mp4')).toThrow(/no audio track/i)
  })

  it('coerces a non-finite ffprobe duration ("N/A") to a Zod-valid number (audit fix openclip-bro)', () => {
    const json = {
      streams: [
        { codec_type: 'video', width: 1280, height: 720, r_frame_rate: '25/1' },
        { codec_type: 'audio' }
      ],
      format: { duration: 'N/A', format_name: 'mp4' }
    }
    const sv = parseFfprobeJson(json, '/frag.mp4')
    expect(Number.isFinite(sv.duration)).toBe(true)
    expect(sv.duration).toBe(0) // unknown, but finite → never NaN-poisons the timeline
    expect(() => SourceVideo.parse(sv)).not.toThrow()
  })

  it('falls back to the longest stream duration when format.duration is missing', () => {
    const json = {
      streams: [
        { codec_type: 'video', width: 1280, height: 720, r_frame_rate: '25/1', duration: '42.5' },
        { codec_type: 'audio', duration: '41.9' }
      ],
      format: { format_name: 'matroska' } // no format-level duration (common for MKV)
    }
    const sv = parseFfprobeJson(json, '/clip.mkv')
    expect(sv.duration).toBeCloseTo(42.5, 1)
    expect(() => SourceVideo.parse(sv)).not.toThrow()
  })
})
