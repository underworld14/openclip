import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import eslintPluginImport from 'eslint-plugin-import'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh,
      import: eslintPluginImport
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // Enforce `import type` so cross-track imports never pull in runtime code.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' }
      ],
      // Architectural seams (plan E.4 / E.7): renderer and main are isolated;
      // everyone may import the shared contract, the shared contract imports no one.
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/renderer',
              from: './src/main',
              message:
                'Renderer must not import from main. Cross the boundary via the preload window.openclip bridge.'
            },
            {
              target: './src/renderer',
              from: './src/preload',
              message:
                'Renderer must not import preload internals. Consume the typed bridge surface only.'
            },
            {
              target: './src/main',
              from: './src/renderer',
              message: 'Main must not import from the renderer.'
            },
            {
              target: './src/shared',
              from: ['./src/main', './src/renderer', './src/preload'],
              message:
                'The shared contract (src/shared) must not import from any process; it is the leaf everyone depends on.'
            }
          ]
        }
      ]
    }
  },
  // shadcn/ui generated components are vendored, upstream-maintained code.
  // We do not author them, so relax our project-author conventions here.
  {
    files: ['src/renderer/src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  // Build/packaging tooling (Node scripts + electron-builder CJS hooks). These run
  // outside the app process and are intentionally plain JS/CommonJS — relax the
  // TS-author conventions (return types, no-require) for them only.
  {
    files: ['scripts/**/*.{mjs,cjs,js}', 'build/**/*.{cjs,js,mjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  eslintConfigPrettier
)
