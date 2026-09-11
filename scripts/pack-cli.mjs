/**
 * Build a self-contained, publishable npm package for the `janus` CLI.
 *
 * Why a bundle: `packages/cli` depends on the other `packages/*` workspaces
 * via `file:` specifiers, which are NOT installable from a registry. Bundling
 * collapses every workspace + third-party dependency into one ESM file, so the
 * packed tarball has zero runtime dependencies and installs with plain
 * `npm install -g <tgz>` (Node >= 22 only).
 *
 * Layout:
 *   release/janus-cli/            staging dir (generated, git-ignored)
 *     janus.js                    bundled CLI (bin)
 *     package.json                publishable metadata (no file: deps)
 *     LICENSE / README.md / README.en.md
 *   release/janus-agent-cli-<ver>.tgz
 *     `npm pack` output (the actual installable artifact)
 *
 * Bundler choice: Rollup (from the already-compiled `packages/cli/dist`,
 * so no TS/JSX handling is needed here). esbuild was tried first but cannot
 * emit ESM for CJS deps with conditional `require(builtin)` (e.g.
 * `signal-exit`, `@vercel/oidc`): they fall into its `__require` shim island
 * and throw `Dynamic require of "assert" is not supported` at load time.
 * Rollup's commonjs plugin hoists those requires into real imports.
 * (CJS output is not an option either: Ink and yoga-layout use top-level
 * await, which esbuild cannot emit as CJS.)
 *
 * One dependency quirk is handled explicitly: Ink's DEV-only
 * `./devtools.js` is marked external. Its opt-in peer `react-devtools-core`
 * is deliberately not installed; the branch is unreachable without DEV=true
 * and ink's own try/catch skips it when the peer is absent.
 *
 * Usage: `npm run pack:cli` (runs `npm run build` first).
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = join(root, 'packages', 'cli')
const releaseDir = join(root, 'release')
const stageDir = join(releaseDir, 'janus-cli')

function fail(message) {
  console.error(`pack:cli: ${message}`)
  process.exit(1)
}

const cliPkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'))

// The `janus version` string must never drift from the published version.
const versionSource = readFileSync(join(cliDir, 'src', 'version.ts'), 'utf8')
const versionMatch = versionSource.match(/CLI_VERSION\s*=\s*['"]([^'"]+)['"]/)
if (!versionMatch) fail('packages/cli/src/version.ts does not export CLI_VERSION')
if (versionMatch[1] !== cliPkg.version) {
  fail(`version drift: src/version.ts is ${versionMatch[1]} but package.json is ${cliPkg.version}`)
}
if (!cliPkg.license) fail('packages/cli/package.json has no license field')
for (const file of ['LICENSE', 'README.md', 'README.en.md']) {
  if (!existsSync(join(root, file))) fail(`missing ${file} at repo root (needed for the packed tarball)`)
}
const distEntry = join(cliDir, 'dist', 'cli.js')
if (!existsSync(distEntry)) fail('packages/cli/dist/cli.js is missing (run `npm run build` first)')

mkdirSync(stageDir, { recursive: true })

console.log('pack:cli: bundling packages/cli/dist/cli.js ...')
const { rollup } = await import('rollup')
const { default: nodeResolve } = await import('@rollup/plugin-node-resolve')
const { default: commonjs } = await import('@rollup/plugin-commonjs')
const { default: json } = await import('@rollup/plugin-json')
const bundle = await rollup({
  input: distEntry,
  external: (id, importer) => {
    const norm = id.replace(/\\/g, '/')
    // Resolved absolute path …
    if (norm.endsWith('ink/build/devtools.js')) return true
    // …or the unresolved relative specifier straight from ink's reconciler
    // (Rollup consults `external` before resolving dynamic imports).
    if (norm === './devtools.js' && (importer || '').replace(/\\/g, '/').includes('node_modules/ink/build/')) {
      return true
    }
    return false
  },
  plugins: [nodeResolve({ preferBuiltins: true }), commonjs(), json()],
  onwarn: (warning, defaultHandler) => {
    // `ai`/`@ai-sdk` ship harmless circular re-exports; keep the log readable.
    if (warning.code === 'CIRCULAR_DEPENDENCY') return
    defaultHandler(warning)
  },
})
const outFile = join(stageDir, 'janus.js')
// Single file: the only remaining dynamic imports are lazy `import()`s inside
// functions the CLI never calls (`getVercelOidcToken`, ink DEV branch — the
// latter stays external, see above). Their modules are side-effect-free at
// import time (function defs + requires), so eager inlining is behavior-safe.
await bundle.write({ file: outFile, format: 'esm', inlineDynamicImports: true })
await bundle.close()

// Exactly one shebang, on line 1: tsc preserves the entry shebang and the
// bundler may or may not re-emit it — normalize instead of guessing.
const bundled = readFileSync(outFile, 'utf8').split('\n').filter((line) => !line.startsWith('#!'))
writeFileSync(outFile, `#!/usr/bin/env node\n${bundled.join('\n')}`)
try {
  chmodSync(outFile, 0o755)
} catch {
  // Non-POSIX filesystems (Windows ACLs) ignore chmod; npm still shims bin.
}

const stagePkg = {
  name: cliPkg.name,
  version: cliPkg.version,
  description: cliPkg.description,
  type: 'module',
  license: cliPkg.license,
  bin: { janus: './janus.js' },
  ...(cliPkg.engines ? { engines: cliPkg.engines } : {}),
  ...(cliPkg.repository ? { repository: cliPkg.repository } : {}),
  keywords: ['ai', 'agent', 'cli', 'coding-assistant', 'openai-compatible'],
}
writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(stagePkg, null, 2)}\n`)
for (const file of ['LICENSE', 'README.md', 'README.en.md']) {
  copyFileSync(join(root, file), join(stageDir, file))
}

console.log('pack:cli: running npm pack ...')
// Invoke npm through the current Node (no shell): resolves on Windows
// (npm.cmd) and POSIX alike without shell-quoting noise.
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
if (!existsSync(npmCli)) fail(`cannot locate npm-cli.js next to ${process.execPath}`)
const packOutput = execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', releaseDir], {
  cwd: stageDir,
  encoding: 'utf8',
}).trim()
const tgzName = packOutput.split('\n').pop().trim()
console.log(`pack:cli: done -> release/${tgzName}`)
console.log(`pack:cli: install with: npm install -g ./release/${tgzName}`)
