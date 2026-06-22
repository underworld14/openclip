import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src'),
      '@preload': resolve('src/preload')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.{test,spec}.ts'],
    // Real-binary (ffmpeg/whisper) suites carry a `@serial` name tag and are
    // run single-file (machine-global lock) per plan E.7; mocked unit tests
    // run in parallel.
    globals: true,
    // The @serial real-binary smokes wait on a machine-global lock and THEN run ffmpeg,
    // so the default 5s timeout (which doesn't account for lock-wait) flaked them under
    // contention (audit fix openclip-lzk). Mocked unit tests finish in ms, so a higher
    // ceiling only gives the serial smokes headroom; it never slows the common case.
    testTimeout: 20000
  }
})
