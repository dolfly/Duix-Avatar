/**
 * Copy the ffmpeg.wasm single-thread core from node_modules into the web public
 * directory so the browser loads it from the same origin (no CDN, no internet at
 * runtime). `npm run vendor:ffmpeg` is run by the web build and by the Docker image.
 *
 * The generated files are git-ignored; they are a build artifact.
 */
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const rootDir = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(rootDir, 'src', 'renderer', 'public', 'ffmpeg')

/**
 * The browser loads the core inside a *module* worker (`@ffmpeg/ffmpeg` does
 * `await import(coreURL).default`), so the vendored file MUST be the ESM build
 * (`export default createFFmpegCore`). The UMD build ends with
 * `exports["createFFmpegCore"] = createFFmpegCore` and has no default export,
 * which surfaces to users as "failed to import ffmpeg-core.js".
 */
async function resolveCoreDir() {
  const candidates = []
  try {
    // `require.resolve('@ffmpeg/core')` resolves the package `main` (dist/umd);
    // derive the package root from it and prefer the sibling ESM build.
    const umdDir = path.dirname(require.resolve('@ffmpeg/core'))
    candidates.push(path.join(umdDir, '..', 'esm'))
  } catch {
    // `@ffmpeg/core` only exports "." and "./wasm"; fall back to a direct path lookup.
  }
  candidates.push(path.join(rootDir, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm'))

  for (const dir of candidates) {
    if (!(await isCoreDir(dir))) continue
    const js = await readFile(path.join(dir, 'ffmpeg-core.js'), 'utf8')
    if (!/export\s+default/.test(js)) {
      throw new Error(
        `${dir} 不是 ESM 构建（ffmpeg-core.js 缺少 export default），拒绝 vendoring UMD 版`
      )
    }
    return dir
  }
  throw new Error('未找到 @ffmpeg/core 的 ESM 构建（dist/esm），请先执行 npm install')
}

async function isCoreDir(dir) {
  try {
    const info = await stat(path.join(dir, 'ffmpeg-core.wasm'))
    return info.size > 0
  } catch {
    return false
  }
}

/**
 * The local core URLs in `ffmpeg.js` must carry the core version as a `?v=`
 * cache-busting query. nginx serves them as `immutable`, and a CDN (EdgeOne)
 * would otherwise keep feeding old browsers the previously cached core for up to
 * a year — so a fix that only swaps the vendored file would never reach users
 * who already loaded the old build. Fail the build if the version param is gone.
 */
async function assertVersionedCoreUrl() {
  const ffmpegJs = path.join(rootDir, 'src', 'renderer', 'src', 'client', 'ffmpeg.js')
  const src = await readFile(ffmpegJs, 'utf8')
  for (const needle of [
    'ffmpeg-core.js?v=${CORE_VERSION}',
    'ffmpeg-core.wasm?v=${CORE_VERSION}'
  ]) {
    if (!src.includes(needle)) {
      throw new Error(
        `src/renderer/src/client/ffmpeg.js 的本地 core URL 必须带版本参数（缺少 "${needle}"），不要去掉 ?v=`
      )
    }
  }
}

await assertVersionedCoreUrl()
const srcDir = await resolveCoreDir()
await mkdir(outDir, { recursive: true })

for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  const target = path.join(outDir, name)
  await copyFile(path.join(srcDir, name), target)
  const info = await stat(target)
  console.log(`[vendor:ffmpeg] ${name} -> src/renderer/public/ffmpeg (${Math.round(info.size / 1024 / 1024)}MB)`)
}
