/**
 * Web (browser) build of the renderer.
 *
 * The Electron build keeps using electron.vite.config.mjs; both share the same
 * renderer sources under src/renderer. At runtime `src/renderer/src/client/index.js`
 * picks the Electron bridge or the HTTP/fetch implementation.
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const rendererDir = resolve(rootDir, 'src/renderer')

export default defineConfig({
  root: rendererDir,
  // Vendored by `npm run vendor:ffmpeg` (ffmpeg.wasm core, ~25MB).
  publicDir: resolve(rendererDir, 'public'),
  base: '/',
  resolve: {
    alias: {
      '@renderer': resolve(rendererDir, 'src')
    }
  },
  plugins: [vue()],
  // @ffmpeg/* ships its own ESM worker; pre-bundling it breaks `new Worker(new URL(...))`.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // Local development: the API server from server/ (npm run dev:server).
      '/api': {
        target: process.env.DUIX_API_TARGET || 'http://127.0.0.1:8280',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: resolve(rootDir, 'dist/web'),
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 1500
  }
})