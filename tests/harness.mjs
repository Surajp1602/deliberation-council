// Test harness for workflows/deliberate.js.
//
// Runs the workflow script outside Claude Code with stubbed runtime globals
// (agent, parallel, pipeline, phase, log, args, budget) and the restrictions the
// real runtime applies (no Date.now, no Math.random, no argument-less Date).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const WORKFLOW = join(here, '..', 'workflows', 'deliberate.js')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function source() {
  const src = readFileSync(WORKFLOW, 'utf8')
  if (/\bimport\s*\(/.test(src) || /^\s*import\s/m.test(src)) throw new Error('workflow scripts cannot import modules')
  return src.replace(/^export const meta\s*=/m, 'const meta =')
}

function strictDate() {
  function D(...a) {
    if (!a.length) throw new Error('new Date() without arguments is not allowed in workflows')
    return new Date(...a)
  }
  D.now = () => {
    throw new Error('Date.now() is not allowed in workflows')
  }
  return D
}

function strictMath() {
  const M = Object.create(Math)
  M.random = () => {
    throw new Error('Math.random() is not allowed in workflows')
  }
  return M
}

// Like the runtime: a thunk that throws resolves to null, and the call never rejects.
const defaultParallel = (thunks) => Promise.all(thunks.map((t) => {
  try {
    return Promise.resolve(t()).catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}))

export const NO_TOKEN_TARGET = { total: null, spent: () => 0, remaining: () => Infinity }

export async function runWorkflow(env) {
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'Date', 'Math', source())
  const pipeline = env.pipeline || (async (items, ...stages) => Promise.all(items.map(async (it) => {
    let v = it
    for (const s of stages) v = await s(v, it)
    return v
  })))
  return fn(env.agent, env.parallel || defaultParallel, pipeline, env.phase || (() => {}), env.log || (() => {}),
    env.args, env.budget || NO_TOKEN_TARGET, strictDate(), strictMath())
}

// Evaluate only the constant section (meta, seats, tiers, schemas).
export function loadConstants() {
  const src = source()
  const cut = src.indexOf('// Arguments and budget')
  if (cut < 0) throw new Error('could not find the "// Arguments and budget" marker in the workflow')
  const head = src.slice(0, src.lastIndexOf('// ---', cut))
  const fn = new Function(head + '\nreturn { meta, SEATS, TIERS, ENTRY_SCHEMA, RULING_SCHEMA, SYNTH_SCHEMA, AUDIT_SCHEMA }')
  return fn()
}
