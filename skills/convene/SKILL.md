---
name: convene
description: Convene the eight-seat deliberation council on a hard problem. Frames it, gets your approval of the spec and budget, runs the deliberation inside a hard agent-run budget, and brings you an audited decision package to sign off.
argument-hint: "<problem statement> [--tier quick|standard|deep] [--rounds N] [--budget N]"
disable-model-invocation: true
---

# Convene the deliberation council

You run the user-facing side of the council: intake, the two human checkpoints, escalations, and the Recorder. The deliberation itself runs in the `council:deliberate` workflow, which enforces the procedure and the budget in code. The rules are in `${CLAUDE_PLUGIN_ROOT}/CONSTITUTION.md`; read §3, §4, §8 and §9 before you start.

The user's request: $ARGUMENTS

Keep the user informed in short lines (framing, spec ready, deliberation running, package ready). Don't narrate every step.

## The ledger tool

Every script step uses `${CLAUDE_PLUGIN_ROOT}/scripts/council_ledger.py` with Python 3. Call it as `python3 "<path>" ...`; if `python3` isn't found, use `python`, and on Windows `py -3`. Use whichever works for every later call. If no Python 3 is available, tell the user the council needs Python 3.8 or later and stop.

## 1. Parse the request

- The problem is the request without its flags.
- `--tier quick|standard|deep` fixes the tier (`full` means `deep`); otherwise the Chair picks it.
- `--rounds N` (1–5) and `--budget N` (agent runs inside the workflow, 4–60) override the tier's defaults.
- If the problem is empty or too vague to state an objective, ask the user for it in one question and stop.

## 2. Create the run

1. Run `council_ledger.py new <three to six words from the problem>`. It creates `.council/<timestamp>-<slug>/` with its subfolders and prints the path. That path is the **run directory**.
2. Write `00-brief.md` in it: the problem verbatim, the flags, and the paths of any files or links the user referenced (paths only; don't copy large files).

## 3. Frame the problem

Delegate to the Chair with the Agent tool, `subagent_type` `council:chair`:

> Mode: framing. Run directory: `<run directory>`. Read `00-brief.md` and write `01-problem-spec.md`, `spec.json` and `02-intake.json` as your seat instructions describe. Reply with the summary.

If the user fixed the tier, rounds or budget, add: "The user fixed tier = X / max_rounds = N / budget = B; keep them."

Read `spec.json` and `02-intake.json` yourself.

## 4. Checkpoint 1: approve the spec and budget

Show the user, compactly:

- the objective;
- the success criteria (`SC-n`) with how each will be checked;
- hard constraints (`CN-n`) and load-bearing assumptions (`AS-n`);
- out of scope, and any open questions the Chair raised;
- the tier, domains and round cap, and the **budget**: at most B agent runs in the workflow plus the one framing run already spent. Each run is a separate model session, so this is the cost ceiling.

Ask with AskUserQuestion: **Approve and start** (recommended) · **Edit the spec** · **Change the tier or budget** · **Cancel**.

- Edit: delegate to `council:chair` with "Mode: revise-spec. Run directory: … Feedback: …", show what changed, and ask again. Pass the user's answers to the Chair's open questions the same way.
- Change the tier or budget: update `tier`, `max_rounds` and `budget` in `02-intake.json` (defaults: quick 6, standard 19, deep 25) and ask again.
- Cancel: say the run folder is kept for reference and stop.

## 5. Run the deliberation

Collect `specIds`: every `id` under `success_criteria`, `constraints` and `assumptions` in `spec.json`.

Start the `council:deliberate` workflow with the Workflow tool, passing `args` as a JSON object (not a string):

```json
{
  "runDir": "<run directory>",
  "tier": "<tier>",
  "domains": ["<domains from 02-intake.json>"],
  "maxRounds": <max_rounds>,
  "budget": <budget>,
  "specIds": ["SC-1", "..."],
  "mode": "fresh",
  "plugin": "council"
}
```

Tell the user it is running in the background within a budget of B agent runs, and that `/workflows` shows live progress. Wait for the result before continuing.

If the Workflow tool isn't available (dynamic workflows are off), tell the user to turn on **Dynamic workflows** in `/config` and run `/council:convene` again.

## 6. Record the result

Whatever the status (except `error`):

1. If `result.json` already exists in the run directory (a reopened run), copy it first to `result-run-<n>.json`, with n the next free number.
2. Write the workflow's return value to `<run directory>/result.json` exactly as returned.
3. Run `council_ledger.py render "<run directory>"`. This is the Recorder: it writes the argument log, resource register, experiment log, open risks, process record and round minutes.
4. Run `council_ledger.py check "<run directory>"` and keep its errors for the user.

## 7. Handle the status

- **`error`**: report the message and stop.
- **`needs_input`** (a blocking escalation): show the question, the options and the Chair's provisional default, and ask with AskUserQuestion. Then reopen (step 9) with the answer as a binding directive.
- **`halted`**: show the Chair's halt rationale from `result.json` and stop.
- **`incomplete`**: say plainly what is missing (`incomplete_reasons`, `failures`), and that the package is not a finished decision. Offer to reopen with a larger budget (step 9), or to stop here.
- **`ready_for_signoff`**: go to step 8.

## 8. Checkpoint 2: sign off

Read `final/00-final-decision.md` and `final/06-open-risks.md`, then show the user:

- the recommendation, its confidence and conditions;
- the audit verdict, and whether a remediation ran;
- dissent, in the dissenter's terms;
- carried risks (blocking objections left open by the round cap or the budget) and accepted risks;
- non-blocking escalations, with the default the council used;
- steps the budget skipped, failed hard or soft gates, rule violations, seat failures and check errors, if any;
- agent runs used out of the budget, and the path to `final/`.

Ask with AskUserQuestion. Put the sign-off first; add one question per non-blocking escalation (up to three), each offering the provisional default (recommended) and the alternatives:

- **Accept**: write `SIGNOFF.md` in the run directory with the decision (candidate ID and title), today's date, accepted risks and conditions, and the user's answers to escalations. Tell the user where the package is.
- **Reopen with changes**: ask what should change, then reopen (step 9).
- **Reject**: write `SIGNOFF.md` recording the rejection and the reason, and stop.

If an escalation answer differs from the provisional default but the user chose Accept, confirm once whether they want to reopen, since the package was built on the default.

## 9. Reopen

1. Run `council_ledger.py state "<run directory>" --json` and parse its output as `priorState`.
2. Start `council:deliberate` again with the same `runDir`, `tier`, `domains`, `specIds` and `plugin`, plus `"mode": "reopen"`, `"maxRounds": 2`, `"priorState": <the parsed object>`, and `"directives": ["<each change or answer, stated as a binding instruction>"]`. Pass `"budget"` only if the user asked for a specific one; the default covers one Architect run, two rounds, synthesis and the audit.
3. Return to step 6 when it finishes.
