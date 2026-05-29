// build/notarize.cjs — electron-builder `afterSign` hook (PRD §15).
//
// Notarizes the freshly-signed .app via @electron/notarize, but ONLY when Apple
// credentials are present in the environment. With no credentials it logs a
// "skipping" line and returns, so an unsigned/dev `electron-builder` run still
// completes the dmg (we never fake or invent credentials).
//
// Two credential strategies are honored (App Store Connect API key preferred):
//   1) App Store Connect API key:
//        APPLE_API_KEY        — filesystem path to the AuthKey_XXXX.p8
//        APPLE_API_KEY_ID     — the Key ID (e.g. T9GPZ92M7K)
//        APPLE_API_ISSUER     — the Issuer UUID
//   2) Apple ID + app-specific password:
//        APPLE_ID             — Apple Developer account email
//        APPLE_APP_SPECIFIC_PASSWORD (or APPLE_ID_PASSWORD) — app-specific password
//        APPLE_TEAM_ID        — Developer Team ID
//
// Only runs for macOS targets; other platforms short-circuit.

const { existsSync } = require('node:fs')

/** Resolve a notarization credential set from env, or null if none configured. */
function resolveCredentials(env) {
  const apiKey = env.APPLE_API_KEY
  const apiKeyId = env.APPLE_API_KEY_ID
  const apiIssuer = env.APPLE_API_ISSUER
  if (apiKey && apiKeyId && apiIssuer) {
    return {
      kind: 'api-key',
      creds: { appleApiKey: apiKey, appleApiKeyId: apiKeyId, appleApiIssuer: apiIssuer }
    }
  }

  const appleId = env.APPLE_ID
  const appleIdPassword = env.APPLE_APP_SPECIFIC_PASSWORD || env.APPLE_ID_PASSWORD
  const teamId = env.APPLE_TEAM_ID
  if (appleId && appleIdPassword && teamId) {
    return {
      kind: 'apple-id',
      creds: { appleId, appleIdPassword, teamId }
    }
  }

  return null
}

exports.default = async function notarizeHook(context) {
  const { electronPlatformName, appOutDir } = context

  if (electronPlatformName !== 'darwin') {
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  const resolved = resolveCredentials(process.env)
  if (!resolved) {
    console.log('[notarize] skipping notarization (no credentials)')
    return
  }

  if (!existsSync(appPath)) {
    console.log(`[notarize] skipping notarization (app not found at ${appPath})`)
    return
  }

  // Lazy require so a `--dir` / no-creds build never needs the dependency loaded.
  const { notarize } = require('@electron/notarize')

  console.log(`[notarize] notarizing ${appPath} via ${resolved.kind} credentials…`)
  await notarize({ appPath, ...resolved.creds })
  console.log('[notarize] notarization complete')
}
