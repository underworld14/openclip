/**
 * src/main/services/whisper-spawn.ts — the whisper-cli SPAWN side (T-Media, E.3).
 *
 * The trunk owns the pure JSON→contract transform (`whisper-parse.ts`, frozen at
 * `contracts-v1`); this module is its spawn counterpart: it runs the REAL
 * bundled `whisper-cli` over an extracted 16kHz WAV, streams progress + per-word
 * partials while it decodes, and reads the on-disk `--output-json-full` document
 * to produce the final transcript via the frozen parser.
 *
 * Gate-A-verified invocation (whisper.cpp 1.8.4):
 *   whisper-cli -m <model> -f <wav> -ml 1 --split-on-word --output-json-full \
 *               --print-confidence -pp -of <base>            [ -l <language> ]
 *
 * Streaming (verified against the real binary):
 *   - stderr carries `whisper_print_progress_callback: progress = N%` lines (the
 *     `-pp` stream) → `parseWhisperProgress` → 0..100 pct.
 *   - stdout carries one decoded word per line:
 *       `[hh:mm:ss.mmm --> hh:mm:ss.mmm]  word`
 *     (ANSI-colored by `--print-confidence`) → `parseWhisperWordLine` → a partial
 *     WordTimestamp emitted live so the renderer builds a transcript as it goes.
 *   - the authoritative timings/probabilities come from `<base>.json` (parsed by
 *     the frozen `parseWhisperJson`); the streamed words are progress-only.
 *
 * Pure helpers (`whisperArgs`, `parseWhisperProgress`, `parseWhisperWordLine`,
 * `stripAnsi`) are unit-tested without a binary (PRD §18); `runWhisper` is proven
 * end-to-end by the @serial smoke.
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { WordTimestamp } from '@shared/schema'
import { parseWhisperJson, type ParsedTranscript, type WhisperJson } from './whisper-parse'
import { whisperCliPath, whisperResourcesDir } from '@main/utils/paths'

// ============================================================================
// Argument construction (the Gate-A exact invocation)
// ============================================================================

export interface WhisperArgsOptions {
  /** Absolute path to the ggml-<size>.bin model. */
  model: string
  /** Absolute path to the 16kHz mono WAV. */
  wavPath: string
  /** Output base path (whisper appends `.json`). */
  outBase: string
  /** undefined => whisper auto-detect (PRD §6.2 multi-language). */
  language?: string
}

/**
 * Build the verified whisper-cli argv. `-of <base>` is ALWAYS last so callers /
 * tests can rely on its position; `-l <language>` is inserted before it only
 * when a fixed language is requested (otherwise whisper auto-detects).
 */
export function whisperArgs(opts: WhisperArgsOptions): string[] {
  const args = [
    '-m',
    opts.model,
    '-f',
    opts.wavPath,
    '-ml',
    '1',
    '--split-on-word',
    '--output-json-full',
    '--print-confidence',
    '-pp'
  ]
  if (opts.language) args.push('-l', opts.language)
  args.push('-of', opts.outBase)
  return args
}

// ============================================================================
// Stream parsing (pure)
// ============================================================================

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g

/** Remove ANSI SGR color escapes whisper emits under `--print-confidence`. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

const PROGRESS_RE = /progress\s*=\s*(\d+)\s*%/g

/**
 * Parse whisper's `-pp` progress lines. Returns the LAST percentage seen in the
 * chunk (0..100), or `undefined` if the chunk carries no progress line. Robust
 * to arbitrary chunk boundaries (only fully-seen `progress = N%` tokens count).
 */
export function parseWhisperProgress(chunk: string): number | undefined {
  let pct: number | undefined
  let m: RegExpExecArray | null
  PROGRESS_RE.lastIndex = 0
  while ((m = PROGRESS_RE.exec(chunk)) !== null) {
    const n = Number(m[1])
    if (!Number.isNaN(n)) pct = Math.max(0, Math.min(100, n))
  }
  return pct
}

/** `hh:mm:ss.mmm` → absolute seconds. */
function hmsToSec(hms: string): number {
  const [h, m, rest] = hms.split(':')
  const [s, ms = '0'] = rest.split('.')
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000
}

const WORD_LINE_RE = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.*)$/

/**
 * Parse a single whisper stdout word line emitted under `-ml 1 --split-on-word`:
 *   `[00:00:00.050 --> 00:00:00.470]   Hello`
 * Returns a partial `WordTimestamp` (confidence is 0 here — the authoritative
 * per-word confidence comes from the JSON document, not the live stream), or
 * `null` for blank / special-token / non-word lines.
 */
export function parseWhisperWordLine(line: string): WordTimestamp | null {
  const clean = stripAnsi(line).trimEnd()
  const m = WORD_LINE_RE.exec(clean)
  if (!m) return null
  const word = m[3].trim()
  if (word.length === 0) return null
  return {
    word,
    start: Math.round(hmsToSec(m[1]) * 1000) / 1000,
    end: Math.round(hmsToSec(m[2]) * 1000) / 1000,
    confidence: 0
  }
}

// ============================================================================
// runWhisper — spawn the binary, stream progress/words, parse the JSON doc
// ============================================================================

export interface RunWhisperOptions extends WhisperArgsOptions {
  /** 0..100 progress from the `-pp` stderr stream. */
  onProgress?: (pct: number) => void
  /** Each decoded word as it streams on stdout (live partials). */
  onWord?: (word: WordTimestamp) => void
  /** Cooperative cancel (SIGKILL the child) — wired to the job AbortSignal. */
  signal?: AbortSignal
  /** Override the binary (tests / smoke harness). Defaults to resolved path. */
  binPath?: string
  /** Register the spawned PID with the sidecar for kill-on-quit. */
  onSpawn?: (pid: number) => void
  /** Untrack the PID when the child exits (audit fix openclip-yul). */
  onExit?: (pid: number) => void
}

/** Resolve a safe cwd for whisper (resources dir if it exists, else cwd). */
function resolveWhisperCwd(): string {
  try {
    const dir = whisperResourcesDir()
    if (dir && existsSync(dir)) return dir
  } catch {
    /* not in an Electron runtime / resources unavailable */
  }
  return process.cwd()
}

/**
 * Run whisper-cli to completion and return the parsed transcript. Streams
 * progress (stderr) and per-word partials (stdout) via the callbacks, then reads
 * `<outBase>.json` and maps it through the frozen `parseWhisperJson`. Rejects on
 * non-zero exit, spawn error, or abort (the runner maps these to JobEvents).
 */
export function runWhisper(opts: RunWhisperOptions): Promise<ParsedTranscript> {
  const bin = opts.binPath ?? whisperCliPath()
  const args = whisperArgs(opts)
  return new Promise<ParsedTranscript>((resolve, reject) => {
    const child = spawn(bin, args, {
      // whisper-cli loads default.metallib relative to its own dir; run from the
      // resources dir so Metal kernels resolve in prod (PRD §13). Resolution is
      // guarded: in a non-Electron context (tests) it may be unavailable, so we
      // fall back to the current working directory.
      cwd: resolveWhisperCwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (typeof child.pid === 'number') opts.onSpawn?.(child.pid)

    let stderr = ''
    let stdoutBuf = ''
    // Progress line buffer (audit fix openclip-2p4): the `-pp` progress arrives as
    // `whisper_print_progress_callback: progress = N%` lines on stderr, and a chunk
    // boundary can split one mid-line so parseWhisperProgress misses it. Carry the
    // trailing partial across chunks and parse only complete lines (mirrors the
    // stdout word buffer below). Raw `stderr` accumulation is unchanged.
    let progressResidual = ''

    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stderr += text
      if (opts.onProgress) {
        progressResidual += text
        let nl: number
        while ((nl = progressResidual.indexOf('\n')) !== -1) {
          const line = progressResidual.slice(0, nl)
          progressResidual = progressResidual.slice(nl + 1)
          const pct = parseWhisperProgress(line)
          if (pct !== undefined) opts.onProgress(pct)
        }
      }
    })

    // Word lines arrive on stdout; buffer and split on newline so a word split
    // across two chunks is parsed once whole.
    child.stdout.on('data', (buf: Buffer) => {
      stdoutBuf += buf.toString()
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl)
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (opts.onWord) {
          const w = parseWhisperWordLine(line)
          if (w) opts.onWord(w)
        }
      }
    })

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      // Untrack the exited PID so a later quit/cancel can't SIGKILL a recycled foreign
      // PID (audit fix openclip-yul).
      if (typeof child.pid === 'number') opts.onExit?.(child.pid)
      if (opts.signal?.aborted) {
        reject(new Error('whisper aborted'))
        return
      }
      if (code !== 0) {
        reject(new Error(`whisper-cli exited with code ${code}\n${stderr.slice(-2000)}`))
        return
      }
      // Authoritative result: the on-disk JSON doc (per-word probs + offsets).
      readFile(`${opts.outBase}.json`, 'utf8')
        .then((raw) => resolve(parseWhisperJson(JSON.parse(raw) as WhisperJson)))
        .catch((err: unknown) =>
          reject(err instanceof Error ? err : new Error(`whisper JSON read failed: ${String(err)}`))
        )
    })
  })
}
