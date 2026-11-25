/**
 * Make the bundled CommonJS entry export the plugin object itself.
 *
 * `src/entry.js` ends with `export default plugin`, and esbuild's `--format=cjs`
 * turns that into `module.exports = { default: plugin, __esModule: true }`.
 * Cyrene's host loads a plugin as `require(entry)` and calls `.register(...)`
 * on what it gets back, so the wrapper is one level too deep: the host sees no
 * `register` and the plugin never activates.
 *
 * The previous committed bundle carried a hand-appended line fixing this up.
 * Nothing generated it, so every rebuild silently produced a plugin that
 * loads as `{}` — which is exactly what happened while porting the Trae /
 * Qoder fixes into this repo. This script runs as the last build step so the
 * shape is a property of the build, not of someone remembering.
 *
 * It is idempotent: a bundle that already exports the plugin directly is left
 * untouched.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node fix-exports.mjs <bundle.cjs>')
  process.exit(2)
}

const source = readFileSync(target, 'utf8')
const fixup = 'var __p = module.exports.default; module.exports = __p; module.exports.default = __p;\n'

if (source.includes('var __p = module.exports.default;')) {
  console.log('fix-exports: already applied')
  process.exit(0)
}

// Only rewrite a bundle that actually has the esbuild ESM wrapper; anything
// else means the build configuration changed and this fix-up would corrupt it.
if (!source.includes('var entry_default = plugin;')) {
  console.error('fix-exports: expected esbuild ESM wrapper not found — refusing to patch')
  process.exit(1)
}

writeFileSync(target, `${source.replace(/\s*$/, '\n')}${fixup}`, 'utf8')
console.log('fix-exports: plugin object exported at module level')
