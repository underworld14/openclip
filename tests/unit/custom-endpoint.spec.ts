/**
 * tests/unit/custom-endpoint.spec.ts — the custom OpenAI-compatible provider's
 * transport (FEAT-bysdwg).
 *
 * Three things decide whether this provider works at all, and none of them is
 * visible from the outside:
 *
 *  1. A KEYLESS local server must receive no `Authorization` header — and the
 *     SDK must not fall back to `process.env.OPENAI_API_KEY`, which would send
 *     the user's real OpenAI key to whatever host they typed.
 *  2. The structured-output ladder must downgrade on "I don't support that" and
 *     ONLY on that — a 401 or a cancel that downgrades costs money for nothing.
 *  3. The memo must make the discovery cost once-per-session, not once-per-chunk.
 *
 * No network: a fake `OpenAILike` records every request body.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildOpenAITransport,
  clipsMemoKey,
  createTransport,
  extractJsonCandidate,
  isUnsupportedStructuredOutputError,
  OPENAI_COMPAT_MODES,
  resolvedStructuredMode,
  SYSTEM_PROMPT,
  __resetStructuredModeMemoForTests,
  type OpenAILike
} from '@main/services/ai-client'

afterEach(() => {
  __resetStructuredModeMemoForTests()
  vi.doUnmock('openai')
})

/** An SDK-shaped rejection: status on the error, as the OpenAI client sets it. */
function httpError(status: number, message = 'Bad Request'): Error & { status: number } {
  return Object.assign(new Error(`${status} ${message}`), { status })
}

/** Fake client that fails the first `failures` calls with `err`, then answers. */
function fakeClient(opts: { failWith?: Error; failures?: number; answer?: string }): {
  client: OpenAILike
  bodies: Array<Record<string, unknown>>
} {
  const bodies: Array<Record<string, unknown>> = []
  let calls = 0
  const client: OpenAILike = {
    chat: {
      completions: {
        create: async (body) => {
          bodies.push(body as Record<string, unknown>)
          calls += 1
          if (opts.failWith && calls <= (opts.failures ?? 0)) throw opts.failWith
          return { choices: [{ message: { content: opts.answer ?? '{"ok":true}' } }] }
        }
      }
    }
  }
  return { client, bodies }
}

const PROMPT = { system: 'SYS', user: 'USR' }

function modeOf(body: Record<string, unknown>): string {
  const rf = body.response_format as { type?: string } | undefined
  return rf?.type ?? 'none'
}

describe('structured-output downgrade ladder', () => {
  it('walks json_schema → json_object → none as the server refuses each', async () => {
    const { client, bodies } = fakeClient({ failWith: httpError(400), failures: 2 })
    const transport = buildOpenAITransport(client, 'local-model', {
      modes: OPENAI_COMPAT_MODES
    })

    const res = await transport(PROMPT)

    expect(res.rawText).toBe('{"ok":true}')
    expect(bodies.map(modeOf)).toEqual(['json_schema', 'json_object', 'none'])
    // The last rung must carry no response_format at all.
    expect(bodies[2].response_format).toBeUndefined()
  })

  it('sends the schema IN THE PROMPT for every non-strict rung', async () => {
    // The prompt never contained the schema — it lived only inside
    // response_format. Downgrading without this asks the model to match
    // something it was never shown, and also covers servers that silently
    // IGNORE an unknown response_format and answer 200 with prose.
    const { client, bodies } = fakeClient({ failWith: httpError(400), failures: 2 })
    const transport = buildOpenAITransport(client, 'local-model', { modes: OPENAI_COMPAT_MODES })

    await transport(PROMPT)

    const userText = (i: number): string => {
      const messages = bodies[i].messages as Array<{ role: string; content: string }>
      return messages.find((m) => m.role === 'user')!.content
    }
    expect(userText(0)).toBe('USR')
    expect(userText(1)).toContain('<schema>')
    expect(userText(2)).toContain('<schema>')
    expect(userText(2)).toContain('"additionalProperties":false')
  })

  it('keeps the default single-rung behaviour for the fixed providers', async () => {
    // OpenAI/OpenRouter rejecting json_schema means the MODEL cannot do it, and
    // the error copy already says "pick another model". Degrading there would
    // turn a crisp config error into a slower, worse run.
    const { client, bodies } = fakeClient({ failWith: httpError(400), failures: 1 })
    const transport = buildOpenAITransport(client, 'gpt-4o-mini')

    await expect(transport(PROMPT)).rejects.toThrow('400')
    expect(bodies).toHaveLength(1)
  })

  it('does not downgrade on causes that are not capability limits', async () => {
    for (const err of [
      httpError(401, 'Incorrect API key provided'),
      httpError(403, 'forbidden'),
      httpError(429, 'rate limit exceeded'),
      httpError(404, 'model_not_found'),
      httpError(500, 'internal error'),
      new Error('ECONNREFUSED 127.0.0.1:1234'),
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    ]) {
      const { client, bodies } = fakeClient({ failWith: err, failures: 3 })
      const transport = buildOpenAITransport(client, 'local-model', { modes: OPENAI_COMPAT_MODES })
      await expect(transport(PROMPT)).rejects.toThrow()
      expect(bodies, String(err.message)).toHaveLength(1)
    }
  })

  it('treats an OPAQUE 400 as a downgrade signal — the corporate-gateway case', async () => {
    expect(isUnsupportedStructuredOutputError(httpError(400, 'Bad Request'))).toBe(true)
    expect(isUnsupportedStructuredOutputError(httpError(422, ''))).toBe(true)
    expect(isUnsupportedStructuredOutputError(httpError(400, 'context_length exceeded'))).toBe(
      false
    )
  })

  it('honours an abort mid-ladder instead of buying the remaining rungs', async () => {
    const controller = new AbortController()
    const { client, bodies } = fakeClient({ failWith: httpError(400), failures: 3 })
    const transport = buildOpenAITransport(client, 'local-model', { modes: OPENAI_COMPAT_MODES })

    const pending = transport(PROMPT, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
    // At most the in-flight request; never a fresh rung after the cancel.
    expect(bodies.length).toBeLessThanOrEqual(1)
  })

  it('downgrades once on an EMPTY completion (reasoning models leave content blank)', async () => {
    const bodies: Array<Record<string, unknown>> = []
    let calls = 0
    const client: OpenAILike = {
      chat: {
        completions: {
          create: async (body) => {
            bodies.push(body as Record<string, unknown>)
            calls += 1
            return { choices: [{ message: { content: calls === 1 ? '' : '{"ok":true}' } }] }
          }
        }
      }
    }
    const transport = buildOpenAITransport(client, 'qwen3', {
      modes: OPENAI_COMPAT_MODES,
      downgradeOnEmpty: true
    })

    const res = await transport(PROMPT)

    expect(res.rawText).toBe('{"ok":true}')
    expect(bodies.map(modeOf)).toEqual(['json_schema', 'json_object'])
  })
})

describe('the per-endpoint memo', () => {
  it('pays the discovery cost once, not once per map-reduce chunk', async () => {
    const { client, bodies } = fakeClient({ failWith: httpError(400), failures: 1 })
    const memoKey = clipsMemoKey('http://localhost:1234/v1', 'local-model')
    const transport = buildOpenAITransport(client, 'local-model', {
      modes: OPENAI_COMPAT_MODES,
      memoKey
    })

    await transport(PROMPT) // rung 1 refused, rung 2 answers
    expect(bodies.map(modeOf)).toEqual(['json_schema', 'json_object'])

    await transport(PROMPT) // chunk 2 must start where chunk 1 ended up
    expect(bodies.map(modeOf)).toEqual(['json_schema', 'json_object', 'json_object'])
    expect(resolvedStructuredMode(memoKey)).toBe('json_object')
  })

  it('raises the floor even when the whole ladder fails', async () => {
    // A first chunk that exhausts the ladder still teaches the second one where
    // to start — otherwise a doomed run re-probes on every chunk.
    const failing = fakeClient({ failWith: httpError(400), failures: 99 })
    const memoKey = clipsMemoKey('http://localhost:9999/v1', 'local-model')
    const transport = buildOpenAITransport(failing.client, 'local-model', {
      modes: OPENAI_COMPAT_MODES,
      memoKey
    })

    await expect(transport(PROMPT)).rejects.toThrow()
    expect(failing.bodies.map(modeOf)).toEqual(['json_schema', 'json_object', 'none'])

    await expect(transport(PROMPT)).rejects.toThrow()
    expect(failing.bodies.map(modeOf).slice(3)).toEqual(['none'])
  })

  it('is keyed by endpoint AND model — two servers never share a verdict', async () => {
    const a = fakeClient({ failWith: httpError(400), failures: 1 })
    const b = fakeClient({})
    const keyA = clipsMemoKey('http://localhost:1234/v1', 'llama-3.1-8b')
    const keyB = clipsMemoKey('http://localhost:4321/v1', 'llama-3.1-8b')
    expect(keyA).not.toBe(keyB)

    await buildOpenAITransport(a.client, 'llama-3.1-8b', {
      modes: OPENAI_COMPAT_MODES,
      memoKey: keyA
    })(PROMPT)
    await buildOpenAITransport(b.client, 'llama-3.1-8b', {
      modes: OPENAI_COMPAT_MODES,
      memoKey: keyB
    })(PROMPT)

    expect(resolvedStructuredMode(keyA)).toBe('json_object')
    expect(resolvedStructuredMode(keyB)).toBe('json_schema')
  })

  it('normalizes the endpoint, so a trailing slash is not a second entry', () => {
    expect(clipsMemoKey('http://localhost:1234/v1/', 'm')).toBe(
      clipsMemoKey('http://localhost:1234/v1', 'm')
    )
  })
})

describe('createTransport: the custom provider', () => {
  async function ctorFor(apiKey: string | null): Promise<Record<string, unknown>> {
    const ctorCalls: Array<Record<string, unknown>> = []
    vi.doMock('openai', () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn(async () => ({ choices: [{ message: { content: '{}' } }] }))
          }
        }
        constructor(opts: Record<string, unknown>) {
          ctorCalls.push(opts)
        }
      }
    }))
    await createTransport({
      provider: 'custom',
      model: 'local-model',
      apiKey,
      baseUrl: 'http://localhost:1234/v1/'
    })
    return ctorCalls[0]
  }

  it('sends NO Authorization header when the endpoint needs no key', async () => {
    const opts = await ctorFor(null)
    // Nulling the header is the SDK's supported "omit auth" mechanism. The
    // placeholder key matters just as much: '' throws "Missing credentials", and
    // `undefined` makes the SDK read process.env.OPENAI_API_KEY — which would
    // send the user's REAL OpenAI key to whatever host they typed.
    expect((opts.defaultHeaders as Record<string, unknown>).Authorization).toBeNull()
    expect(opts.apiKey).toBeTruthy()
    expect(opts.apiKey).not.toBe('')
  })

  it('uses the saved key when there is one, and sets no header override', async () => {
    const opts = await ctorFor('sk-local-abc')
    expect(opts.apiKey).toBe('sk-local-abc')
    expect(opts.defaultHeaders).toBeUndefined()
  })

  it('normalizes the base URL and refuses redirects and silent retries', async () => {
    const opts = await ctorFor('sk-local-abc')
    expect(opts.baseURL).toBe('http://localhost:1234/v1')
    expect(opts.maxRetries).toBe(0)
    expect((opts.fetchOptions as { redirect?: string }).redirect).toBe('error')
  })

  it('refuses to build without a base URL rather than posting somewhere default', async () => {
    await expect(
      createTransport({ provider: 'custom', model: 'local-model', apiKey: null })
    ).rejects.toThrow(/Base URL/i)
  })
})

describe('preconditions the ladder relies on', () => {
  it('keeps the word JSON in the system prompt — json_object mode requires it', () => {
    expect(/json/i.test(SYSTEM_PROMPT)).toBe(true)
  })

  it('drops a reasoning preamble before hunting for the JSON object', () => {
    // Qwen3/R1-class models are the LM Studio default; a brace inside their
    // preamble otherwise sends the outermost-{...} scan to the wrong place and
    // burns the one repair round-trip.
    const raw = '<think>maybe {not this} first</think>\n{"clips":[]}'
    expect(extractJsonCandidate(raw)).toBe('{"clips":[]}')
  })
})
