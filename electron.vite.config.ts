import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve('src/shared')
const main = resolve('src/main')
const renderer = resolve('src/renderer/src')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': shared,
        '@main': main
      }
    }
  },
  preload: {
    // The renderer runs sandboxed (PRD §12.2). Sandboxed preload scripts cannot
    // `require` external modules, so the preload MUST be fully bundled — disable
    // dependency externalization here (electron-vite isolated-build guidance).
    build: {
      externalizeDeps: false
    },
    resolve: {
      alias: {
        '@shared': shared,
        '@preload': resolve('src/preload')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': renderer,
        '@shared': shared
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
