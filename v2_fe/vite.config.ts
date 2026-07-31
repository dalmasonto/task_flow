import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import fs from 'node:fs'

/// #106: hot-updating a huge module leaks the dev tab to death. Chrome retains
/// every evaluated version of a module — source, inline base64 sourcemap and
/// compiled code are never released until a real navigation — so each save of
/// App.tsx (~450 KB source) permanently costs the open :5173 tab ~3.2 MB of JS
/// heap / ~10 MB RSS (measured over 40 updates: +127 MB heap, +394 MB RSS).
/// An agent editing the repo for a day walks a background dev tab into the
/// multi-GB "High memory usage" state. A full reload drops the old document
/// and returns the renderer to baseline, so for oversized modules it is the
/// cheaper trade: state loss on save vs unbounded growth. Small modules keep
/// normal HMR — their retained versions are noise.
const FULL_RELOAD_OVER_BYTES = 200_000

function fullReloadForHugeModules(): Plugin {
  return {
    name: 'full-reload-for-huge-modules',
    handleHotUpdate({ file, server }) {
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {
        return
      }
      if (size < FULL_RELOAD_OVER_BYTES) return
      server.ws.send({ type: 'full-reload' })
      // Returning an empty module list suppresses the HMR update itself.
      return []
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [fullReloadForHugeModules(), react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
      },
      '/oauth': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
      },
      '/media': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
      },
      '/openapi': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
      },
      '/realtime': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
