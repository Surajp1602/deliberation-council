// A fake council for testing workflows/deliberate.js without model calls.
//
// Each fake seat reads the same prompt a real seat gets (mode, entry prefix, round,
// lens, file paths, digest), produces a schema-shaped entry, and writes it to the
// entry file the prompt names, exactly as a real seat must. A scenario can override
// any seat or seat:mode with its own handler.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function parsePrompt(prompt, opts) {
  const pick = (re) => {
    const m = re.exec(prompt)
    return m ? m[1] : null
  }
  const ctxRaw = pick(/## Council digest\n```json\n([\s\S]*?)\n```/)
  return {
    seat: opts.agentType.split(':').pop(),
    mode: pick(/Mode: ([a-z-]+)\./),
    prefix: pick(/Your entry prefix: ([A-Z]{2}\d+)\./),
    round: Number(pick(/\nRound: (\d+)/) || 0),
    lens: pick(/\nLens: (.+)/),
    runDir: pick(/Run directory: (.+)/),
    entryPath: pick(/\nEntry file: (.+)/),
    blind: /Visibility: BLIND/.test(prompt),
    blindFrom: pick(/do not read files numbered (\d+)/),
    ctx: ctxRaw ? JSON.parse(ctxRaw) : null,
  }
}

export function base(seat, prefix, extra) {
  return Object.assign({
    seat,
    entry_id: prefix,
    position: `${seat} position`,
    confidence: 'medium',
    statements: [],
    objections: [],
    objection_updates: [],
    resources_used: [{ name: 'Read', type: 'tool', purpose: 'read the ledger' }],
  }, extra || {})
}

export const active = (ctx) => (ctx ? ctx.candidates.filter((c) => !c.retired).map((c) => c.id) : [])
const mine = (ctx, seat) => (ctx ? ctx.objections.filter((o) => o.raiser === seat && ['open', 'mitigation_proposed'].includes(o.status)) : [])

// Critics and the verifier accept a mitigation of their own objection and keep open ones open.
export function review(ctx, seat) {
  return mine(ctx, seat).map((o) => ({
    objection: o.id,
    action: o.status === 'mitigation_proposed' ? 'resolve' : 'maintain',
    note: o.status === 'mitigation_proposed' ? 'mitigation accepted' : 'still open',
  }))
}

export const NARRATIVE = ['00-final-decision.md', '01-decision-record.md', '05-runbook.md']

export const DEFAULTS = {
  researcher: ({ prefix, seat }) => base(seat, prefix, {
    statements: [
      { id: `C-${prefix}-01`, text: 'A cited fact.', kind: 'fact', evidence: [`E-${prefix}-01`] },
      { id: `C-${prefix}-02`, text: 'A framing assumption.', kind: 'assumption', load_bearing: true },
    ],
    evidence: [{ id: `E-${prefix}-01`, title: 'Official docs', type: 'documentation', locator: 'https://example.com/docs', reliability: 'high' }],
    resources_used: [{ name: 'WebSearch', type: 'tool', purpose: 'find sources' }],
  }),
  'verifier:verify': ({ prefix, seat, ctx }) => base(seat, prefix, {
    evidence_verdicts: (ctx.evidence || []).map((e) => ({ evidence: e.id, verified: true, note: 'checked' })),
  }),
  'verifier:validate': ({ prefix, seat, ctx }) => base(seat, prefix, {
    objection_updates: review(ctx, seat),
    tests: [{ id: `T-${prefix}-01`, hypothesis: 'It holds', method: 'script', targets: [], result: 'designed', detail: 'needs a staging box' }],
  }),
  verifier: ({ prefix, seat }) => base(seat, prefix),
  'architect:design': ({ prefix, seat, lens }) => base(seat, prefix, {
    candidates: (lens ? ['A'] : ['A', 'B']).map((k, i) => ({
      id: `S-${prefix}-0${i + 1}`, title: `Candidate ${prefix}${k}`, summary: `Approach ${k}.`, addresses: ['SC-1'], doc: `candidates/S-${prefix}-0${i + 1}.md`,
    })),
  }),
  'architect:revise': ({ prefix, seat, ctx }) => {
    const open = ctx.objections.filter((o) => o.status === 'open')
    const revised = Array.from(new Set(open.filter((o) => o.severity === 'critical').map((o) => o.target)))
      .filter((id) => active(ctx).includes(id))
    return base(seat, prefix, {
      objection_updates: open.map((o) => ({ objection: o.id, action: 'mitigate', note: `fix for ${o.id}` })),
      candidates: revised.map((id) => ({ id, title: 'Revised', summary: 'Revised approach.', change_note: 'addresses critical objection' })),
    })
  },
  architect: ({ prefix, seat }) => base(seat, prefix),
  'devils-advocate': ({ prefix, seat, ctx }) => base(seat, prefix, { targets_reviewed: active(ctx), objection_updates: review(ctx, seat) }),
  'red-team': ({ prefix, seat, ctx }) => base(seat, prefix, { targets_reviewed: active(ctx), objection_updates: review(ctx, seat) }),
  'chair:gate': ({ prefix, seat, ctx }) => base(seat, prefix, {
    decision: ctx.hard_gates_met ? 'converged' : 'continue',
    rationale: ctx.hard_gates_met ? 'Hard gates met; no material objection remains.' : 'Hard gates failing; continue.',
  }),
  synthesizer: ({ prefix, seat, ctx, runDir }) => {
    const c = active(ctx)[0] || 'none'
    const cited = [].concat(ctx.candidates.map((k) => k.id), ctx.objections.map((o) => o.id),
      (ctx.statements || []).map((s) => s.id), (ctx.evidence || []).map((e) => e.id))
    if (runDir) {
      mkdirSync(join(runDir, 'final'), { recursive: true })
      for (const f of NARRATIVE) writeFileSync(join(runDir, 'final', f), `# ${f}\n\nRecommends ${c}. Cites: ${cited.join(', ')}\n`)
    }
    return base(seat, prefix, {
      council_state: { leading_architecture: [c] },
      decision_matrix: ctx.candidates.map((k) => ({ candidate: k.id, criterion: 'SC-1', score: k.id === c ? 4 : 2 })),
      recommendation: { candidate: c, rationale: 'Best on SC-1.', conditions: [], confidence: 'medium' },
      dissent: [],
      files_written: NARRATIVE.map((f) => `final/${f}`),
      cited_ids: cited,
    })
  },
  auditor: ({ prefix, seat }) => base(seat, prefix, {
    verdict: 'pass', criteria: [{ id: 'SC-1', status: 'met', basis: [] }], gaps: [], unsupported_claims: [], remediation: [],
  }),
}

export function makeCouncil({ runDir, scenario = {}, write = true } = {}) {
  const calls = []
  const handlers = Object.assign({}, DEFAULTS, scenario)

  async function agent(prompt, opts) {
    const p = parsePrompt(prompt, opts)
    calls.push(Object.assign({ label: opts.label, schema: opts.schema, agentType: opts.agentType, effort: opts.effort, prompt }, p))
    const h = handlers[`${p.seat}:${p.mode}`] || handlers[p.seat] || (({ prefix, seat }) => base(seat, prefix))
    const entry = h(Object.assign({}, p, { runDir: p.runDir || runDir, base: (x) => base(p.seat, p.prefix, x) }))
    if (entry === null || entry === undefined) return null
    if (write && p.entryPath) {
      mkdirSync(dirname(p.entryPath), { recursive: true })
      writeFileSync(p.entryPath, JSON.stringify(entry, null, 2))
    }
    return entry
  }

  return { agent, calls }
}
