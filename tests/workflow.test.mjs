// End-to-end tests of the deliberation workflow, the ledger replay and the Recorder,
// run against a fake council. Run from the plugin root:  node --test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runWorkflow } from './harness.mjs'
import { makeCouncil, base, active, review } from './fake_council.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(root, 'scripts', 'council_ledger.py')
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')

const tmpRun = () => mkdtempSync(join(tmpdir(), 'council-run-'))
const canon = (x) => (Array.isArray(x) ? x.map(canon)
  : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x)
const py = (...a) => spawnSync(PY, [LEDGER, ...a], { encoding: 'utf8' })
const pyState = (runDir) => JSON.parse(execFileSync(PY, [LEDGER, 'state', runDir, '--json'], { encoding: 'utf8' }))

async function run({ tier = 'standard', domains = ['databases', 'security'], scenario = {}, extra = {}, runDir = tmpRun(), budget, wrap } = {}) {
  const council = makeCouncil({ runDir, scenario })
  const phases = []
  const logs = []
  const result = await runWorkflow({
    agent: wrap ? wrap(council.agent) : council.agent,
    phase: (t) => phases.push(t),
    log: (m) => logs.push(m),
    budget,
    args: Object.assign({ runDir, tier, domains, specIds: ['SC-1', 'SC-2', 'CN-1', 'AS-1'], debug: true }, extra),
  })
  return { result, calls: council.calls, phases, logs, runDir }
}

const objection = (prefix, n, target, severity, claim = 'A material problem.') =>
  ({ id: `O-${prefix}-0${n}`, target, severity, claim, would_change: 'The recommendation changes.', resolves_if: 'Evidence or a fix.' })

// Round 1: a critical reasoning objection and a high build objection. The Architect mitigates
// and revises; in round 2 both raisers accept the mitigations and the council converges.
const typical = {
  'devils-advocate:challenge': ({ prefix, seat, ctx, round }) => base(seat, prefix, {
    targets_reviewed: active(ctx), objection_updates: review(ctx, seat),
    objections: round === 1 ? [objection(prefix, 1, active(ctx)[0], 'critical', 'Rests on an unverified premise.')] : [],
  }),
  'red-team:challenge': ({ prefix, seat, ctx, round }) => base(seat, prefix, {
    targets_reviewed: active(ctx), objection_updates: review(ctx, seat),
    objections: round === 1 ? [objection(prefix, 1, active(ctx)[1] || active(ctx)[0], 'high', 'Breaks at 10x load.')] : [],
  }),
}

// Adversarial: every objector raises a new high objection each run and never concedes; the
// Chair keeps going, routes everywhere and asks for extra runs; the audit fails.
function worstScenario() {
  const raise = (seat) => ({ prefix, ctx }) => base(seat, prefix, {
    targets_reviewed: active(ctx),
    objections: [objection(prefix, 1, 'SC-1', 'high')],
    objection_updates: (ctx ? ctx.objections : []).filter((o) => o.raiser === seat && o.status !== 'note')
      .map((o) => ({ objection: o.id, action: 'maintain', note: 'not convinced' })),
  })
  return {
    'devils-advocate:challenge': raise('devils-advocate'),
    'red-team:challenge': raise('red-team'),
    'verifier:validate': raise('verifier'),
    'architect:design': ({ prefix, seat }) => base(seat, prefix, { candidates: [{ id: `S-${prefix}-01`, title: 't', summary: 's' }] }),
    'chair:gate': ({ prefix, seat }) => base(seat, prefix, {
      decision: 'continue',
      rationale: 'Blocking objections remain.',
      routes: ['architect', 'devils-advocate', 'red-team', 'verifier', 'researcher', 'synthesizer'].map((s) => ({ to_seat: s, instruction: 'Do more.' })),
      add_seats: [{ seat: 'researcher', lens: 'domain: law', reason: 'gap' }, { seat: 'red-team', lens: 'abuse', reason: 'gap' }],
    }),
    auditor: ({ prefix, seat }) => base(seat, prefix, {
      verdict: 'fail', criteria: [{ id: 'SC-1', status: 'unmet' }], gaps: ['everything'],
      remediation: ['verifier', 'architect', 'researcher', 'synthesizer'].map((s) => ({ to_seat: s, instruction: 'Fix your part.' })),
    }),
  }
}

// A Claude Code token target: each agent run spends 30k output tokens, and once the target is
// spent further agent() calls throw (as the runtime does).
function tokenTarget(total) {
  let spent = 0
  const budget = { total, spent: () => spent, remaining: () => Math.max(0, total - spent) }
  const wrap = (agent) => (prompt, opts) => {
    if (spent >= total) throw new Error(`Workflow token budget exceeded (${spent} / ${total} output tokens)`)
    spent += 30000
    return agent(prompt, opts)
  }
  return { budget, wrap }
}

// --- the shape of a normal run ---------------------------------------------------------

test('deep: blind research and design, one fix cycle, converges in round 2 well inside its budget', async () => {
  const { result, calls, runDir } = await run({ tier: 'deep', scenario: typical })
  assert.equal(result.status, 'ready_for_signoff')
  assert.equal(result.outcome, 'converged')
  assert.equal(result.run_budget, 25)
  assert.equal(result.runs_used, 17)
  assert.equal(result.rounds, 2)
  assert.equal(result.violations, 0)
  assert.deepEqual(result.rulings.map((r) => r.effective), ['continue', 'converged'])
  assert.equal(result.audit.verdict, 'pass')

  const research = calls.filter((c) => c.mode === 'investigate')
  assert.equal(research.length, 3)
  assert.ok(research.every((c) => c.blind))
  assert.deepEqual(research.map((c) => c.lens.split(':')[0]), ['general', 'domain', 'domain'])
  assert.ok(research[1].lens.includes('databases') && research[2].lens.includes('security'))

  const design = calls.filter((c) => c.mode === 'design')
  assert.equal(design.length, 2)
  assert.ok(design.every((c) => c.blind))
  assert.deepEqual(design.map((c) => c.lens.split(':')[0]), ['conventional', 'alternative'])

  const challengers = calls.filter((c) => c.mode === 'challenge' && c.round === 1)
  assert.ok(challengers.every((c) => c.blindFrom === challengers[0].blindFrom), 'challengers share one visibility cut-off')
  assert.ok(calls.every((c) => c.agentType === `council:${c.seat}`))
  assert.equal(calls.find((c) => c.seat === 'researcher').effort, 'medium')
  assert.equal(calls.find((c) => c.seat === 'architect').effort, 'high')

  const files = readdirSync(join(runDir, 'entries'))
  assert.equal(files.length, result.runs_used, 'every run wrote its entry file')
  const prefixes = calls.map((c) => c.prefix)
  assert.equal(new Set(prefixes).size, prefixes.length)
})

test('standard: the same problem takes 16 workflow runs (17 with framing)', async () => {
  const { result } = await run({ tier: 'standard', scenario: typical })
  assert.equal(result.status, 'ready_for_signoff')
  assert.equal(result.run_budget, 19)
  assert.equal(result.runs_used, 16)
})

test('quick: one Researcher, one Architect writing two candidates, Devil\'s Advocate only, code gate', async () => {
  const { result, calls } = await run({ tier: 'quick', domains: [], scenario: typical })
  assert.equal(result.status, 'ready_for_signoff')
  assert.equal(result.outcome, 'converged')
  assert.equal(result.run_budget, 6)
  assert.deepEqual(calls.map((c) => `${c.seat}:${c.mode}`), [
    'researcher:investigate', 'architect:design', 'devils-advocate:challenge',
    'architect:revise', 'devils-advocate:challenge', 'synthesizer:synthesize',
  ])
  assert.match(calls[2].prompt, /no Red Team in this council/)
  assert.equal(result.audit.verdict, 'not_in_tier')
  assert.deepEqual(result.rulings.map((r) => r.id), ['R-code', 'R-code'])
})

test('quick: an objection its raiser keeps open is carried as a risk at the round cap', async () => {
  const { result } = await run({
    tier: 'quick',
    domains: [],
    scenario: {
      'devils-advocate:challenge': ({ prefix, seat, ctx, round }) => base(seat, prefix, {
        objections: round === 1 ? [objection(prefix, 1, active(ctx)[0], 'critical')] : [],
        objection_updates: ctx.objections.filter((o) => o.raiser === seat).map((o) => ({ objection: o.id, action: 'maintain', note: 'no' })),
      }),
    },
  })
  assert.equal(result.status, 'ready_for_signoff')
  assert.equal(result.outcome, 'round_cap')
  assert.deepEqual(result.carried_risks, ['O-DA1-01'])
})

test('C3: convergence is refused while the Red Team has not attacked every active candidate', async () => {
  const { result } = await run({
    tier: 'standard',
    scenario: {
      'red-team:challenge': ({ prefix, seat, ctx, round }) => base(seat, prefix, { targets_reviewed: round === 1 ? active(ctx).slice(0, 1) : active(ctx) }),
      'chair:gate': ({ prefix, seat }) => base(seat, prefix, { decision: 'converged', rationale: 'Looks done.' }),
    },
  })
  assert.match(result.rulings[0].overridden, /hard gates failing \(C3\)/)
  assert.equal(result.rulings[0].effective, 'continue')
  assert.equal(result.rulings[1].effective, 'converged')
  assert.equal(result.outcome, 'converged')
})

// --- the budget guarantees ----------------------------------------------------------------

for (const [tier, cap] of [['quick', 6], ['standard', 19], ['deep', 25]]) {
  test(`worst case (${tier}): never exceeds ${cap} runs, and synthesis${tier === 'quick' ? '' : ' and the audit'} still run`, async () => {
    const { result, calls } = await run({ tier, scenario: worstScenario() })
    assert.ok(result.runs_used <= cap, `${result.runs_used} runs > cap ${cap}`)
    assert.equal(calls.length, result.runs_used)
    assert.ok(calls.some((c) => c.seat === 'synthesizer'))
    if (tier !== 'quick') assert.ok(calls.some((c) => c.seat === 'auditor'))
    assert.equal(result.status, 'ready_for_signoff')
    assert.ok(['round_cap', 'budget'].includes(result.outcome))
    assert.ok(result.carried_risks.length > 0)
    assert.ok(result.extra_runs <= 2)
    if (tier !== 'quick') assert.ok(result.skipped.some((s) => /route to researcher/.test(s.step)), 'routes to non-routable seats are skipped, not run')
  })
}

test('worst case with --rounds 5: the default budget grows with the rounds, and an explicit --budget still caps it', async () => {
  const wide = await run({ tier: 'deep', scenario: worstScenario(), extra: { maxRounds: 5 } })
  assert.equal(wide.result.run_budget, 35)
  assert.ok(wide.result.runs_used <= 35)
  const capped = await run({ tier: 'deep', scenario: worstScenario(), extra: { maxRounds: 5, budget: 25 } })
  assert.ok(capped.result.runs_used <= 25)
  assert.equal(capped.result.status, 'ready_for_signoff')
})

test('a small --budget stops deliberation early but still pays for synthesis and the audit', async () => {
  const { result, calls } = await run({ tier: 'standard', scenario: typical, extra: { budget: 12 } })
  assert.equal(result.outcome, 'budget')
  assert.equal(result.runs_used, 11)
  assert.ok(result.skipped.some((s) => s.step === 'round 2'))
  assert.deepEqual(result.carried_risks.sort(), ['O-DA1-01', 'O-RT1-01'])
  assert.deepEqual(calls.slice(-2).map((c) => c.seat), ['synthesizer', 'auditor'])
  assert.equal(result.status, 'ready_for_signoff')
})

test('a budget below the minimum for the tier is refused before any run', async () => {
  const { result, calls } = await run({ tier: 'deep', extra: { budget: 8 } })
  assert.equal(result.status, 'error')
  assert.match(result.message, /needs at least 12 agent runs/)
  assert.equal(calls.length, 0)
})

test('a token target stops optional work early and keeps the reserve for synthesis and the audit', async () => {
  const { budget, wrap } = tokenTarget(13 * 30000)
  const { result, calls } = await run({ tier: 'standard', scenario: typical, budget, wrap })
  assert.equal(result.outcome, 'budget')
  assert.equal(result.runs_used, 11)
  assert.deepEqual(calls.slice(-2).map((c) => c.seat), ['synthesizer', 'auditor'])
  assert.equal(result.status, 'ready_for_signoff')
})

test('when the token target is spent before synthesis, the run is incomplete, never ready_for_signoff', async () => {
  const { budget, wrap } = tokenTarget(5 * 30000)
  const { result } = await run({ tier: 'standard', scenario: typical, budget, wrap })
  assert.equal(result.status, 'incomplete')
  assert.ok(result.incomplete_reasons.some((r) => /Synthesizer/.test(r)))
  assert.ok(result.incomplete_reasons.some((r) => /Auditor/.test(r)))
  assert.ok(result.failures.some((f) => /token budget exceeded/.test(f.error)))
})

test('a Synthesizer that returns nothing makes the run incomplete', async () => {
  const { result } = await run({ tier: 'standard', scenario: { synthesizer: () => null } })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.recommendation, null)
})

// --- the objection rules (§6) -------------------------------------------------------------------

test('§6.4: the Architect cannot close its own objections; only the raiser withdraws; the Chair accepts risk or downgrades but cannot resolve', async () => {
  const { result, runDir } = await run({
    tier: 'standard',
    scenario: {
      'devils-advocate:challenge': ({ prefix, seat, ctx, round }) => base(seat, prefix, {
        targets_reviewed: active(ctx),
        objections: round === 1 ? [objection(prefix, 1, active(ctx)[0], 'critical'), objection(prefix, 2, active(ctx)[1], 'high')] : [],
        objection_updates: round === 1 ? [] : [{ objection: 'O-DA1-01', action: 'maintain', note: 'retry is not enough' }],
      }),
      'architect:revise': ({ prefix, seat }) => base(seat, prefix, {
        objection_updates: [
          { objection: 'O-DA1-01', action: 'resolve', note: 'I fixed it' },
          { objection: 'O-DA1-01', action: 'withdraw', note: 'not real' },
          { objection: 'O-DA1-01', action: 'mitigate', note: 'add a retry' },
          { objection: 'O-DA1-02', action: 'accept_risk', note: 'fine' },
        ],
      }),
      'chair:gate': ({ prefix, seat, round }) => base(seat, prefix, {
        decision: round === 1 ? 'continue' : 'converged',
        rationale: 'Ruling.',
        objection_updates: round === 1 ? [] : [
          { objection: 'O-DA1-02', action: 'accept_risk', note: 'Fixing costs more than the exposure; documented.' },
          { objection: 'O-DA1-01', action: 'downgrade', severity: 'medium', note: 'The retry bounds the impact.' },
          { objection: 'O-DA1-01', action: 'resolve', note: 'chair cannot resolve' },
        ],
      }),
    },
  })
  const msgs = result.state.violations.map((v) => v.message).join('\n')
  assert.match(msgs, /architect cannot resolve O-DA1-01/)
  assert.match(msgs, /only the raiser \(devils-advocate\) can withdraw O-DA1-01/)
  assert.match(msgs, /only the chair can accept O-DA1-02/)
  assert.match(msgs, /chair cannot resolve O-DA1-01/)
  const o = result.state.objections
  assert.equal(o['O-DA1-02'].status, 'accepted_risk')
  assert.equal(o['O-DA1-01'].status, 'mitigation_proposed')
  assert.equal(o['O-DA1-01'].severity, 'medium')
  assert.equal(result.outcome, 'converged')
  assert.deepEqual(canon(pyState(runDir)), canon(result.state))
})

test('§6.4: the Verifier closes objections with verified evidence or a passing test it ran, never a failing one', async () => {
  const { result, runDir } = await run({
    tier: 'standard',
    scenario: {
      'devils-advocate:challenge': ({ prefix, seat, ctx, round }) => base(seat, prefix, {
        targets_reviewed: active(ctx),
        objections: round === 1 ? [objection(prefix, 1, 'C-RS1-01', 'high', 'The source is wrong.')] : [],
      }),
      'red-team:challenge': ({ prefix, seat, ctx, round }) => base(seat, prefix, {
        targets_reviewed: active(ctx),
        objections: round === 1 ? [objection(prefix, 1, active(ctx)[0], 'critical', 'Breaks at 10x.'), objection(prefix, 2, active(ctx)[1], 'high', 'Leaks memory.')] : [],
        objection_updates: round === 1 ? [] : review(ctx, seat),
      }),
      'verifier:validate': ({ prefix, seat, round }) => base(seat, prefix, round === 1 ? {
        evidence: [{ id: `E-${prefix}-01`, title: 'Primary source', type: 'documentation', locator: 'https://example.com/primary', reliability: 'high', verified: true }],
        tests: [
          { id: `T-${prefix}-01`, hypothesis: 'A holds at 10x', method: 'k6', targets: ['O-RT1-01'], result: 'pass', detail: 'k6 run load.js' },
          { id: `T-${prefix}-02`, hypothesis: 'B does not leak', method: 'soak', targets: ['O-RT1-02'], result: 'fail' },
        ],
        objection_updates: [
          { objection: 'O-DA1-01', action: 'resolve', basis: [`E-${prefix}-01`], note: 'primary source confirms it' },
          { objection: 'O-RT1-01', action: 'resolve', basis: [`T-${prefix}-01`], note: 'passed at 10x' },
          { objection: 'O-RT1-02', action: 'resolve', basis: [`T-${prefix}-02`], note: 'tried anyway' },
        ],
      } : {}),
    },
  })
  const o = result.state.objections
  assert.equal(o['O-DA1-01'].status, 'resolved')
  assert.equal(o['O-RT1-01'].status, 'resolved')
  assert.ok(result.state.violations.some((v) => /verifier cannot resolve O-RT1-02/.test(v.message)))
  assert.equal(o['O-RT1-02'].history.filter((h) => h.action === 'resolve').every((h) => h.prefix.startsWith('RT')), true)
  assert.deepEqual(canon(pyState(runDir)), canon(result.state))
})

test('§6.2 and §6.4: only critics and the Verifier raise blocking objections, only material ones, and only the Verifier verifies evidence', async () => {
  const { result, runDir } = await run({
    tier: 'standard',
    scenario: {
      researcher: ({ prefix, seat }) => base(seat, prefix, {
        objections: [objection(prefix, 1, 'SC-1', 'critical')],
        evidence: [{ id: `E-${prefix}-01`, title: 'My own blog', type: 'web', locator: 'https://example.com/me', reliability: 'high', verified: true }],
      }),
      'verifier:verify': ({ prefix, seat }) => base(seat, prefix),
      'devils-advocate:challenge': ({ prefix, seat, ctx, round }) => base(seat, prefix, {
        targets_reviewed: active(ctx),
        objections: round === 1 ? [
          objection(prefix, 1, 'S-XX9-99', 'critical'),
          { ...objection(prefix, 2, 'SC-1', 'high'), would_change: '' },
        ] : [],
      }),
    },
  })
  assert.ok(Object.values(result.state.objections).every((o) => o.status === 'note'))
  assert.equal(result.state.evidence['E-RS1-01'].verified, false, 'a researcher cannot verify its own evidence')
  assert.equal(result.outcome, 'converged')
  assert.equal(result.rounds, 1)
  assert.deepEqual(canon(pyState(runDir)), canon(result.state))
})

test('retiring a candidate makes its objections moot', async () => {
  const { result } = await run({
    tier: 'standard',
    scenario: {
      'red-team:challenge': ({ prefix, seat, ctx, round }) => base(seat, prefix, {
        targets_reviewed: active(ctx),
        objections: round === 1 ? [objection(prefix, 1, active(ctx)[1], 'critical', 'Fatal flaw.')] : [],
      }),
      'architect:revise': ({ prefix, seat, ctx }) => base(seat, prefix, { retired_candidates: [{ id: active(ctx)[1], reason: 'Fatal flaw O-RT1-01.' }] }),
    },
  })
  assert.equal(result.outcome, 'converged')
  assert.equal(result.gates.C1.met, true)
  assert.equal(result.ledger_counts.objections_by_status.moot, 1)
})

test('only the Architect proposes candidates, and IDs must carry the caller\'s prefix', async () => {
  const { result } = await run({
    tier: 'quick',
    domains: [],
    scenario: {
      researcher: ({ prefix, seat }) => base(seat, prefix, {
        statements: [{ id: 'C-DA9-01', text: 'forged', kind: 'fact' }, { id: `C-${prefix}-01`, text: 'mine', kind: 'inference' }],
        candidates: [{ id: `S-${prefix}-01`, title: 'sneaky', summary: 's' }],
      }),
    },
  })
  const msgs = result.state.violations.map((v) => v.message).join('\n')
  assert.match(msgs, /rejected C-DA9-01/)
  assert.match(msgs, /only the architect may propose or revise candidates/)
  assert.ok(result.state.statements['C-RS1-01'])
  assert.equal(result.state.candidates['S-RS1-01'], undefined)
})

// --- Chair rulings ----------------------------------------------------------------------------------

test('escalation: blocking stops for your answer; non-blocking is carried to sign-off', async () => {
  const esc = (blocking) => ({
    'chair:gate': ({ prefix, seat }) => base(seat, prefix, {
      decision: 'escalate', rationale: 'Cost and safety conflict.',
      escalation: { question: 'Prioritise cost or safety?', options: ['cost', 'safety'], provisional_default: 'safety', blocking },
    }),
  })
  const stop = await run({ tier: 'standard', scenario: esc(true) })
  assert.equal(stop.result.status, 'needs_input')
  assert.equal(stop.result.escalation.question, 'Prioritise cost or safety?')
  assert.equal(stop.calls.some((c) => c.seat === 'synthesizer'), false)
  const go = await run({ tier: 'standard', scenario: esc(false) })
  assert.equal(go.result.status, 'ready_for_signoff')
  assert.equal(go.result.escalations[0].provisional_default, 'safety')
})

test('Chair routes become instructions in runs that happen anyway; add_seats adds at most two runs', async () => {
  const { result, calls } = await run({
    tier: 'deep',
    scenario: Object.assign({}, typical, {
      'chair:gate': ({ prefix, seat, ctx, round }) => base(seat, prefix, round === 1 ? {
        decision: 'continue', rationale: 'Need a test and more facts.',
        routes: [{ to_seat: 'verifier', objection: 'O-RT1-01', instruction: 'Load-test B.' }, { to_seat: 'architect', instruction: 'Add a queue.' }, { to_seat: 'researcher', instruction: 'Look again.' }],
        add_seats: [{ seat: 'researcher', lens: 'domain: data protection law', reason: 'a legal gap' }, { seat: 'red-team', lens: 'insider abuse', reason: 'no abuse analysis' }, { seat: 'researcher', reason: 'a third' }],
      } : { decision: ctx.hard_gates_met ? 'converged' : 'continue', rationale: 'Checked.' }),
    }),
  })
  assert.equal(result.outcome, 'converged')
  assert.equal(result.extra_runs, 2)
  assert.equal(result.runs_used, 17 + 2)
  assert.ok(result.skipped.some((s) => /at most 2 extra runs/.test(s.reason)))
  assert.ok(result.skipped.some((s) => /route to researcher/.test(s.step)))
  assert.match(calls.find((c) => c.mode === 'revise').prompt, /The Chair routed this to you: Add a queue\./)
  assert.match(calls.find((c) => c.mode === 'validate' && c.round === 2).prompt, /Load-test B\. \(objection O-RT1-01\)/)
  const added = calls.filter((c) => c.round === 2 && (c.seat === 'researcher' || c.lens === 'insider abuse'))
  assert.deepEqual(added.map((c) => c.lens), ['domain: data protection law', 'insider abuse'])
})

// --- audit and remediation ---------------------------------------------------------------------------

const failOnce = () => {
  let n = 0
  return ({ prefix, seat }) => {
    n += 1
    return base(seat, prefix, n === 1
      ? { verdict: 'fail', criteria: [{ id: 'SC-1', status: 'partial' }], gaps: ['SC-1 untested'], remediation: [
        { to_seat: 'verifier', instruction: 'Test SC-1.' }, { to_seat: 'architect', instruction: 'Cost it.' }, { to_seat: 'auditor', instruction: 'ignored' }] }
      : { verdict: 'pass', criteria: [{ id: 'SC-1', status: 'met' }], gaps: [], remediation: [] })
  }
}

test('a failed audit gets one remediation run for one seat, a re-synthesis and a re-audit', async () => {
  const { result, calls } = await run({ tier: 'standard', scenario: { auditor: failOnce() } })
  assert.equal(result.audit.verdict, 'pass')
  assert.equal(result.audit.remediated, true)
  assert.deepEqual(calls.filter((c) => c.mode === 'remediate').map((c) => c.seat), ['verifier'])
  assert.deepEqual(result.audit.unaddressed, ['architect: Cost it.'])
  assert.equal(calls.filter((c) => c.seat === 'auditor').length, 2)
  assert.ok(result.runs_used <= result.run_budget)
})

test('remediation is skipped, and listed, when the budget cannot cover it', async () => {
  const { result, calls } = await run({ tier: 'standard', scenario: Object.assign({}, typical, { auditor: failOnce() }), extra: { budget: 16 } })
  assert.equal(result.runs_used, 16)
  assert.equal(result.audit.verdict, 'fail')
  assert.equal(result.audit.remediated, false)
  assert.equal(calls.some((c) => c.mode === 'remediate'), false)
  assert.ok(result.skipped.some((s) => s.step === 'remediation'))
  assert.equal(result.audit.unaddressed.length, 2)
})

// --- replay parity, the Recorder and the checker ---------------------------------------------------

test('the Python replay reproduces the workflow ledger and gates exactly', async () => {
  for (const sc of [{ tier: 'deep', scenario: typical }, { tier: 'quick', domains: [], scenario: typical }, { tier: 'standard', scenario: worstScenario() },
    { tier: 'standard', scenario: Object.assign({}, typical, { 'verifier:validate': () => null }) }]) {
    const { result, runDir } = await run(sc)
    const { state, ...rest } = result
    writeFileSync(join(runDir, 'result.json'), JSON.stringify(rest))
    assert.deepEqual(canon(pyState(runDir)), canon(result.state), `${sc.tier} state`)
    const status = JSON.parse(py('status', runDir, '--json').stdout)
    for (const k of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']) assert.equal(status.gates.gates[k].met, result.gates[k].met, `${sc.tier} ${k}`)
  }
})

test('the Recorder renders the record from the ledger and the check passes', async () => {
  const { result, runDir } = await run({ tier: 'standard', scenario: typical })
  const { state, ...rest } = result
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(rest, null, 2))
  const r = py('render', runDir)
  assert.equal(r.status, 0, r.stderr)
  for (const f of ['02-argument-log.md', '03-resource-register.md', '04-experiment-log.md', '06-open-risks.md', '07-process-record.md']) {
    assert.ok(existsSync(join(runDir, 'final', f)), f)
  }
  assert.ok(existsSync(join(runDir, 'minutes', 'round-1.md')) && existsSync(join(runDir, 'minutes', 'round-2.md')))
  const log = readFileSync(join(runDir, 'final', '02-argument-log.md'), 'utf8')
  assert.match(log, /O-DA1-01/)
  assert.match(log, /“Rests on an unverified premise\.”/)
  assert.match(log, /mitigate by AR3: fix for O-DA1-01 → resolve by DA2/)
  const proc = readFileSync(join(runDir, 'final', '07-process-record.md'), 'utf8')
  assert.match(proc, /16 of a budget of 19 in the workflow, plus 1 framing run/)
  assert.match(readFileSync(join(runDir, 'final', '03-resource-register.md'), 'utf8'), /\| WebSearch \| tool \|/)
  const check = py('check', runDir)
  assert.equal(check.status, 0, check.stdout + check.stderr)
})

test('the check catches an invented ID in the narrative documents', async () => {
  const { result, runDir } = await run({ tier: 'standard', scenario: typical })
  const { state, ...rest } = result
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(rest))
  py('render', runDir)
  const f = join(runDir, 'final', '00-final-decision.md')
  writeFileSync(f, readFileSync(f, 'utf8') + '\nAlso see C-ZZ9-01.\n')
  const check = py('check', runDir)
  assert.equal(check.status, 1)
  assert.match(check.stdout, /narrative documents cite IDs that are not in the ledger: C-ZZ9-01/)
})

test('reopen: the workflow hydrates from the Python state, the Architect goes first, numbering continues', async () => {
  const first = await run({ tier: 'standard', scenario: typical })
  const priorState = pyState(first.runDir)
  const second = await run({
    tier: 'standard',
    runDir: first.runDir,
    extra: { mode: 'reopen', priorState, directives: ['Keep the budget under $500 a month.'] },
  })
  assert.equal(second.result.status, 'ready_for_signoff')
  assert.equal(second.calls[0].seat, 'architect')
  assert.equal(second.calls[0].mode, 'reopen')
  assert.equal(second.calls[0].prefix, `AR${priorState.counters.architect + 1}`)
  assert.ok(second.calls.every((c) => c.prompt.includes('User directives (binding): Keep the budget under $500 a month.')))
  assert.equal(second.result.run_budget, 15)
  const seqs = readdirSync(join(first.runDir, 'entries')).map((f) => Number(f.slice(0, 3)))
  assert.equal(new Set(seqs).size, seqs.length, 'no sequence number reused')
})

test('errors: no runDir, and reopen without priorState', async () => {
  const council = makeCouncil({})
  const none = await runWorkflow({ agent: council.agent, args: {} })
  assert.equal(none.status, 'error')
  const { result } = await run({ tier: 'standard', extra: { mode: 'reopen' } })
  assert.equal(result.status, 'error')
  assert.match(result.message, /priorState/)
})

test('council_ledger.py new creates a run directory with every subfolder', () => {
  const base = mkdtempSync(join(tmpdir(), 'council-root-'))
  const r = py('new', 'Should', 'we', 'migrate', 'Flask', 'to', 'FastAPI?', '--root', base)
  assert.equal(r.status, 0, r.stderr)
  const dir = r.stdout.trim()
  assert.match(dir, /\d{8}-\d{4}-migrate-flask-fastapi$/)
  for (const sub of ['entries', 'notes', 'candidates', 'experiments', 'minutes', 'final']) assert.ok(existsSync(join(dir, sub)), sub)
})

test('schemas on disk match the workflow', () => {
  const r = spawnSync(process.execPath, [join(root, 'tests', 'export_schemas.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})
