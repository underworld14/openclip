import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The renderer specs (FEAT-26tkya) are .tsx. `automatic` matches the runtime the
  // app itself is built with (tsconfig's "jsx": "react-jsx"), so a spec never needs
  // to import React just to use JSX — and never diverges from how the component
  // compiles in the real bundle.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src'),
      '@preload': resolve('src/preload')
    }
  },
  test: {
    // `node` stays the DEFAULT: the bulk of the suite is main-process and pure
    // view-model code, and a jsdom global setup would tax every one of those files
    // for nothing. Renderer specs that need a DOM opt in per file with a
    //   // @vitest-environment jsdom
    // docblock on line 1 (FEAT-26tkya). See tests/unit/renderer-harness.spec.tsx.
    environment: 'node',
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}'],
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
