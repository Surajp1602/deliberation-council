# Deliberation Council

A Claude Code plugin that puts a hard problem in front of an eight-seat council of specialised agents instead of one model. The seats research it blind, design competing solutions, attack and test them, and converge into an audited decision package with a complete, traceable record, all inside a hard budget of agent runs.

```
/council:convene Should we migrate our Flask monolith to FastAPI services this quarter? --tier standard
```

## How it works

- **The procedure lives in code.** `workflows/deliberate.js` is a dynamic workflow. Phases, parallel runs, rounds, the stopping protocol and the budget are enforced by the script, so no attack or audit is skipped and the Chair can't declare convergence while hard gates fail.
- **Judgment lives in the seats.** Eight agents in `agents/`, each a different kind of check. The Chair rules at each round gate and the script obeys the ruling within the rules.
- **The ledger is the source of truth.** Every seat returns a schema-checked JSON entry and writes it to `.council/<run-id>/entries/`. IDs embed the seat's run prefix, so parallel seats never collide.
- **Objections are tracked like bugs.** The designer can never close an objection against its own work. Only the raiser, or the Verifier citing verified evidence or a passing test, can resolve one.
- **The record can't be bent.** The Recorder (`scripts/council_ledger.py render`) builds the argument log, resource register, experiment log, open risks and process record straight from the ledger.
- **Two human checkpoints.** You approve the problem spec and budget before deliberation, and sign off on the package after it. Value trade-offs the council shouldn't settle alone come to you.

The full rules are in [`CONSTITUTION.md`](CONSTITUTION.md).

## The council

| Seat | Job | Covers these roles from the original 15-seat design |
|---|---|---|
| Chair | Frames the problem, picks the tier, rules at each gate | Chairman, Problem Architect |
| Researcher | Builds the facts through one lens per run, blind | Lead Researcher, Domain Specialist |
| Architect | Designs complete candidates; two design blind in parallel | Strategist, Innovation Scientist, Practical Thinker (execution plan), Systems & Integration Engineer (integration map) |
| Devil's Advocate | Attacks the reasoning | Devil's Advocate |
| Red Team | Attacks the solution as built, run and integrated | Red Team, plus the feasibility and integration attacks |
| Verifier | Verifies sources and tools, runs the tests | Evidence & Sources Auditor, Experimenter |
| Synthesizer | Writes the recommendation, decision record and runbook | Synthesis & Decision Analyst, Documentation Head (narrative) |
| Auditor | Independent final audit against the spec | Quality & Completeness Auditor |
| Recorder (a script, no tokens) | Renders the record from the ledger | Documentation Head (records) |

## Budgets

Every agent run is a separate model session, so the plugin caps them. The cap is a hard limit enforced in code. Synthesis and the audit are always paid for first; when the budget runs out, deliberation stops and open objections are recorded as risks.

| Tier | Seats used | Rounds | Agent runs per session (incl. framing) | Use for |
|---|---|---|---|---|
| `quick` | Chair, Researcher, Architect, Devil's Advocate, Synthesizer | up to 2 | 5–7 | Bounded, low-stakes problems |
| `standard` | all 8 | up to 2 | 12–20 (typically 17) | Most real decisions |
| `deep` | all 8, three Researchers | up to 3 | 13–26 (typically 18) | High-stakes, novel or cross-domain problems |

The Chair picks the tier from the spec; `--tier`, `--rounds` and `--budget` override it. On a big problem, go wider by adding Researcher runs, not seats. If you set a per-turn token target in Claude Code, the council respects it too and still reserves enough for synthesis and the audit.

## Requirements

- **Claude Code** with **Dynamic workflows** turned on (`/config` → Dynamic workflows).
- **Python 3.8+** for the ledger tool and Recorder (`python3`, `python` or `py -3`). Optional: `pip install jsonschema` for full schema validation of entries.
- **Node.js 18+** only to run the test suite.

## Install

From GitHub, so you get updates with `claude plugin update`:

```bash
claude plugin marketplace add Surajp1602/deliberation-council
claude plugin install council@deliberation-council
```

Or in one step from inside a Claude Code session:

```
/plugin install council --marketplace Surajp1602/deliberation-council
```

To try it for one session without installing, point Claude Code at a local copy:

```bash
claude --plugin-dir ./deliberation-council
```

To update later: `claude plugin update council@deliberation-council`.

### Recommended permissions

A run writes many files into `.council/` and calls the ledger tool. To avoid a prompt per seat, allow these in your project's `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Write(.council/**)",
      "Edit(.council/**)",
      "Bash(python3 *council_ledger.py*)",
      "Bash(python *council_ledger.py*)",
      "Bash(py -3 *council_ledger.py*)",
      "WebSearch",
      "WebFetch",
      "Workflow(council:deliberate)"
    ]
  }
}
```

The Red Team, Verifier and Auditor may ask to run commands for tests. Approve those case by case.

## Usage

```
/council:convene <problem statement> [--tier quick|standard|deep] [--rounds N] [--budget N]
```

1. **Framing.** The Chair writes the spec (objective, success criteria `SC-n`, constraints `CN-n`, assumptions `AS-n`) and picks the tier, domains and budget.
2. **Checkpoint 1.** You approve, edit the spec, change the tier or budget, or cancel.
3. **Deliberation** runs in the background. Watch it with `/workflows`.
4. **Checkpoint 2.** You see the recommendation, conditions, audit verdict, dissent, open risks, escalations and the runs used, then accept, reopen with changes, or reject. Reopening reloads the ledger from disk and continues the same run with its own budget.

## What a run produces

```
.council/<run-id>/
  00-brief.md  01-problem-spec.md  spec.json  02-intake.json
  entries/       one JSON entry per seat run (append-only)
  notes/         the write-up behind each entry (600 words at most)
  candidates/    candidate documents
  experiments/   test code, data and results
  minutes/       round minutes (Recorder)
  synthesis.md   result.json
  final/
    00-final-decision.md    01-decision-record.md    05-runbook.md        (Synthesizer)
    02-argument-log.md      03-resource-register.md  04-experiment-log.md
    06-open-risks.md        07-process-record.md                          (Recorder)
  SIGNOFF.md
```

## Checking a run

```bash
python3 scripts/council_ledger.py check  .council/<run-id>   # validate entries, gates, traceability
python3 scripts/council_ledger.py status .council/<run-id>   # objections, candidates and gates
python3 scripts/council_ledger.py render .council/<run-id>   # re-render the Recorder documents
```

## Customising

- **Models, effort and turn limits per seat**: the `model`, `effort` and `maxTurns` fields in each `agents/*.md`. The workflow also sets each seat's effort per run (`SEATS` in `workflows/deliberate.js`); keep the two in step.
- **Tiers, rounds and budgets**: `TIERS` in the workflow and §3 of the constitution. Default budgets are derived from the tier, so changing the seats or rounds changes the budget automatically.
- **Hard gates**: `computeGates()` in the workflow and `Ledger.gates()` in the ledger tool. Change both; the tests check they agree.

## Development

```bash
node --test                        # 30 end-to-end tests with a fake council (run from the plugin root)
node tests/export_schemas.mjs      # regenerate schemas/*.json after changing a schema
claude plugin validate .           # check the plugin loads
```

The tests run the real workflow script against a fake council that reads the same prompts and writes the same files real seats do. They cover the run counts of each tier, adversarial worst cases staying inside every cap, the reserved synthesis and audit under a small budget and under a token target, `incomplete` instead of `ready_for_signoff` when a key seat fails, routing and extra runs, remediation, every objection permission, exact agreement between the workflow's ledger and the Python replay, the Recorder, and reopening from disk.

## Why eight seats

The first design had fifteen. Measured against the workflow code, its worst case reached 110 agent runs in one session (172 with five rounds), and the most expensive runs produced the weakest answers. Eight seats keep every separation that makes a council better than one agent: nobody grades their own work, facts are checked by someone who didn't find them, research and design start blind, and the final audit is fresh. Research on multi-agent systems points the same way: gains come from independent attempts and verification, not from more personas of one model debating.

- [How we built our multi-agent research system (Anthropic)](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296)
- [Debate or Vote: Which Yields Better Decisions in Multi-Agent LLMs?](https://arxiv.org/abs/2508.17536)

## License

MIT. See [LICENSE](LICENSE).
