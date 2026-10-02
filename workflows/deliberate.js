export const meta = {
  name: 'deliberate',
  description: 'Run the 8-seat deliberation council inside a hard agent-run budget: blind research and design, adversarial rounds judged at a Chair gate, then a reserved synthesis and independent audit.',
  whenToUse: 'Started by /council:convene, which frames the problem and passes the run directory, tier and budget as args.',
  phases: [
    { title: 'Reopen' },
    { title: 'Investigation' },
    { title: 'Verification' },
    { title: 'Design' },
    { title: 'Synthesis' },
    { title: 'Audit' },
    { title: 'Remediation' },
  ],
}

// ---------------------------------------------------------------------------
// Seats, tiers, budgets and schemas. The rules live in CONSTITUTION.md;
// section numbers in comments point there.
// ---------------------------------------------------------------------------

const SEATS = {
  chair: { code: 'CH', name: 'Chair', effort: 'medium' },
  researcher: { code: 'RS', name: 'Researcher', effort: 'medium' },
  architect: { code: 'AR', name: 'Architect', effort: 'high' },
  'devils-advocate': { code: 'DA', name: "Devil's Advocate", effort: 'high' },
  'red-team': { code: 'RT', name: 'Red Team', effort: 'high' },
  verifier: { code: 'VE', name: 'Verifier', effort: 'medium' },
  synthesizer: { code: 'SY', name: 'Synthesizer', effort: 'high' },
  auditor: { code: 'QA', name: 'Auditor', effort: 'high' },
}

const OBJECTORS = ['devils-advocate', 'red-team', 'verifier'] // §6.2
const ROUTABLE = ['architect', 'devils-advocate', 'red-team', 'verifier'] // §8.6
const EXTRA_SEATS = ['researcher', 'red-team']
const REMEDIABLE = ['researcher', 'architect', 'devils-advocate', 'red-team', 'verifier', 'synthesizer']

// §3
const TIERS = {
  quick: { researchers: 1, architects: 1, critics: ['devils-advocate'], verifier: false, chairGate: false, audit: false, maxRounds: 2 },
  standard: { researchers: 2, architects: 2, critics: ['devils-advocate', 'red-team'], verifier: true, chairGate: true, audit: true, maxRounds: 2 },
  deep: { researchers: 3, architects: 2, critics: ['devils-advocate', 'red-team'], verifier: true, chairGate: true, audit: true, maxRounds: 3 },
}
const TIER_ALIASES = { full: 'deep' }

// §8
const MAX_EXTRA_RUNS = 2
const REMEDIATION_RUNS = 3 // fix + re-synthesis + re-audit
const OUT_TOKENS_PER_RUN = 30000 // rough output-token reserve per run, used only when a token target is set
const BUDGET_MIN = 4
const BUDGET_MAX = 60
const WRITEUP_WORDS = 600

const SEVERITIES = ['critical', 'high', 'medium', 'low']
const BLOCKING_SEVERITIES = ['critical', 'high']
const BLOCKING_STATUSES = ['open', 'mitigation_proposed']

const STR = { type: 'string' }
const IDS = { type: 'array', items: { type: 'string' } }
const CONF = { enum: ['high', 'medium', 'low'] }
const SEV = { enum: SEVERITIES }
const list = (required, properties) => ({ type: 'array', items: { type: 'object', required, properties } })

// §5.4
const ENTRY_PROPERTIES = {
  seat: STR,
  entry_id: STR,
  position: STR,
  confidence: CONF,
  new_information: STR,
  writeup: STR,
  statements: list(['id', 'text', 'kind'], {
    id: STR,
    text: STR,
    kind: { enum: ['fact', 'inference', 'assumption', 'speculation', 'recommendation'] },
    evidence: IDS,
    rests_on: IDS,
    confidence: CONF,
    load_bearing: { type: 'boolean' },
  }),
  evidence: list(['id', 'title', 'type', 'locator', 'reliability'], {
    id: STR,
    title: STR,
    type: {
      enum: ['paper', 'documentation', 'standard', 'dataset', 'report', 'book', 'expert_source', 'web',
        'tool', 'api', 'mcp_server', 'plugin', 'skill', 'model', 'library', 'workflow', 'other'],
    },
    locator: STR,
    reliability: CONF,
    relevance: CONF,
    cost: STR,
    limitation: STR,
    verified: { type: 'boolean' },
    supports: IDS,
    contradicts: IDS,
  }),
  evidence_verdicts: list(['evidence', 'verified'], {
    evidence: STR,
    verified: { type: 'boolean' },
    reliability: CONF,
    note: STR,
  }),
  candidates: list(['id', 'title', 'summary'], {
    id: STR,
    title: STR,
    summary: STR,
    addresses: IDS,
    doc: STR,
    change_note: STR,
  }),
  retired_candidates: list(['id', 'reason'], { id: STR, reason: STR }),
  objections: list(['id', 'target', 'severity', 'claim', 'would_change', 'resolves_if'], {
    id: STR,
    target: STR,
    severity: SEV,
    claim: STR,
    would_change: STR,
    resolves_if: STR,
  }),
  objection_updates: list(['objection', 'action', 'note'], {
    objection: STR,
    action: { enum: ['maintain', 'withdraw', 'resolve', 'reopen', 'mitigate', 'accept_risk', 'downgrade'] },
    basis: IDS,
    severity: SEV,
    note: STR,
  }),
  tests: list(['id', 'hypothesis', 'method', 'targets', 'result'], {
    id: STR,
    hypothesis: STR,
    method: STR,
    targets: IDS,
    result: { enum: ['pass', 'fail', 'inconclusive', 'designed', 'not_run'] },
    detail: STR,
    artifact: STR,
  }),
  targets_reviewed: IDS,
  questions: list(['id', 'text'], { id: STR, text: STR, route_to: STR }),
  resources_used: list(['name', 'type', 'purpose'], {
    name: STR,
    type: { enum: ['tool', 'skill', 'mcp_server', 'plugin', 'web', 'file', 'model', 'dataset', 'other'] },
    purpose: STR,
  }),
}
const ENTRY_REQUIRED = ['seat', 'entry_id', 'position', 'confidence', 'statements', 'objections', 'objection_updates', 'resources_used']
const extend = (properties, required) => ({
  type: 'object',
  required: ENTRY_REQUIRED.concat(required),
  properties: Object.assign({}, ENTRY_PROPERTIES, properties),
})

const ENTRY_SCHEMA = extend({}, [])

const RULING_SCHEMA = extend({
  decision: { enum: ['continue', 'converged', 'escalate', 'halt'] },
  rationale: STR,
  routes: list(['to_seat', 'instruction'], { to_seat: STR, objection: STR, instruction: STR }),
  add_seats: list(['seat', 'reason'], { seat: { enum: EXTRA_SEATS }, lens: STR, reason: STR }),
  accepted_uncertainties: IDS,
  escalation: {
    type: 'object',
    required: ['question', 'options', 'provisional_default', 'blocking'],
    properties: {
      question: STR,
      options: { type: 'array', items: STR },
      provisional_default: STR,
      blocking: { type: 'boolean' },
    },
  },
}, ['decision', 'rationale'])

const SYNTH_SCHEMA = extend({
  council_state: { type: 'object' },
  decision_matrix: list(['candidate', 'criterion', 'score'], { candidate: STR, criterion: STR, score: { type: 'number' }, note: STR }),
  recommendation: {
    type: 'object',
    required: ['candidate', 'rationale', 'conditions', 'confidence'],
    properties: { candidate: STR, rationale: STR, conditions: { type: 'array', items: STR }, confidence: CONF },
  },
  dissent: list(['seat', 'position'], { seat: STR, position: STR, ids: IDS }),
  files_written: { type: 'array', items: STR },
  cited_ids: IDS,
}, ['decision_matrix', 'recommendation', 'dissent', 'files_written', 'cited_ids'])

const AUDIT_SCHEMA = extend({
  verdict: { enum: ['pass', 'fail'] },
  criteria: list(['id', 'status'], { id: STR, status: { enum: ['met', 'partial', 'unmet'] }, basis: IDS, note: STR }),
  gaps: { type: 'array', items: STR },
  unsupported_claims: IDS,
  remediation: list(['to_seat', 'instruction'], { to_seat: STR, instruction: STR }),
}, ['verdict', 'criteria', 'gaps', 'remediation'])

// ---------------------------------------------------------------------------
// Arguments and budget
// ---------------------------------------------------------------------------

const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const arr = (x) => (Array.isArray(x) ? x : [])
const text = (x) => (typeof x === 'string' ? x : '')
const clip = (x, n) => {
  const s = text(x)
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
const pad = (n) => String(n).padStart(3, '0')
const uniq = (xs) => Array.from(new Set(xs))

if (!A.runDir) {
  return { status: 'error', message: 'Missing runDir. Start the council with /council:convene, which frames the problem and passes the run directory.' }
}

const PLUGIN = text(A.plugin) || 'council'
const runDir = String(A.runDir).replace(/[\\/]+$/, '')
const tier = TIERS[A.tier] ? A.tier : (TIER_ALIASES[A.tier] || 'standard')
const T = TIERS[tier]
const mode = A.mode === 'reopen' ? 'reopen' : 'fresh'
const maxRounds = Math.min(5, Math.max(1, parseInt(A.maxRounds, 10) || (mode === 'reopen' ? Math.min(2, T.maxRounds) : T.maxRounds)))
const domains = arr(A.domains).map(String).filter(Boolean).slice(0, 2)
const specIds = arr(A.specIds).map(String)
const directives = (Array.isArray(A.directives) ? A.directives : A.directives ? [A.directives] : []).map(String)

const tailCore = 1 + (T.audit ? 1 : 0) // synthesis (+ audit) is always reserved (§8.2)
const roundBase = T.critics.length + (T.verifier ? 1 : 0) + (T.chairGate ? 1 : 0)
const openingCost = mode === 'reopen' ? 1 : T.researchers + (T.verifier ? 1 : 0) + T.architects
const roundsCost = (n) => n * roundBase + Math.max(0, n - 1) // rounds plus the revisions between them
const defaultBudget = openingCost + roundsCost(maxRounds) + tailCore + (T.audit ? REMEDIATION_RUNS : 0)
const askedBudget = parseInt(A.budget, 10)
const runBudget = askedBudget > 0 ? Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, askedBudget)) : defaultBudget
const minimumBudget = openingCost + roundBase + tailCore
if (runBudget < minimumBudget) {
  return {
    status: 'error',
    message: `A ${tier} council needs at least ${minimumBudget} agent runs; the budget is ${runBudget}. Raise --budget or use a smaller tier.`,
  }
}

// A per-turn token target set by the user is a hard ceiling in Claude Code (§8.3).
const TB = typeof budget !== 'undefined' && budget && budget.total && typeof budget.remaining === 'function' ? budget : null

// ---------------------------------------------------------------------------
// Ledger state. scripts/council_ledger.py replays exactly these rules from disk.
// ---------------------------------------------------------------------------

const S = {
  seq: 0,
  round: 0,
  counters: {},
  known: {},
  statements: {},
  evidence: {},
  candidates: {},
  objections: {},
  tests: {},
  questions: {},
  rtReviewed: {},
  acceptedUncertainties: [],
  violations: [],
  entries: [],
  // per workflow run, not persisted in the ledger:
  runs: 0,
  extraRuns: 0,
  rulings: [],
  escalations: [],
  failures: [],
  skipped: [],
}

const HYDRATE_KEYS = ['seq', 'round', 'counters', 'known', 'statements', 'evidence', 'candidates', 'objections',
  'tests', 'questions', 'rtReviewed', 'acceptedUncertainties', 'violations', 'entries']

function hydrate(prior) {
  for (const k of HYDRATE_KEYS) {
    if (prior && prior[k] !== undefined && prior[k] !== null) S[k] = JSON.parse(JSON.stringify(prior[k]))
  }
}

function exportState() {
  const out = {}
  for (const k of HYDRATE_KEYS) out[k] = S[k]
  return out
}

function canAfford(n) {
  // n more runs, and synthesis (+ audit) still affordable afterwards
  const runsOk = S.runs + n + tailCore <= runBudget
  const tokensOk = !TB || TB.remaining() >= (n + tailCore) * OUT_TOKENS_PER_RUN
  return runsOk && tokensOk
}

function canSpend(n) {
  // n more runs after the tail has been paid
  const runsOk = S.runs + n <= runBudget
  const tokensOk = !TB || TB.remaining() >= n * OUT_TOKENS_PER_RUN
  return runsOk && tokensOk
}

function runsLeftAfterTail() {
  return Math.max(0, runBudget - S.runs - tailCore)
}

function skip(step, reason) {
  S.skipped.push({ step, reason, round: S.round })
  log(`Skipped ${step}: ${reason}.`)
}

const ID_RE = /^([CESOTQ])-([A-Z]{2}\d+)-(\d{2,})$/
const SPEC_RE = /^(SC|CN|AS)-\d+$/

function ownsId(id, prefix, type) {
  const m = ID_RE.exec(text(id))
  return !!m && m[1] === type && m[2] === prefix
}

function isKnown(id) {
  if (!id) return false
  if (S.known[id]) return true
  if (id === 'SPEC') return true
  if (SPEC_RE.test(id)) return specIds.length ? specIds.includes(id) : true
  return false
}

function violate(at, message) {
  S.violations.push({ seq: at.seq, prefix: at.prefix, seat: at.seat, message })
}

function effectiveStatus(o) {
  const target = S.candidates[o.target]
  if (BLOCKING_STATUSES.includes(o.status) && target && target.retired) return 'moot'
  return o.status
}

function blockingObjections() {
  return Object.values(S.objections).filter(
    (o) => BLOCKING_STATUSES.includes(effectiveStatus(o)) && BLOCKING_SEVERITIES.includes(o.severity),
  )
}

// §6.4 — who can move an objection, and where.
function applyUpdate(u, at) {
  const o = u && S.objections[u.objection]
  if (!o) return violate(at, `update to unknown objection ${u && u.objection}`)
  const basis = arr(u.basis)
  const note = text(u.note).trim()
  const isRaiser = at.seat === o.raiser
  let next = null
  switch (u.action) {
    case 'maintain':
      break
    case 'withdraw':
      if (!isRaiser) return violate(at, `only the raiser (${o.raiser}) can withdraw ${o.id}`)
      next = 'withdrawn'
      break
    case 'resolve': {
      const byVerifier = at.seat === 'verifier' && basis.some((id) =>
        (S.evidence[id] && S.evidence[id].verified) ||
        (S.tests[id] && S.tests[id].result === 'pass' && S.tests[id].by === 'verifier'))
      if (!(isRaiser || byVerifier)) {
        return violate(at, `${at.seat} cannot resolve ${o.id}: only the raiser, or the verifier citing verified evidence or a passing test it ran, can (§6.4)`)
      }
      next = 'resolved'
      break
    }
    case 'mitigate':
      if (!note) return violate(at, `mitigation for ${o.id} needs a note`)
      o.mitigation = clip(note, 600)
      o.mitigatedBy = at.prefix
      if (o.status === 'open') next = 'mitigation_proposed'
      break
    case 'reopen':
      if (!(isRaiser || basis.length)) return violate(at, `reopening ${o.id} needs the raiser or new evidence`)
      next = 'open'
      break
    case 'accept_risk':
      if (at.seat !== 'chair' || !note) return violate(at, `only the chair can accept ${o.id} as a risk, with a rationale`)
      next = 'accepted_risk'
      break
    case 'downgrade':
      if (at.seat !== 'chair' || !note || !SEVERITIES.includes(u.severity)) {
        return violate(at, `only the chair can downgrade ${o.id}, with a severity and a rationale`)
      }
      o.severity = u.severity
      break
    default:
      return violate(at, `unknown action ${u.action} on ${o.id}`)
  }
  if (next && o.status !== 'note') o.status = next
  o.history.push({ seq: at.seq, prefix: at.prefix, action: u.action, basis, note: clip(note, 300) })
}

function takeOwned(items, type, store, at, build) {
  for (const x of arr(items)) {
    if (!x || !ownsId(x.id, at.prefix, type)) {
      violate(at, `rejected ${x && x.id}: not a ${type}- id owned by ${at.prefix} (§5.2)`)
      continue
    }
    if (S.known[x.id]) {
      violate(at, `rejected duplicate id ${x.id}`)
      continue
    }
    store[x.id] = build(x)
    S.known[x.id] = type
  }
}

function ingest(e, at) {
  S.entries.push({ seq: at.seq, prefix: at.prefix, seat: at.seat, round: at.round })
  S.entries.sort((a, b) => a.seq - b.seq)
  if (at.seat === 'chair') S.known['R-' + at.prefix] = 'R'

  // 1. evidence; only the verifier can mark it verified (§6.4)
  takeOwned(e.evidence, 'E', S.evidence, at, (x) => ({
    id: x.id,
    title: clip(x.title, 160),
    type: text(x.type),
    locator: clip(x.locator, 300),
    reliability: text(x.reliability),
    verified: at.seat === 'verifier' && x.verified === true,
    by: at.seat,
    seq: at.seq,
  }))
  if (arr(e.evidence_verdicts).length && at.seat !== 'verifier') {
    violate(at, 'only the verifier may issue evidence verdicts')
  } else {
    for (const v of arr(e.evidence_verdicts)) {
      const ev = S.evidence[v && v.evidence]
      if (!ev) {
        violate(at, `verdict on unknown evidence ${v && v.evidence}`)
        continue
      }
      ev.verified = v.verified === true
      if (v.reliability) ev.reliability = v.reliability
      ev.verifiedBy = at.prefix
    }
  }

  // 2. statements (§5.3)
  takeOwned(e.statements, 'C', S.statements, at, (x) => ({
    id: x.id,
    kind: text(x.kind),
    text: clip(x.text, 240),
    evidence: arr(x.evidence),
    load_bearing: x.load_bearing === true,
    by: at.seat,
    seq: at.seq,
    round: at.round,
  }))

  // 3. tests
  takeOwned(e.tests, 'T', S.tests, at, (x) => ({
    id: x.id,
    targets: arr(x.targets),
    result: text(x.result),
    by: at.seat,
    seq: at.seq,
  }))

  // 4. candidates: only the architect proposes, revises and retires them
  for (const c of arr(e.candidates)) {
    if (at.seat !== 'architect') {
      violate(at, `only the architect may propose or revise candidates (${c && c.id})`)
      continue
    }
    const existing = c && S.candidates[c.id]
    if (existing) {
      if (existing.retired) {
        violate(at, `candidate ${c.id} is retired and cannot be revised; propose a new one`)
        continue
      }
      existing.title = clip(c.title, 160) || existing.title
      existing.summary = clip(c.summary, 600) || existing.summary
      existing.version += 1
      existing.lastRevisedSeq = at.seq
      if (c.doc) existing.doc = text(c.doc)
      continue
    }
    if (!c || !ownsId(c.id, at.prefix, 'S')) {
      violate(at, `rejected candidate ${c && c.id}: not an S- id owned by ${at.prefix}`)
      continue
    }
    S.candidates[c.id] = {
      id: c.id,
      title: clip(c.title, 160),
      summary: clip(c.summary, 600),
      doc: text(c.doc),
      by: at.prefix,
      seq: at.seq,
      version: 1,
      lastRevisedSeq: at.seq,
      retired: false,
      retireReason: '',
    }
    S.known[c.id] = 'S'
  }
  for (const r of arr(e.retired_candidates)) {
    const c = r && S.candidates[r.id]
    if (at.seat !== 'architect') violate(at, 'only the architect may retire candidates')
    else if (!c) violate(at, `retire of unknown candidate ${r && r.id}`)
    else {
      c.retired = true
      c.retireReason = clip(r.reason, 300)
    }
  }

  // 5. objections, with the materiality and objector rules (§6.2)
  takeOwned(e.objections, 'O', S.objections, at, (x) => {
    const material = OBJECTORS.includes(at.seat) && isKnown(x.target) && text(x.would_change).trim().length > 0
    return {
      id: x.id,
      target: text(x.target),
      severity: SEVERITIES.includes(x.severity) ? x.severity : 'low',
      claim: clip(x.claim, 400),
      resolves_if: clip(x.resolves_if, 300),
      raiser: at.seat,
      raiserPrefix: at.prefix,
      seq: at.seq,
      round: at.round,
      status: material ? 'open' : 'note',
      mitigation: '',
      mitigatedBy: '',
      history: [{ seq: at.seq, prefix: at.prefix, action: material ? 'raise' : 'raise_note', basis: [], note: '' }],
    }
  })

  // 6. red-team coverage (C3)
  if (at.seat === 'red-team') {
    for (const id of arr(e.targets_reviewed)) if (S.candidates[id]) S.rtReviewed[id] = at.seq
  }

  // 7. open questions
  takeOwned(e.questions, 'Q', S.questions, at, (x) => ({
    id: x.id,
    text: clip(x.text, 240),
    route_to: text(x.route_to),
    by: at.seat,
    seq: at.seq,
  }))

  // 8. chair: accepted uncertainties (C2)
  if (at.seat === 'chair') {
    for (const id of arr(e.accepted_uncertainties)) {
      if (isKnown(id) && !S.acceptedUncertainties.includes(id)) S.acceptedUncertainties.push(id)
    }
  }

  // 9. objection updates last, so they can cite evidence and tests from this same entry
  for (const u of arr(e.objection_updates)) applyUpdate(u, at)
}

// §7 — the stopping protocol, computed from the ledger.
function computeGates() {
  const cands = Object.values(S.candidates)
  const live = cands.filter((c) => !c.retired)
  const blocking = blockingObjections()
  const verified = (id) => !!(S.evidence[id] && S.evidence[id].verified)
  const facts = Object.values(S.statements).filter((s) => s.kind === 'fact')
  const unsupportedFacts = facts.filter((s) => !s.evidence.some(verified)).map((s) => s.id)
  const supported = (s) =>
    S.acceptedUncertainties.includes(s.id) ||
    s.evidence.some(verified) ||
    Object.values(S.tests).some((t) => t.result === 'pass' && t.targets.includes(s.id))
  const loadBearing = Object.values(S.statements)
    .filter((s) => s.kind === 'assumption' && s.load_bearing && !supported(s))
    .map((s) => s.id)
  const unattacked = live.filter((c) => !((S.rtReviewed[c.id] || 0) > c.lastRevisedSeq)).map((c) => c.id)
  const firstCandidate = cands.length ? Math.min(...cands.map((c) => c.seq)) : Infinity
  const validated = S.entries.some((e) => e.seat === 'verifier' && e.seq > firstCandidate)
  const newBlocking = blocking.filter((o) => o.round === S.round).map((o) => o.id)
  const hasRT = T.critics.includes('red-team')
  const gate = (met, detail) => ({ met, detail })
  const gates = {
    C1: gate(blocking.length === 0, blocking.map((o) => `${o.id} (${o.severity}, ${effectiveStatus(o)})`)),
    C2: gate(loadBearing.length === 0, loadBearing),
    C3: hasRT ? gate(unattacked.length === 0, unattacked) : gate(true, ['red team not seated']),
    C4: gate(cands.length >= 2, [`${cands.length} candidate(s) considered, ${live.length} active`]),
    C5: gate(unsupportedFacts.length === 0, unsupportedFacts),
    C6: T.verifier ? gate(validated, [validated ? 'validated after candidates existed' : 'no validation after candidates existed']) : gate(true, ['verifier not seated']),
    C7: gate(newBlocking.length === 0, newBlocking),
  }
  const hard = ['C1', 'C4']
  if (hasRT) hard.push('C3')
  if (T.verifier) hard.push('C6')
  return { gates, hard, hardMet: hard.every((k) => gates[k].met), failingHard: hard.filter((k) => !gates[k].met) }
}

function ledgerCounts() {
  const count = (o) => Object.keys(o).length
  const byStatus = {}
  for (const o of Object.values(S.objections)) {
    const st = effectiveStatus(o)
    byStatus[st] = (byStatus[st] || 0) + 1
  }
  return {
    entries: S.entries.length,
    statements: count(S.statements),
    evidence: count(S.evidence),
    verified_evidence: Object.values(S.evidence).filter((e) => e.verified).length,
    candidates: count(S.candidates),
    active_candidates: Object.values(S.candidates).filter((c) => !c.retired).length,
    objections: count(S.objections),
    objections_by_status: byStatus,
    tests: count(S.tests),
    questions: count(S.questions),
    violations: S.violations.length,
  }
}

// The digest every seat receives (§8.7). `full` adds statements and evidence for the seats that integrate.
function snapshot(full, extra) {
  const G = computeGates()
  const verified = (id) => !!(S.evidence[id] && S.evidence[id].verified)
  const out = {
    tier,
    round: S.round,
    max_rounds: maxRounds,
    budget: { run_budget: runBudget, runs_used: S.runs, runs_left_after_tail: runsLeftAfterTail() },
    candidates: Object.values(S.candidates).map((c) => ({
      id: c.id, title: c.title, summary: clip(c.summary, 300), version: c.version, retired: c.retired, by: c.by, doc: c.doc,
    })),
    objections: Object.values(S.objections).map((o) => ({
      id: o.id, raiser: o.raiser, target: o.target, severity: o.severity, status: effectiveStatus(o),
      claim: clip(o.claim, 240), resolves_if: clip(o.resolves_if, 160), mitigation: clip(o.mitigation, 200),
    })),
    tests: Object.values(S.tests).map((t) => ({ id: t.id, targets: t.targets, result: t.result, by: t.by })),
    accepted_uncertainties: S.acceptedUncertainties,
    counts: ledgerCounts(),
    gates: G.gates,
    hard_gates: G.hard,
    hard_gates_met: G.hardMet,
    recent_violations: S.violations.slice(-6),
  }
  if (full) {
    out.statements = Object.values(S.statements).slice(-200).map((s) => ({
      id: s.id, kind: s.kind, by: s.by, text: clip(s.text, 160), evidence: s.evidence,
      supported: s.evidence.some(verified), load_bearing: s.load_bearing,
    }))
    out.evidence = Object.values(S.evidence).slice(-150).map((e) => ({
      id: e.id, title: clip(e.title, 80), type: e.type, reliability: e.reliability, verified: e.verified, by: e.by,
    }))
    out.questions = Object.values(S.questions).slice(-60).map((q) => ({ id: q.id, text: clip(q.text, 160), route_to: q.route_to }))
  }
  return Object.assign(out, extra || {})
}

// ---------------------------------------------------------------------------
// Calling a seat
// ---------------------------------------------------------------------------

let curPhase = ''
function setPhase(t) {
  curPhase = t
  phase(t)
}

function sit(seatKey, modeName, task, o) {
  const opts = o || {}
  const seat = SEATS[seatKey]
  if (S.runs >= runBudget) {
    return Promise.resolve({ seatKey, modeName, prefix: null, seq: null, round: S.round, result: null, error: 'run budget exhausted' })
  }
  const n = (S.counters[seatKey] || 0) + 1
  S.counters[seatKey] = n
  const prefix = seat.code + n
  const seq = S.seq + 1
  S.seq = seq
  const round = S.round
  const tag = `${pad(seq)}-r${round}-${prefix}`
  S.runs += 1
  const lines = [
    `You are sitting as the ${seat.name} of the deliberation council. Mode: ${modeName}.`,
    'Follow your seat instructions for this mode and the council constitution.',
    '',
    `Run directory: ${runDir}`,
    `Problem spec: ${runDir}/01-problem-spec.md (machine-readable: ${runDir}/spec.json)`,
    `Round: ${round}`,
    `Your entry prefix: ${prefix}. Every ID you create must embed it: C-${prefix}-01, E-${prefix}-01, S-${prefix}-01, O-${prefix}-01, T-${prefix}-01, Q-${prefix}-01.`,
  ]
  if (opts.lens) lines.push(`Lens: ${opts.lens}`)
  lines.push(
    `Write-up file (${WRITEUP_WORDS} words at most): ${runDir}/notes/${tag}.md`,
    `Entry file: ${runDir}/entries/${tag}.json`,
    `Write the write-up first, then the entry file containing byte-for-byte the JSON object you return. Set "seat" to "${seatKey}", "entry_id" to "${prefix}" and "writeup" to the write-up path.`,
    `Budget: this council is capped at ${runBudget} agent runs and this is run ${S.runs}. Stay within your turn limit, and keep your last turns for writing the two files and returning the JSON.`,
  )
  if (opts.blind) {
    lines.push(`Visibility: BLIND. Work only from the spec, the brief and your own research. Do not read ${runDir}/entries/, ${runDir}/notes/ or ${runDir}/candidates/.`)
  } else if (opts.blindFrom) {
    lines.push(`Visibility: other seats are working on this step in parallel. Read the ledger in ${runDir}/entries/ and ${runDir}/notes/ only as needed, and do not read files numbered ${pad(opts.blindFrom)} or higher.`)
  } else {
    lines.push(`Ledger: start from the digest below; open files in ${runDir}/entries/, ${runDir}/notes/ and ${runDir}/candidates/ only when you need detail.`)
  }
  if (directives.length) lines.push(`User directives (binding): ${directives.join(' | ')}`)
  let prompt = lines.join('\n') + '\n\n## Task\n' + task
  if (opts.context) prompt += '\n\n## Council digest\n```json\n' + JSON.stringify(opts.context) + '\n```'
  let pending
  try {
    pending = agent(prompt, {
      agentType: `${PLUGIN}:${seatKey}`,
      label: `${seat.name} · ${prefix}`,
      phase: opts.phase || curPhase,
      effort: seat.effort,
      schema: opts.schema || ENTRY_SCHEMA,
    })
  } catch (err) {
    pending = Promise.reject(err)
  }
  return Promise.resolve(pending).then(
    (result) => ({ seatKey, modeName, prefix, seq, round, result: result || null, error: result ? '' : 'no result' }),
    (err) => ({ seatKey, modeName, prefix, seq, round, result: null, error: String((err && err.message) || err) }),
  )
}

// Ingest results in sequence order so a replay from disk is deterministic.
function settle(results) {
  const sorted = arr(results).filter(Boolean).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0))
  for (const r of sorted) {
    if (!r.result) {
      S.failures.push({ seat: r.seatKey, mode: r.modeName, prefix: r.prefix, seq: r.seq, error: r.error || 'no result' })
      log(`${SEATS[r.seatKey].name}${r.prefix ? ` (${r.prefix})` : ''} returned nothing: ${r.error || 'no result'}.`)
      continue
    }
    ingest(r.result, { seat: r.seatKey, prefix: r.prefix, seq: r.seq, round: r.round })
  }
  return sorted
}

async function one(seatKey, modeName, task, opts) {
  const r = await sit(seatKey, modeName, task, opts)
  settle([r])
  return r.result
}

async function many(thunks) {
  if (!thunks.length) return []
  return settle(await parallel(thunks))
}

// ---------------------------------------------------------------------------
// Tasks. Detailed instructions live in each seat's agent file.
// ---------------------------------------------------------------------------

const REVIEW_FIRST = 'First review your own open objections in the digest against the mitigations, revisions, tests and evidence: maintain, withdraw, resolve or reopen each, with a note citing IDs.'
const TASK = {
  investigate: 'Investigate the problem in the spec through your lens. Record facts with evidence IDs, tag every statement (§5.3), list the sources, tools, skills, plugins and MCP servers the problem could rely on as evidence items, and record open questions with route_to. Do not recommend a solution or raise objections.',
  extraResearch: (reason) => `The Chair added this run: ${reason}. Investigate through your lens, building on the ledger rather than repeating it.`,
  verify: 'Verify the evidence behind every fact statement so far: issue evidence_verdicts, add contradicting evidence you find, and check that the tools, skills, plugins and MCP servers listed are real and usable in this session. Rank the sources in your write-up; that ranking is the trust register.',
  design: 'Design one complete candidate through your lens. Give it an S- ID and write candidates/<id>.md: the approach, a step-by-step execution plan (prerequisites, owners, order), an integration map (components, interfaces, data flow), the success criteria it meets, what it rests on (IDs), known weaknesses and cost.',
  designBoth: 'Design two genuinely different complete candidates: one conventional (the strongest well-established approach) and one fundamentally different (another discipline, an emerging method, automation, or a reframing). Give each an S- ID and write candidates/<id>.md: approach, step-by-step execution plan, integration map, success criteria met, what it rests on (IDs), weaknesses and cost.',
  designAgain: (n) => `The council has only ${n} candidate(s). Design one genuinely different complete candidate now (§7 C4), with its candidate document.`,
  challengeDA: (solo) => `${REVIEW_FIRST} Then attack the reasoning behind every active candidate and the statements it rests on: hidden assumptions, contradictions, unsupported facts, alternative interpretations.${solo ? ' There is no Red Team in this council, so also attack whether each candidate can actually be built and run with what exists.' : ''} Raise only material objections (§6.2), list every ID you reviewed in targets_reviewed, and never propose fixes.`,
  challengeRT: `${REVIEW_FIRST} Then assume each active candidate has been built and try to make it fail: hostile input, dependency loss, scale, misuse, adversaries, and whether it can actually be built, integrated and operated with what exists. Demonstrate cheap attacks safely where you can. List every active candidate you attacked in targets_reviewed; skipping one blocks convergence (§7 C3). Raise only material objections and never propose fixes.`,
  validate: `${REVIEW_FIRST} Then turn open objections and disputed or load-bearing claims into tests: run what can be run safely (code, calculations, benchmarks, dry runs) and design the rest. Verify the evidence behind disputed facts. Resolve an objection only with a passing test you ran or verified evidence that settles it (§6.4), and report failures plainly.`,
  revise: 'Respond to every open objection against the candidates: mitigate with a concrete note, revise the candidate (same ID, update its document), or retire it. You cannot resolve or withdraw objections (§6.4). Change only what the objections require.',
  reopen: 'The user reopened this decision with the binding directives above. Revise, add or retire candidates so the directives are met, and mitigate the objections they affect. You cannot resolve objections.',
  gate: (i, G) => `Rule on round ${i} of ${maxRounds}. Hard gates for this tier: ${G.hard.join(', ')}; ${G.hardMet ? 'all met' : 'failing: ' + G.failingHard.join(', ')}. ${runsLeftAfterTail()} agent run(s) remain after reserving synthesis${T.audit ? ' and the audit' : ''}. Decide continue, converged, escalate or halt, and address every failing soft gate in the rationale. Routes go only to architect, devils-advocate, red-team or verifier; they become instructions in those seats' next runs and never add runs. add_seats may request an extra researcher or red-team run with a lens; it is honoured only if the budget still covers the remaining rounds. Ask the closing question (§7).`,
  synthesize: (outcome, carried) => `Integrate the ledger. Outcome of deliberation: ${outcome}.${carried.length ? ` Blocking objections carried as open risks: ${carried.join(', ')}.` : ''} Write synthesis.md (council state, decision matrix, recommendation, dissent) and, from the templates, final/00-final-decision.md, final/01-decision-record.md and final/05-runbook.md. Quote every dissent in the dissenter's terms and list every ID you cited in cited_ids.`,
  audit: (unknown) => `Audit independently: you have not seen this work before, so start from the spec. Grade every success criterion met, partial or unmet with basis IDs; check unsupported claims, hidden assumptions, overlooked alternatives, unresolved objections, rule violations, and whether the recommendation can actually be implemented. Check final/00-final-decision.md, final/01-decision-record.md and final/05-runbook.md against the ledger.${unknown.length ? ` The narrative documents cite IDs that are not in the ledger: ${unknown.join(', ')}; treat each as a gap.` : ''} Pass only if the recommendation solves the specified problem and every gap is fixed or honestly recorded as a condition or risk. Route each remediation item to one seat, most important first; only the first seat's items can be fixed within the budget.`,
  remediate: (items) => `The Auditor failed the audit. Fix these items from your seat, citing IDs: ${items.join(' | ')}`,
}

const RESEARCH_PADS = [
  'domain: the most relevant specialist domain named in the spec',
  'prior art: how similar problems were solved elsewhere, and how those solutions failed',
]
function researchLenses() {
  const lenses = ['general: the facts, constraints, prior work and available tools this problem depends on']
  for (const d of domains) if (lenses.length < T.researchers) lenses.push(`domain: ${d}`)
  for (const p of RESEARCH_PADS) if (lenses.length < T.researchers) lenses.push(p)
  return lenses.slice(0, T.researchers)
}
const DESIGN_LENSES = [
  'conventional: the strongest well-established approach to the problem as specified',
  'alternative: a fundamentally different approach, from another discipline, an emerging method, automation, or a reframing that dissolves the problem',
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

log(`Council ${mode === 'reopen' ? 'reopened' : 'convened'}: ${tier} tier, up to ${maxRounds} round(s), budget ${runBudget} agent runs.`)

if (mode === 'reopen') {
  setPhase('Reopen')
  const prior = A.priorState
  if (!prior || typeof prior.seq !== 'number') {
    return { status: 'error', message: `Reopen needs priorState: run council_ledger.py state "${runDir}" --json and pass its output.` }
  }
  hydrate(prior)
  await one('architect', 'reopen', TASK.reopen, { context: snapshot() })
} else {
  setPhase('Investigation')
  await many(researchLenses().map((lens) => () => sit('researcher', 'investigate', TASK.investigate, { blind: true, lens })))

  if (T.verifier) {
    setPhase('Verification')
    await one('verifier', 'verify', TASK.verify, { context: snapshot(true) })
  }

  setPhase('Design')
  if (T.architects >= 2) {
    await many(DESIGN_LENSES.slice(0, T.architects).map((lens) => () =>
      sit('architect', 'design', TASK.design, { blind: true, lens, context: snapshot(true) })))
  } else {
    await one('architect', 'design', TASK.designBoth, { context: snapshot(true) })
  }
  const nCand = Object.keys(S.candidates).length
  if (nCand < 2) {
    if (canAfford(1 + roundBase)) {
      await one('architect', 'design', TASK.designAgain(nCand), { context: snapshot(true), lens: DESIGN_LENSES[1] })
    } else {
      skip('a second design run', 'run or token budget')
    }
  }
}

let outcome = 'round_cap'
const routes = {}
const extras = []
const startRound = S.round

const routedTask = (task, seat) => {
  const mine = routes[seat] || []
  delete routes[seat]
  return mine.length ? `${task}\n\nThe Chair routed this to you: ${mine.join(' | ')}` : task
}

for (let i = 1; i <= maxRounds; i++) {
  if (i === 1 && !canAfford(roundBase)) {
    outcome = 'budget'
    skip('round 1', 'run or token budget')
    break
  }
  const r = startRound + i
  S.round = r

  const moreResearch = extras.filter((x) => x.seat === 'researcher')
  const moreRedTeam = extras.filter((x) => x.seat === 'red-team')
  extras.length = 0
  if (moreResearch.length) {
    setPhase(`Round ${r} · added research`)
    await many(moreResearch.map((x) => () =>
      sit('researcher', 'investigate', TASK.extraResearch(x.reason), { lens: x.lens, context: snapshot(true) })))
  }

  setPhase(`Round ${r} · challenge`)
  const from = S.seq + 1
  const attacks = T.critics.map((seat) => () => sit(seat, 'challenge',
    routedTask(seat === 'red-team' ? TASK.challengeRT : TASK.challengeDA(T.critics.length === 1), seat),
    { context: snapshot(), blindFrom: from }))
  for (const x of moreRedTeam) {
    attacks.push(() => sit('red-team', 'challenge', TASK.challengeRT, { context: snapshot(), blindFrom: from, lens: x.lens }))
  }
  await many(attacks)

  if (T.verifier) {
    setPhase(`Round ${r} · validation`)
    await one('verifier', 'validate', routedTask(TASK.validate, 'verifier'), { context: snapshot(true) })
  }

  setPhase(`Round ${r} · gate`)
  let decision
  if (T.chairGate) {
    const before = computeGates()
    const gateCall = await sit('chair', 'gate', TASK.gate(i, before), { context: snapshot(), schema: RULING_SCHEMA })
    settle([gateCall])
    const ruling = gateCall.result
    const G = computeGates()
    const record = {
      id: gateCall.prefix ? 'R-' + gateCall.prefix : 'R-none',
      round: r,
      decision: ruling ? ruling.decision : 'none',
      rationale: ruling ? clip(ruling.rationale, 1200) : 'The Chair returned no ruling.',
      hard_gates_met: G.hardMet,
      overridden: '',
      effective: '',
    }
    if (!ruling) {
      decision = G.hardMet ? 'converged' : 'continue'
      record.overridden = `no ruling; the workflow applied the hard gates (${decision})`
    } else {
      for (const x of arr(ruling.routes)) {
        if (ROUTABLE.includes(x.to_seat)) {
          (routes[x.to_seat] = routes[x.to_seat] || []).push(text(x.instruction) + (x.objection ? ` (objection ${x.objection})` : ''))
        } else {
          skip(`a route to ${x.to_seat}`, 'only the architect, devils-advocate, red-team and verifier take routed work')
        }
      }
      for (const a of arr(ruling.add_seats)) {
        const seat = a && a.seat
        if (!EXTRA_SEATS.includes(seat)) skip(`an extra ${seat} run`, 'only researcher or red-team runs can be added')
        else if (seat === 'red-team' && !T.critics.includes('red-team')) skip('an extra red-team run', `the ${tier} tier has no Red Team`)
        else if (S.extraRuns >= MAX_EXTRA_RUNS) skip(`an extra ${seat} run`, `at most ${MAX_EXTRA_RUNS} extra runs per session`)
        else if (i >= maxRounds) skip(`an extra ${seat} run`, 'no round left to use it')
        else if (!canAfford(extras.length + 1 + roundsCost(maxRounds - i) + 1)) skip(`an extra ${seat} run`, 'run or token budget')
        else {
          extras.push({
            seat,
            lens: text(a.lens) || (seat === 'red-team' ? 'execution and integration: can this be built, connected and operated with what exists?' : 'the gap the Chair named'),
            reason: text(a.reason),
          })
          S.extraRuns += 1
        }
      }
      decision = ruling.decision
      if (decision === 'escalate') {
        const esc = Object.assign(
          { question: record.rationale, options: [], provisional_default: '', blocking: true },
          ruling.escalation || {},
          { round: r, ruling: record.id },
        )
        S.escalations.push(esc)
        if (esc.blocking) {
          record.effective = 'escalate'
          S.rulings.push(record)
          outcome = 'needs_input'
          break
        }
        decision = G.hardMet ? 'converged' : 'continue'
        record.overridden = `non-blocking escalation carried to sign-off; treated as ${decision}`
      }
      if (decision === 'halt') {
        record.effective = 'halt'
        S.rulings.push(record)
        outcome = 'halted'
        break
      }
      if (decision === 'converged' && !G.hardMet) {
        decision = 'continue'
        record.overridden = `convergence refused: hard gates failing (${G.failingHard.join(', ')})`
        log(`Round ${r}: the Chair ruled converged but ${G.failingHard.join(', ')} failed; deliberation continues.`)
      }
      if (decision !== 'converged') decision = 'continue'
    }
    record.effective = decision
    S.rulings.push(record)
  } else {
    const G = computeGates()
    decision = G.hardMet ? 'converged' : 'continue'
    S.rulings.push({
      id: 'R-code',
      round: r,
      decision,
      rationale: G.hardMet ? 'Hard gates met.' : `Hard gates failing: ${G.failingHard.join(', ')}.`,
      hard_gates_met: G.hardMet,
      overridden: '',
      effective: decision,
    })
  }

  if (decision === 'converged') {
    outcome = 'converged'
    break
  }
  if (i === maxRounds) break

  // Revision, then the next round, only if the budget still covers both and the tail (§8.2).
  while (extras.length && !canAfford(1 + roundBase + extras.length)) {
    const x = extras.pop()
    S.extraRuns -= 1
    skip(`the extra ${x.seat} run`, 'run or token budget')
  }
  if (!canAfford(1 + roundBase + extras.length)) {
    outcome = 'budget'
    skip(`round ${r + 1}`, 'run or token budget')
    break
  }
  setPhase(`Round ${r} · revision`)
  await one('architect', 'revise', routedTask(TASK.revise, 'architect'), { context: snapshot(true) })
}

if (outcome === 'needs_input') {
  return {
    status: 'needs_input',
    runDir,
    tier,
    round: S.round,
    escalation: S.escalations[S.escalations.length - 1],
    run_budget: runBudget,
    runs_used: S.runs,
    failures: S.failures,
    skipped: S.skipped,
    ledger_counts: ledgerCounts(),
    state: A.debug ? exportState() : undefined,
  }
}

const carried = outcome === 'round_cap' || outcome === 'budget' ? blockingObjections().map((o) => o.id) : []
if (carried.length) log(`Deliberation ended (${outcome}) with ${carried.length} blocking objection(s) carried as open risks.`)

let synth = null
let audit = null
let remediated = false
let unaddressed = []
const traceCheck = (s) => ({ unknown: uniq(arr(s && s.cited_ids).filter((id) => !isKnown(id))) })
let trace = { unknown: [] }

if (outcome !== 'halted') {
  setPhase('Synthesis')
  synth = await one('synthesizer', 'synthesize', TASK.synthesize(outcome, carried), { context: snapshot(true, { outcome, carried }), schema: SYNTH_SCHEMA })
  trace = traceCheck(synth)

  if (T.audit) {
    setPhase('Audit')
    audit = await one('auditor', 'audit', TASK.audit(trace.unknown), { context: snapshot(true, { outcome, carried }), schema: AUDIT_SCHEMA })
    if (audit && audit.verdict === 'fail') {
      const items = arr(audit.remediation).filter((x) => x && REMEDIABLE.includes(x.to_seat))
      const seat = items.length ? items[0].to_seat : null
      const cost = seat === 'synthesizer' ? 2 : REMEDIATION_RUNS
      if (!seat) {
        skip('remediation', 'the Auditor routed no fixable items')
      } else if (!canSpend(cost)) {
        skip('remediation', 'run or token budget')
        unaddressed = items.map((x) => `${x.to_seat}: ${text(x.instruction)}`)
      } else {
        remediated = true
        const mine = items.filter((x) => x.to_seat === seat).map((x) => text(x.instruction))
        unaddressed = items.filter((x) => x.to_seat !== seat).map((x) => `${x.to_seat}: ${text(x.instruction)}`)
        if (unaddressed.length) skip(`remediation for ${uniq(items.filter((x) => x.to_seat !== seat).map((x) => x.to_seat)).join(', ')}`, 'one remediation run per session; listed as open gaps')
        setPhase('Remediation')
        if (seat !== 'synthesizer') await one(seat, 'remediate', TASK.remediate(mine), { context: snapshot(true) })
        const fixTask = TASK.synthesize(outcome, carried) + (seat === 'synthesizer'
          ? ` This is a re-synthesis to fix these audit findings: ${mine.join(' | ')}`
          : ' This is a re-synthesis after remediation.')
        synth = (await one('synthesizer', 'synthesize', fixTask, { context: snapshot(true, { outcome, carried }), schema: SYNTH_SCHEMA })) || synth
        trace = traceCheck(synth)
        audit = (await one('auditor', 'audit', TASK.audit(trace.unknown) + ' This is the re-audit after one remediation; this verdict is final.', { context: snapshot(true, { outcome, carried }), schema: AUDIT_SCHEMA })) || audit
      }
    }
  }
}

const incomplete = []
if (outcome !== 'halted') {
  if (!Object.keys(S.candidates).length) incomplete.push('no candidate solutions were produced')
  if (!synth || !synth.recommendation) incomplete.push('the Synthesizer produced no recommendation')
  if (T.audit && !audit) incomplete.push('the Auditor did not run or returned nothing')
}
const status = outcome === 'halted' ? 'halted' : incomplete.length ? 'incomplete' : 'ready_for_signoff'
const finalGates = computeGates()

return {
  status,
  outcome,
  runDir,
  tier,
  rounds: S.round - startRound,
  max_rounds: maxRounds,
  run_budget: runBudget,
  runs_used: S.runs,
  extra_runs: S.extraRuns,
  recommendation: synth ? synth.recommendation : null,
  dissent: synth ? arr(synth.dissent) : [],
  audit: audit
    ? { verdict: audit.verdict, remediated, gaps: arr(audit.gaps), criteria: arr(audit.criteria), unaddressed }
    : { verdict: T.audit ? 'missing' : 'not_in_tier', remediated: false, gaps: [], criteria: [], unaddressed },
  gates: finalGates.gates,
  hard_gates: finalGates.hard,
  carried_risks: carried,
  escalations: S.escalations.filter((e) => !e.blocking),
  rulings: S.rulings,
  violations: S.violations.length,
  failures: S.failures,
  skipped: S.skipped,
  incomplete_reasons: incomplete,
  files: synth ? arr(synth.files_written) : [],
  trace,
  ledger_counts: ledgerCounts(),
  state: A.debug ? exportState() : undefined,
}
