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
    globals: true
  }
})
