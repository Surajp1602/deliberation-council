// Writes the schemas embedded in workflows/deliberate.js to schemas/*.json, so
// scripts/council_ledger.py validates entries against exactly what the workflow
// enforces. Run after changing a schema:  node tests/export_schemas.mjs
// With --check it fails if the files are out of date (the test suite does this).

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConstants } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'schemas')
const C = loadConstants()
const files = {
  'entry.schema.json': C.ENTRY_SCHEMA,
  'ruling.schema.json': C.RULING_SCHEMA,
  'synthesis.schema.json': C.SYNTH_SCHEMA,
  'audit.schema.json': C.AUDIT_SCHEMA,
}

const check = process.argv.includes('--check')
const stale = []
mkdirSync(out, { recursive: true })
for (const [name, schema] of Object.entries(files)) {
  const body = JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `council/${name}`, ...schema }, null, 2) + '\n'
  const path = join(out, name)
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== body) stale.push(name)
  } else {
    writeFileSync(path, body)
  }
}
if (check && stale.length) {
  console.error(`schemas out of date: ${stale.join(', ')} (run node tests/export_schemas.mjs)`)
  process.exit(1)
}
if (!check) console.log(`wrote ${Object.keys(files).length} schemas to ${out}`)
