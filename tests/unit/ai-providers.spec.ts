/**
 * tests/unit/ai-providers.spec.ts — the 3-provider structured-output adapters
 * (PRD §10.3 / plan Part B). ONE Zod schema (frozen ClipSchema) adapted to:
 *   - OpenAI:    response_format json_schema { strict:true, schema } (derived)
 *   - Anthropic: client.messages.parse + zodOutputFormat(ClipSchema)
 *   - Ollama:    format = z.toJSONSchema(ClipSchema)
 *
 * Each adapter is given an INJECTED fake SDK client (no network). We assert the
 * request shape each provider sends, and that each returns the raw text the
 * repair ladder consumes.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  buildOpenAITransport,
  buildAnthropicTransport,
  buildOllamaTransport,
  clipJsonSchema,
  createTransport,
  OPENROUTER_BASE_URL,
  OPENROUTER_APP_TITLE
} from '@main/services/ai-client'
import { ClipSchema } from '@shared/schema'
import { clipSchemaFixture } from '../fixtures/contract'

const PROMPT = { system: 'SYS', user: 'USR' }

describe('clipJsonSchema (Zod 4 → JSON Schema, OpenAI strict + Ollama format)', () => {
  it('derives additionalProperties:false with all-required from ClipSchema', () => {
    const schema = clipJsonSchema() as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect((schema.required as string[]).sort()).toEqual(['analysis', 'clips'])
  })

  it('equals z.toJSONSchema(ClipSchema) (single source of truth)', () => {
    expect(clipJsonSchema()).toEqual(z.toJSONSchema(ClipSchema))
  })
})

describe('OpenAI adapter', () => {
  it('uses response_format json_schema strict and returns the message content', async () => {
    const create = vi.fn<(body: unknown) => Promise<{ choices: unknown[] }>>(async () => ({
      choices: [{ message: { content: JSON.stringify(clipSchemaFixture) } }]
    }))
    const fakeClient = { chat: { completions: { create } } }
    const transport = buildOpenAITransport(fakeClient as never, 'gpt-4o-mini')

    const { rawText } = await transport(PROMPT)
    expect(JSON.parse(rawText).clips[0].title).toBe(clipSchemaFixture.clips[0].title)

    const arg = create.mock.calls[0][0] as Record<string, unknown>
    const rf = arg.response_format as { type: string; json_schema: Record<string, unknown> }
    expect(rf.type).toBe('json_schema')
    expect(rf.json_schema.strict).toBe(true)
    expect(rf.json_schema.name).toBe('clips')
    expect((rf.json_schema.schema as Record<string, unknown>).additionalProperties).toBe(false)
    expect(arg.model).toBe('gpt-4o-mini')
    // system + user messages present
    const messages = arg.messages as Array<{ role: string; content: string }>
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(messages[0].content).toBe('SYS')
    expect(messages[1].content).toBe('USR')
  })
})

describe('Anthropic adapter', () => {
  it('calls messages.parse with output_config.format and returns serialized parsed_output', async () => {
    const parse = vi.fn<(body: unknown) => Promise<{ parsed_output: unknown }>>(async () => ({
      parsed_output: clipSchemaFixture
    }))
    const fakeClient = { messages: { parse } }
    const transport = buildAnthropicTransport(fakeClient as never, 'claude-sonnet-4-5')

    const { rawText } = await transport(PROMPT)
    expect(JSON.parse(rawText).analysis.clips_found).toBe(1)

    const arg = parse.mock.calls[0][0] as Record<string, unknown>
    expect(arg.model).toBe('claude-sonnet-4-5')
    expect(arg.system).toBe('SYS')
    expect(typeof arg.max_tokens).toBe('number')
    // output_config.format is the zodOutputFormat object (truthy, opaque)
    const oc = arg.output_config as { format: unknown }
    expect(oc.format).toBeTruthy()
    const messages = arg.messages as Array<{ role: string; content: string }>
    expect(messages[0]).toEqual({ role: 'user', content: 'USR' })
  })

  it('falls back to text content when parsed_output is absent', async () => {
    const parse = vi.fn(async () => ({
      parsed_output: null,
      content: [{ type: 'text', text: JSON.stringify(clipSchemaFixture) }]
    }))
    const transport = buildAnthropicTransport({ messages: { parse } } as never, 'claude-sonnet-4-5')
    const { rawText } = await transport(PROMPT)
    expect(JSON.parse(rawText).clips).toHaveLength(1)
  })
})

describe('createTransport: OpenRouter (Part H)', () => {
  it('builds an OpenAI client at the OpenRouter base URL with attribution headers', async () => {
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
    const transport = await createTransport({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      apiKey: 'sk-or-XYZ'
    })
    expect(typeof transport).toBe('function')
    expect(ctorCalls).toHaveLength(1)
    expect(ctorCalls[0].baseURL).toBe(OPENROUTER_BASE_URL)
    expect(ctorCalls[0].apiKey).toBe('sk-or-XYZ')
    const headers = ctorCalls[0].defaultHeaders as Record<string, string>
    expect(headers['X-Title']).toBe(OPENROUTER_APP_TITLE)
    expect(headers['HTTP-Referer']).toBeTruthy()
    vi.doUnmock('openai')
  })
})

describe('Ollama adapter', () => {
  it('passes format=<jsonSchema> and stream:false, returns message content', async () => {
    const chat = vi.fn<(body: unknown) => Promise<{ message: { content: string } }>>(async () => ({
      message: { content: JSON.stringify(clipSchemaFixture) }
    }))
    const fakeClient = { chat }
    const transport = buildOllamaTransport(fakeClient as never, 'llama3.1')

    const { rawText } = await transport(PROMPT)
    expect(JSON.parse(rawText).clips[0].virality_score).toBe(9)

    const arg = chat.mock.calls[0][0] as Record<string, unknown>
    expect(arg.model).toBe('llama3.1')
    expect(arg.stream).toBe(false)
    // format is the full JSON schema object, not the string "json"
    expect((arg.format as Record<string, unknown>).additionalProperties).toBe(false)
    const messages = arg.messages as Array<{ role: string; content: string }>
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
  })
})
