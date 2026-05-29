import { defineConfig } from '@playwright/test'

/**
 * Thin Electron E2E (plan §18 / E.6): launch → import → transcribe (stubbed) →
 * generate clips (mocked) → export. Specs are integration-owned and land later;
 * this config wires `npm run test:e2e` from day one.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000
})
