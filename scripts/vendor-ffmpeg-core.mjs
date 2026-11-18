/**
 * Copy the ffmpeg.wasm single-thread core from node_modules into the web public
 * directory so the browser loads it from the same origin (no CDN, no internet at
 * runtime). `npm run vendor:ffmpeg` is run by the web build and by the Docker image.
 *
 * The generated files are git-ignored; they are a build artifact.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const rootDir = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(rootDir, 'src', 'renderer', 'public', 'ffmpeg')

async function resolveCoreDir() {
  const candidates = []
  try {
    candidates.push(path.dirname(require.resolve('@ffmpeg/core')))
  } catch {
    // `@ffmpeg/core` only exports "." and "./wasm"; fall back to a direct path lookup.
  }
  candidates.push(path.join(rootDir, 'node_modules', '@ffmpeg', 'core', 'dist', 'umd'))

  for (const candidate of candidates) {
    for (const dir of [candidate, path.join(candidate, '..', 'esm')]) {
      try {
        const info = await stat(path.join(dir, 'ffmpeg-core.wasm'))
        if (info.size > 0) return dir
      } catch {
        // try the next candidate
      }
    }
  }
  throw new Error('未找到 @ffmpeg/core，请先执行 npm install')
}

const srcDir = await resolveCoreDir()
await mkdir(outDir, { recursive: true })

for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  const target = path.join(outDir, name)
  await copyFile(path.join(srcDir, name), target)
  const info = await stat(target)
  console.log(`[vendor:ffmpeg] ${name} -> src/renderer/public/ffmpeg (${Math.round(info.size / 1024 / 1024)}MB)`)
}