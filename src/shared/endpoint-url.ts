/**
 * src/shared/endpoint-url.ts — validation and normalization for the ONE
 * user-supplied AI endpoint (the `custom` provider, FEAT-bysdwg).
 *
 * WHY THIS IS A SHARED MODULE. The same string is consumed in three places that
 * must agree exactly: the Zod refine on `Settings.baseUrl` (persistence), the
 * OpenAI SDK's `baseURL` (chat completions), and `${base}/models` (discovery).
 * Two independent joins is how you get a Test button that passes against one URL
 * while Generate quietly posts to another.
 *
 * NO `/v1` GUESSING. LM Studio, vLLM and Groq all want a base ending in `/v1`;
 * LiteLLM does not. `baseUrl` is DEFINED as the root the SDK appends
 * `/chat/completions` to, so normalization strips trailing slashes and nothing
 * else. When discovery 404s we SUGGEST the `/v1` variant in the error copy —
 * suggesting is honest, silently retrying would make the stored URL and the
 * working URL disagree.
 *
 * NO SSRF ALLOW-LIST. `http://localhost:1234/v1` is the primary use case, so
 * blocking loopback or RFC1918 would block the feature. The real hazard —
 * someone OTHER than the user choosing where their key goes — is closed by
 * resolving `baseUrl` main-side from settings (PRD §12.2), never from a renderer
 * payload. What IS rejected here is the narrow set that can only be a mistake or
 * a trap: non-http(s) schemes, credentials in the URL (they would persist in
 * plaintext `settings.json` and leak into error copy), query/fragment (they
 * break both path joins), and the cloud metadata addresses.
 */

/** Trailing-slash-only normalization. `undefined` for blank input. */
export function normalizeBaseUrl(raw?: string | null): string | undefined {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : undefined
}

function parse(raw?: string | null): URL | null {
  const normalized = normalizeBaseUrl(raw)
  if (!normalized) return null
  try {
    return new URL(normalized)
  } catch {
    return null
  }
}

/**
 * Cloud instance-metadata endpoints. Reachable from any machine inside the
 * provider's network and unauthenticated by design, so a base URL pointed at one
 * turns "fetch my model list" into a credential read. Cheap to refuse; nobody
 * runs an OpenAI-compatible server there.
 */
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'fd00:ec2::254'])

function isMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return METADATA_HOSTS.has(host) || host.startsWith('169.254.')
}

/** localhost / 127.0.0.0/8 / ::1 — the case this whole feature exists for. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}

/** RFC1918 + mDNS — "my own network", where plain HTTP is a normal choice. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  const match = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (match) {
    const second = Number(match[1])
    return second >= 16 && second <= 31
  }
  return false
}

/**
 * Is this a base URL we are willing to persist and send an API key to?
 *
 * Deliberately permissive about WHERE (loopback, LAN and public hosts all pass)
 * and strict about SHAPE.
 */
export function isSafeEndpointUrl(raw: string): boolean {
  const url = parse(raw)
  if (!url) return false
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!url.hostname) return false
  // Credentials in the URL would be written to settings.json in plaintext and
  // echoed by any code that renders the endpoint. The key belongs in safeStorage.
  if (url.username || url.password) return false
  // `${base}/models` and the SDK's `${base}/chat/completions` both append a path
  // segment; a query or fragment silently lands in the wrong place.
  if (url.search || url.hash) return false
  if (isMetadataHost(url.hostname)) return false
  return true
}

/**
 * Plain HTTP to somewhere that is NOT this machine or this LAN — the key would
 * cross a network in cleartext. Not blocked (a gateway on a trusted VPN is
 * legitimate), but the user is told.
 */
export function isInsecureHttpEndpoint(raw?: string | null): boolean {
  const url = parse(raw)
  if (!url || url.protocol !== 'http:') return false
  return !isLoopbackHost(url.hostname) && !isPrivateHost(url.hostname)
}

/**
 * `host:port` for user-facing copy. NEVER the full URL: error strings are
 * rendered in the UI and a path can carry things a host cannot.
 */
export function safeHost(raw?: string | null): string {
  return parse(raw)?.host ?? ''
}

/**
 * Identity of an endpoint for binding a stored API key to it (FEAT-bysdwg).
 *
 * ORIGIN, not the full URL: adding or removing the `/v1` suffix is the single
 * most common edit a user makes while getting an endpoint working, and it must
 * not invalidate the key they just pasted. Changing host or port, on the other
 * hand, means the key is now for a different server.
 */
export function endpointFingerprint(raw?: string | null): string {
  return parse(raw)?.origin.toLowerCase() ?? ''
}
