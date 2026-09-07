/**
 * Post-build fix: make tsc-emitted ESM specifiers resolvable by plain Node.
 * Sources stay extensionless (JanusX shell parity); tsc preserves them verbatim,
 * which plain Node ESM cannot resolve. Run after tsc in each package:
 *   node ../../scripts/fix-dist-extensions.mjs dist
 *
 * Rules for extensionless relative specifiers:
 *   ./foo      -> ./foo.js        (when foo.js exists)
 *   ./dir      -> ./dir/index.js  (when dir/index.js exists)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const target = process.argv[2] ?? 'dist'

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (/\.(js|d\.ts)$/.test(entry)) yield path
  }
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.') || /\.[A-Za-z0-9]+$/.test(spec)) return null
  const base = join(dirname(fromFile), spec)
  if (existsSync(`${base}.js`)) return `${spec}.js`
  if (existsSync(join(base, 'index.js'))) return `${spec}/index.js`
  return null
}

let patched = 0
for (const file of walk(target)) {
  const source = readFileSync(file, 'utf8')
  const fixed = source.replace(/(from\s*|import\s*\()\s*(['"])(\.[^'"]*)\2/g, (match, prefix, quote, spec) => {
    const resolved = resolveSpec(file, spec)
    if (!resolved) return match
    patched += 1
    return `${prefix}${quote}${resolved}${quote}`
  })
  if (fixed !== source) writeFileSync(file, fixed)
}
console.log(`fix-dist-extensions: ${patched} specifiers patched under ${target}`)
