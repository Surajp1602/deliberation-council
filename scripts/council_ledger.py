#!/usr/bin/env python3
"""Council ledger tool and Recorder for the deliberation council.

Commands:
  new <title words...> [--root DIR]  create a run directory and print its path
  validate <run-dir>                 schema and naming checks on every entry file
  state <run-dir> [--json]           replay the ledger; --json is what a reopened workflow hydrates from
  status <run-dir>                   objections, candidates and the stopping-protocol gates
  render <run-dir>                   the Recorder: write the argument log, resource register, experiment log,
                                     open risks, process record and round minutes from the ledger
  trace <run-dir>                    check that final/ cites only real IDs and records every objection and dissent
  check <run-dir>                    validate + status + trace; exits 1 if anything is wrong

The replay applies exactly the rules in workflows/deliberate.js (CONSTITUTION.md sections 5 to 7).
Standard library only (Python 3.8+). If the jsonschema package is installed, entries are also
validated against schemas/entry.schema.json.
"""

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent

SEATS = {
    "chair": "CH",
    "researcher": "RS",
    "architect": "AR",
    "devils-advocate": "DA",
    "red-team": "RT",
    "verifier": "VE",
    "synthesizer": "SY",
    "auditor": "QA",
}
CODE_TO_SEAT = {code: seat for seat, code in SEATS.items()}
SEAT_NAMES = {
    "chair": "Chair",
    "researcher": "Researcher",
    "architect": "Architect",
    "devils-advocate": "Devil's Advocate",
    "red-team": "Red Team",
    "verifier": "Verifier",
    "synthesizer": "Synthesizer",
    "auditor": "Auditor",
}
OBJECTORS = ["devils-advocate", "red-team", "verifier"]
TIERS = {
    "quick": {"red_team": False, "verifier": False},
    "standard": {"red_team": True, "verifier": True},
    "deep": {"red_team": True, "verifier": True},
}
TIER_ALIASES = {"full": "deep"}

SEVERITIES = ["critical", "high", "medium", "low"]
BLOCKING_SEVERITIES = ["critical", "high"]
BLOCKING_STATUSES = ["open", "mitigation_proposed"]

ENTRY_FILE_RE = re.compile(r"^(\d{3,})-r(\d+)-([A-Z]{2})(\d+)\.json$")
NOTE_FILE_RE = re.compile(r"^(\d{3,})-r(\d+)-([A-Z]{2})(\d+)\.md$")
ID_RE = re.compile(r"^([CESOTQ])-([A-Z]{2}\d+)-(\d{2,})$")
SPEC_RE = re.compile(r"^(SC|CN|AS)-\d+$")
CITE_RE = re.compile(r"\b(?:[CESOTQ]-[A-Z]{2}\d+-\d{2,}|R-CH\d+|SC-\d+|CN-\d+|AS-\d+)\b")

FINAL_FILES = [
    "00-final-decision.md",
    "01-decision-record.md",
    "02-argument-log.md",
    "03-resource-register.md",
    "04-experiment-log.md",
    "05-runbook.md",
    "06-open-risks.md",
    "07-process-record.md",
]
RECORDER_NOTE = "_Rendered from the ledger by the Recorder (`council_ledger.py render`). Do not edit by hand; rerun the command instead._"


def text(x):
    return x if isinstance(x, str) else ""


def arr(x):
    return x if isinstance(x, list) else []


def clip(x, n):
    s = text(x)
    return s[: n - 1] + "\u2026" if len(s) > n else s


def cell(x, n=None):
    s = x if isinstance(x, str) else ("" if x is None else str(x))
    if n:
        s = clip(s, n)
    return s.replace("\\", "\\\\").replace("|", "\\|").replace("\r", "").replace("\n", "<br>") or "—"


def seat_name(seat):
    return SEAT_NAMES.get(seat, seat or "?")


# ---------------------------------------------------------------------------
# Replay: mirrors ingest(), applyUpdate() and computeGates() in workflows/deliberate.js
# ---------------------------------------------------------------------------


class Ledger:
    def __init__(self, spec_ids=None, tier="standard"):
        self.spec_ids = list(spec_ids or [])
        self.tier = TIER_ALIASES.get(tier, tier) if TIER_ALIASES.get(tier, tier) in TIERS else "standard"
        self.S = {
            "seq": 0,
            "round": 0,
            "counters": {},
            "known": {},
            "statements": {},
            "evidence": {},
            "candidates": {},
            "objections": {},
            "tests": {},
            "questions": {},
            "rtReviewed": {},
            "acceptedUncertainties": [],
            "violations": [],
            "entries": [],
        }
        self.full = {}  # id -> {"item": raw item, "at": call} for the Recorder; not part of the state
        self.raw = []  # (at, entry) in sequence order

    # -- helpers -------------------------------------------------------------

    def owns_id(self, id_, prefix, type_):
        m = ID_RE.match(text(id_))
        return bool(m) and m.group(1) == type_ and m.group(2) == prefix

    def is_known(self, id_):
        if not id_:
            return False
        if id_ in self.S["known"]:
            return True
        if id_ == "SPEC":
            return True
        if SPEC_RE.match(id_):
            return id_ in self.spec_ids if self.spec_ids else True
        return False

    def violate(self, at, message):
        self.S["violations"].append({"seq": at["seq"], "prefix": at["prefix"], "seat": at["seat"], "message": message})

    def effective_status(self, o):
        target = self.S["candidates"].get(o["target"])
        if o["status"] in BLOCKING_STATUSES and target and target["retired"]:
            return "moot"
        return o["status"]

    def blocking(self):
        return [
            o
            for o in self.S["objections"].values()
            if self.effective_status(o) in BLOCKING_STATUSES and o["severity"] in BLOCKING_SEVERITIES
        ]

    # -- section 6.4 ---------------------------------------------------------

    def apply_update(self, u, at):
        S = self.S
        o = S["objections"].get(u.get("objection")) if isinstance(u, dict) else None
        if not o:
            return self.violate(at, "update to unknown objection %s" % (u.get("objection") if isinstance(u, dict) else None))
        basis = arr(u.get("basis"))
        note = text(u.get("note")).strip()
        is_raiser = at["seat"] == o["raiser"]
        action = u.get("action")
        nxt = None
        if action == "maintain":
            pass
        elif action == "withdraw":
            if not is_raiser:
                return self.violate(at, "only the raiser (%s) can withdraw %s" % (o["raiser"], o["id"]))
            nxt = "withdrawn"
        elif action == "resolve":
            by_verifier = at["seat"] == "verifier" and any(
                (i in S["evidence"] and S["evidence"][i]["verified"])
                or (i in S["tests"] and S["tests"][i]["result"] == "pass" and S["tests"][i]["by"] == "verifier")
                for i in basis
            )
            if not (is_raiser or by_verifier):
                return self.violate(
                    at,
                    "%s cannot resolve %s: only the raiser, or the verifier citing verified evidence "
                    "or a passing test it ran, can (\u00a76.4)" % (at["seat"], o["id"]),
                )
            nxt = "resolved"
        elif action == "mitigate":
            if not note:
                return self.violate(at, "mitigation for %s needs a note" % o["id"])
            o["mitigation"] = clip(note, 600)
            o["mitigatedBy"] = at["prefix"]
            if o["status"] == "open":
                nxt = "mitigation_proposed"
        elif action == "reopen":
            if not (is_raiser or basis):
                return self.violate(at, "reopening %s needs the raiser or new evidence" % o["id"])
            nxt = "open"
        elif action == "accept_risk":
            if at["seat"] != "chair" or not note:
                return self.violate(at, "only the chair can accept %s as a risk, with a rationale" % o["id"])
            nxt = "accepted_risk"
        elif action == "downgrade":
            if at["seat"] != "chair" or not note or u.get("severity") not in SEVERITIES:
                return self.violate(at, "only the chair can downgrade %s, with a severity and a rationale" % o["id"])
            o["severity"] = u.get("severity")
        else:
            return self.violate(at, "unknown action %s on %s" % (action, o["id"]))
        if nxt and o["status"] != "note":
            o["status"] = nxt
        o["history"].append({"seq": at["seq"], "prefix": at["prefix"], "action": action, "basis": basis, "note": clip(note, 300)})

    def take_owned(self, items, type_, store, at, build):
        for x in arr(items):
            xid = x.get("id") if isinstance(x, dict) else None
            if not isinstance(x, dict) or not self.owns_id(xid, at["prefix"], type_):
                self.violate(at, "rejected %s: not a %s- id owned by %s (\u00a75.2)" % (xid, type_, at["prefix"]))
                continue
            if xid in self.S["known"]:
                self.violate(at, "rejected duplicate id %s" % xid)
                continue
            store[xid] = build(x)
            self.S["known"][xid] = type_
            self.full[xid] = {"item": x, "at": at}

    # -- ingest --------------------------------------------------------------

    def ingest(self, e, at):
        S = self.S
        S["entries"].append({"seq": at["seq"], "prefix": at["prefix"], "seat": at["seat"], "round": at["round"]})
        S["entries"].sort(key=lambda x: x["seq"])
        self.raw.append((at, e))
        if at["seat"] == "chair":
            S["known"]["R-" + at["prefix"]] = "R"

        # 1. evidence; only the verifier can mark it verified
        self.take_owned(
            e.get("evidence"),
            "E",
            S["evidence"],
            at,
            lambda x: {
                "id": x["id"],
                "title": clip(x.get("title"), 160),
                "type": text(x.get("type")),
                "locator": clip(x.get("locator"), 300),
                "reliability": text(x.get("reliability")),
                "verified": at["seat"] == "verifier" and x.get("verified") is True,
                "by": at["seat"],
                "seq": at["seq"],
            },
        )
        if arr(e.get("evidence_verdicts")) and at["seat"] != "verifier":
            self.violate(at, "only the verifier may issue evidence verdicts")
        else:
            for v in arr(e.get("evidence_verdicts")):
                ev = S["evidence"].get(v.get("evidence")) if isinstance(v, dict) else None
                if not ev:
                    self.violate(at, "verdict on unknown evidence %s" % (v.get("evidence") if isinstance(v, dict) else None))
                    continue
                ev["verified"] = v.get("verified") is True
                if v.get("reliability"):
                    ev["reliability"] = v.get("reliability")
                ev["verifiedBy"] = at["prefix"]

        # 2. statements
        self.take_owned(
            e.get("statements"),
            "C",
            S["statements"],
            at,
            lambda x: {
                "id": x["id"],
                "kind": text(x.get("kind")),
                "text": clip(x.get("text"), 240),
                "evidence": arr(x.get("evidence")),
                "load_bearing": x.get("load_bearing") is True,
                "by": at["seat"],
                "seq": at["seq"],
                "round": at["round"],
            },
        )

        # 3. tests
        self.take_owned(
            e.get("tests"),
            "T",
            S["tests"],
            at,
            lambda x: {
                "id": x["id"],
                "targets": arr(x.get("targets")),
                "result": text(x.get("result")),
                "by": at["seat"],
                "seq": at["seq"],
            },
        )

        # 4. candidates: only the architect proposes, revises and retires them
        for c in arr(e.get("candidates")):
            cid = c.get("id") if isinstance(c, dict) else None
            if at["seat"] != "architect":
                self.violate(at, "only the architect may propose or revise candidates (%s)" % cid)
                continue
            existing = S["candidates"].get(cid) if cid else None
            if existing:
                if existing["retired"]:
                    self.violate(at, "candidate %s is retired and cannot be revised; propose a new one" % cid)
                    continue
                existing["title"] = clip(c.get("title"), 160) or existing["title"]
                existing["summary"] = clip(c.get("summary"), 600) or existing["summary"]
                existing["version"] += 1
                existing["lastRevisedSeq"] = at["seq"]
                if c.get("doc"):
                    existing["doc"] = text(c.get("doc"))
                continue
            if not isinstance(c, dict) or not self.owns_id(cid, at["prefix"], "S"):
                self.violate(at, "rejected candidate %s: not an S- id owned by %s" % (cid, at["prefix"]))
                continue
            S["candidates"][cid] = {
                "id": cid,
                "title": clip(c.get("title"), 160),
                "summary": clip(c.get("summary"), 600),
                "doc": text(c.get("doc")),
                "by": at["prefix"],
                "seq": at["seq"],
                "version": 1,
                "lastRevisedSeq": at["seq"],
                "retired": False,
                "retireReason": "",
            }
            S["known"][cid] = "S"
            self.full[cid] = {"item": c, "at": at}
        for r in arr(e.get("retired_candidates")):
            rid = r.get("id") if isinstance(r, dict) else None
            c = S["candidates"].get(rid) if rid else None
            if at["seat"] != "architect":
                self.violate(at, "only the architect may retire candidates")
            elif not c:
                self.violate(at, "retire of unknown candidate %s" % rid)
            else:
                c["retired"] = True
                c["retireReason"] = clip(r.get("reason"), 300)

        # 5. objections, with the materiality and objector rules
        def build_objection(x):
            material = at["seat"] in OBJECTORS and self.is_known(x.get("target")) and len(text(x.get("would_change")).strip()) > 0
            return {
                "id": x["id"],
                "target": text(x.get("target")),
                "severity": x.get("severity") if x.get("severity") in SEVERITIES else "low",
                "claim": clip(x.get("claim"), 400),
                "resolves_if": clip(x.get("resolves_if"), 300),
                "raiser": at["seat"],
                "raiserPrefix": at["prefix"],
                "seq": at["seq"],
                "round": at["round"],
                "status": "open" if material else "note",
                "mitigation": "",
                "mitigatedBy": "",
                "history": [
                    {"seq": at["seq"], "prefix": at["prefix"], "action": "raise" if material else "raise_note", "basis": [], "note": ""}
                ],
            }

        self.take_owned(e.get("objections"), "O", S["objections"], at, build_objection)

        # 6. red-team coverage
        if at["seat"] == "red-team":
            for i in arr(e.get("targets_reviewed")):
                if i in S["candidates"]:
                    S["rtReviewed"][i] = at["seq"]

        # 7. questions
        self.take_owned(
            e.get("questions"),
            "Q",
            S["questions"],
            at,
            lambda x: {
                "id": x["id"],
                "text": clip(x.get("text"), 240),
                "route_to": text(x.get("route_to")),
                "by": at["seat"],
                "seq": at["seq"],
            },
        )

        # 8. accepted uncertainties
        if at["seat"] == "chair":
            for i in arr(e.get("accepted_uncertainties")):
                if self.is_known(i) and i not in S["acceptedUncertainties"]:
                    S["acceptedUncertainties"].append(i)

        # 9. updates
        for u in arr(e.get("objection_updates")):
            self.apply_update(u, at)

    # -- section 7 -----------------------------------------------------------

    def gates(self):
        S = self.S
        cfg = TIERS[self.tier]
        cands = list(S["candidates"].values())
        live = [c for c in cands if not c["retired"]]
        blocking = self.blocking()

        def verified(i):
            return i in S["evidence"] and S["evidence"][i]["verified"]

        facts = [s for s in S["statements"].values() if s["kind"] == "fact"]
        unsupported = [s["id"] for s in facts if not any(verified(i) for i in s["evidence"])]

        def supported(s):
            return (
                s["id"] in S["acceptedUncertainties"]
                or any(verified(i) for i in s["evidence"])
                or any(t["result"] == "pass" and s["id"] in t["targets"] for t in S["tests"].values())
            )

        load_bearing = [
            s["id"] for s in S["statements"].values() if s["kind"] == "assumption" and s["load_bearing"] and not supported(s)
        ]
        unattacked = [c["id"] for c in live if not (S["rtReviewed"].get(c["id"], 0) > c["lastRevisedSeq"])]
        first_candidate = min(c["seq"] for c in cands) if cands else float("inf")
        validated = any(e["seat"] == "verifier" and e["seq"] > first_candidate for e in S["entries"])
        new_blocking = [o["id"] for o in blocking if o["round"] == S["round"]]

        def gate(met, detail):
            return {"met": bool(met), "detail": detail}

        g = {
            "C1": gate(not blocking, ["%s (%s, %s)" % (o["id"], o["severity"], self.effective_status(o)) for o in blocking]),
            "C2": gate(not load_bearing, load_bearing),
            "C3": gate(not unattacked, unattacked) if cfg["red_team"] else gate(True, ["red team not seated"]),
            "C4": gate(len(cands) >= 2, ["%d candidate(s) considered, %d active" % (len(cands), len(live))]),
            "C5": gate(not unsupported, unsupported),
            "C6": gate(validated, ["validated after candidates existed" if validated else "no validation after candidates existed"])
            if cfg["verifier"]
            else gate(True, ["verifier not seated"]),
            "C7": gate(not new_blocking, new_blocking),
        }
        hard = ["C1", "C4"] + (["C3"] if cfg["red_team"] else []) + (["C6"] if cfg["verifier"] else [])
        return {"gates": g, "hard": hard, "hardMet": all(g[k]["met"] for k in hard)}


# ---------------------------------------------------------------------------
# Loading a run directory
# ---------------------------------------------------------------------------


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def walk_ids(node, out):
    if isinstance(node, dict):
        for v in node.values():
            walk_ids(v, out)
    elif isinstance(node, list):
        for v in node:
            walk_ids(v, out)
    elif isinstance(node, str) and SPEC_RE.match(node):
        out.add(node)


def load_spec_ids(run):
    spec = read_json(run / "spec.json")
    if spec is None:
        return []
    ids = set()
    walk_ids(spec, ids)
    return sorted(ids)


def load_tier(run):
    for name in ("result.json", "02-intake.json"):
        data = read_json(run / name, {})
        if isinstance(data, dict) and data.get("tier"):
            t = TIER_ALIASES.get(data["tier"], data["tier"])
            if t in TIERS:
                return t
    return "standard"


def entry_files(run):
    d = run / "entries"
    if not d.is_dir():
        return []
    out = []
    for p in d.iterdir():
        m = ENTRY_FILE_RE.match(p.name)
        if m:
            out.append((int(m.group(1)), int(m.group(2)), m.group(3), int(m.group(4)), p))
    out.sort(key=lambda t: t[0])
    return out


def replay(run):
    ledger = Ledger(load_spec_ids(run), load_tier(run))
    problems = []
    for seq, rnd, code, n, path in entry_files(run):
        seat = CODE_TO_SEAT.get(code)
        prefix = "%s%d" % (code, n)
        if not seat:
            problems.append("%s: unknown seat code %s" % (path.name, code))
            continue
        entry = read_json(path)
        if not isinstance(entry, dict):
            problems.append("%s: not a valid JSON object" % path.name)
            continue
        at = {"seat": seat, "prefix": prefix, "seq": seq, "round": rnd}
        ledger.ingest(entry, at)
        ledger.S["seq"] = max(ledger.S["seq"], seq)
        ledger.S["round"] = max(ledger.S["round"], rnd)
        ledger.S["counters"][seat] = max(ledger.S["counters"].get(seat, 0), n)
    # a seat run that failed still used its number: take it from result.json, or from a note it left
    result = read_json(run / "result.json", {})
    for f in arr(result.get("failures")) if isinstance(result, dict) else []:
        m = re.match(r"^([A-Z]{2})(\d+)$", text(f.get("prefix")))
        seat = CODE_TO_SEAT.get(m.group(1)) if m else None
        if seat and isinstance(f.get("seq"), int):
            ledger.S["seq"] = max(ledger.S["seq"], f["seq"])
            ledger.S["counters"][seat] = max(ledger.S["counters"].get(seat, 0), int(m.group(2)))
    notes = run / "notes"
    if notes.is_dir():
        for p in notes.iterdir():
            m = NOTE_FILE_RE.match(p.name)
            seat = CODE_TO_SEAT.get(m.group(3)) if m else None
            if seat:
                ledger.S["seq"] = max(ledger.S["seq"], int(m.group(1)))
                ledger.S["counters"][seat] = max(ledger.S["counters"].get(seat, 0), int(m.group(4)))
    return ledger, problems


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------


def cmd_validate(run):
    errors, warnings = [], []
    d = run / "entries"
    if not d.is_dir():
        return ["no entries/ directory in %s" % run], warnings
    for p in d.iterdir():
        if p.suffix == ".json" and not ENTRY_FILE_RE.match(p.name):
            warnings.append("%s: file name does not match NNN-rR-XXn.json; it is ignored" % p.name)
    validator = None
    try:
        import jsonschema  # noqa: F401

        schema = json.loads((PLUGIN_ROOT / "schemas" / "entry.schema.json").read_text(encoding="utf-8"))
        validator = jsonschema.Draft202012Validator(schema)
    except Exception:  # jsonschema missing or schema unreadable: structural checks only
        validator = None
    seen = set()
    files = entry_files(run)
    for seq, rnd, code, n, p in files:
        if seq in seen:
            errors.append("%s: duplicate sequence number %d" % (p.name, seq))
        seen.add(seq)
        entry = read_json(p)
        if not isinstance(entry, dict):
            errors.append("%s: not a valid JSON object" % p.name)
            continue
        seat = CODE_TO_SEAT.get(code)
        prefix = "%s%d" % (code, n)
        if not seat:
            errors.append("%s: unknown seat code %s" % (p.name, code))
            continue
        if entry.get("seat") != seat:
            errors.append("%s: seat is %r, expected %r" % (p.name, entry.get("seat"), seat))
        if entry.get("entry_id") != prefix:
            errors.append("%s: entry_id is %r, expected %r" % (p.name, entry.get("entry_id"), prefix))
        for key in ("position", "confidence", "statements", "objections", "objection_updates", "resources_used"):
            if key not in entry:
                errors.append("%s: missing required field %s" % (p.name, key))
        if validator is not None:
            for err in sorted(validator.iter_errors(entry), key=lambda e: list(e.path)):
                loc = "/".join(str(x) for x in err.path) or "(root)"
                errors.append("%s: schema: %s: %s" % (p.name, loc, err.message))
    if files:
        seqs = sorted(seen)
        gaps = sorted(set(range(1, seqs[-1] + 1)) - set(seqs))
        if gaps:
            warnings.append(
                "missing entry numbers %s (a seat failed or did not write its entry)" % ", ".join(str(g) for g in gaps)
            )
    if validator is None:
        warnings.append("jsonschema not installed: structural checks only (pip install jsonschema for full checks)")
    return errors, warnings


# ---------------------------------------------------------------------------
# trace (C8)
# ---------------------------------------------------------------------------


def latest_entry(ledger, seat):
    found = [e for at, e in ledger.raw if at["seat"] == seat]
    return found[-1] if found else None


def cmd_trace(run, ledger):
    errors, warnings = [], []
    final = run / "final"
    if not final.is_dir():
        return ["no final/ directory yet"], warnings
    cited = set()
    for p in sorted(final.glob("*.md")):
        cited.update(CITE_RE.findall(p.read_text(encoding="utf-8")))
    # Recorder documents quote the ledger verbatim, so only the model-written narrative is checked for invented IDs.
    unknown = narrative_unknown_ids(run, ledger)
    if unknown:
        errors.append("the narrative documents cite IDs that are not in the ledger: %s" % ", ".join(unknown))
    missing = sorted(i for i in ledger.S["objections"] if i not in cited)
    if missing:
        errors.append("objections missing from the final package (C8): %s" % ", ".join(missing))
    synth = latest_entry(ledger, "synthesizer")
    if synth:
        dissent_ids = {i for d in arr(synth.get("dissent")) if isinstance(d, dict) for i in arr(d.get("ids"))}
        miss_d = sorted(i for i in dissent_ids if i not in cited)
        if miss_d:
            errors.append("dissent IDs missing from the final package (C8): %s" % ", ".join(miss_d))
    for name in FINAL_FILES:
        if not (final / name).exists():
            warnings.append("final/%s is missing" % name)
    return errors, warnings


# ---------------------------------------------------------------------------
# The Recorder
# ---------------------------------------------------------------------------


def history_path(h_list):
    steps = []
    for h in h_list:
        s = "%s by %s" % (h.get("action"), h.get("prefix"))
        if h.get("basis"):
            s += " [basis: %s]" % ", ".join(h["basis"])
        if h.get("note"):
            s += ": %s" % h["note"]
        steps.append(s)
    return " → ".join(steps)


def full_text(ledger, id_, field, fallback=""):
    rec = ledger.full.get(id_)
    if rec and isinstance(rec["item"], dict):
        return text(rec["item"].get(field)) or fallback
    return fallback


def raised_by(ledger, o):
    return "%s (%s)" % (seat_name(o["raiser"]), o["raiserPrefix"])


def render_argument_log(ledger):
    S = ledger.S
    lines = ["# Argument log", "", RECORDER_NOTE, "",
             "Every objection raised in this run, whatever its status. Claims are quoted exactly as raised.", ""]
    objs = sorted(S["objections"].values(), key=lambda o: o["seq"])
    if not objs:
        lines.append("No objections were raised.")
    else:
        lines += ["| ID | Raised by | Round | Severity | Target | Claim | Resolves if | Path to resolution | Final status |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for o in objs:
            claim = full_text(ledger, o["id"], "claim", o["claim"])
            resolves = full_text(ledger, o["id"], "resolves_if", o["resolves_if"])
            lines.append("| %s | %s | %s | %s | %s | \u201c%s\u201d | %s | %s | %s |" % (
                o["id"], cell(raised_by(ledger, o)), o["round"], o["severity"], cell(o["target"]),
                cell(claim), cell(resolves), cell(history_path(o["history"])), ledger.effective_status(o)))
    lines += ["", "## Rule violations", ""]
    if S["violations"]:
        for v in S["violations"]:
            lines.append("- #%s %s (%s): %s" % (v["seq"], v["prefix"], seat_name(v["seat"]), v["message"]))
    else:
        lines.append("None.")
    return "\n".join(lines) + "\n"


def render_resource_register(ledger):
    S = ledger.S
    lines = ["# Resource register", "", RECORDER_NOTE, "", "## Evidence and sources", ""]
    used_by = {}
    for s in S["statements"].values():
        for i in s["evidence"]:
            used_by.setdefault(i, []).append(s["id"])
    evs = sorted(S["evidence"].values(), key=lambda e: e["seq"])

    def status(e):
        if e["verified"]:
            return "verified"
        return "rejected" if "verifiedBy" in e else "not checked"

    if not evs:
        lines.append("No evidence was recorded.")
    else:
        lines += ["| ID | Resource | Type | Locator | Reliability | Status | Checked by | Cited by |", "|---|---|---|---|---|---|---|---|"]
        for e in evs:
            lines.append("| %s | %s | %s | %s | %s | %s | %s | %s |" % (
                e["id"], cell(e["title"]), e["type"], cell(full_text(ledger, e["id"], "locator", e["locator"])),
                e["reliability"], status(e), e.get("verifiedBy", "—"), cell(", ".join(used_by.get(e["id"], [])))))
    lines += ["", "## Tools, skills, MCP servers and plugins used", ""]
    agg = {}
    for at, entry in ledger.raw:
        for r in arr(entry.get("resources_used")):
            if not isinstance(r, dict):
                continue
            key = (text(r.get("name")), text(r.get("type")))
            rec = agg.setdefault(key, {"seats": [], "purposes": []})
            if at["prefix"] not in rec["seats"]:
                rec["seats"].append(at["prefix"])
            p = clip(r.get("purpose"), 80)
            if p and p not in rec["purposes"] and len(rec["purposes"]) < 3:
                rec["purposes"].append(p)
    if not agg:
        lines.append("No resources were declared.")
    else:
        lines += ["| Resource | Type | Used by | Purposes |", "|---|---|---|---|"]
        for (name, typ), rec in sorted(agg.items()):
            lines.append("| %s | %s | %s | %s |" % (cell(name), cell(typ), cell(", ".join(rec["seats"])), cell("; ".join(rec["purposes"]))))
    lines += ["", "## What not to trust", ""]
    bad = [e for e in evs if status(e) == "rejected" or e["reliability"] == "low"]
    if not bad:
        lines.append("Nothing was rejected or rated low.")
    for e in bad:
        lines.append("- %s %s (%s, %s); cited by %s" % (
            e["id"], e["title"], status(e), e["reliability"] or "unrated", ", ".join(used_by.get(e["id"], [])) or "nothing"))
    return "\n".join(lines) + "\n"


def render_experiment_log(ledger):
    S = ledger.S
    settled = {}
    for o in S["objections"].values():
        for h in o["history"]:
            if h["action"] == "resolve":
                for b in h["basis"]:
                    settled.setdefault(b, []).append(o["id"])
    lines = ["# Experiment log", "", RECORDER_NOTE, ""]
    tests = sorted(S["tests"].values(), key=lambda t: t["seq"])
    if not tests:
        lines.append("No tests were recorded.")
    else:
        lines += ["| ID | Run by | Hypothesis | Method | Result | Targets | Settled | Detail / rerun | Artifact |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for t in tests:
            rec = ledger.full.get(t["id"], {"item": {}, "at": {}})
            item = rec["item"]
            lines.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
                t["id"], rec["at"].get("prefix", "?"), cell(text(item.get("hypothesis"))), cell(text(item.get("method"))),
                t["result"], cell(", ".join(t["targets"])), cell(", ".join(settled.get(t["id"], []))),
                cell(text(item.get("detail"))), cell(text(item.get("artifact")))))
    pending = [t for t in tests if t["result"] in ("designed", "not_run")]
    lines += ["", "## Designed but not run", ""]
    if not pending:
        lines.append("None.")
    for t in pending:
        lines.append("- %s (%s): %s" % (t["id"], t["result"], full_text(ledger, t["id"], "detail") or "no detail given"))
    g = ledger.gates()["gates"]
    lines += ["", "## Load-bearing assumptions without support", ""]
    if not g["C2"]["detail"]:
        lines.append("None.")
    for i in g["C2"]["detail"]:
        lines.append("- %s: %s" % (i, full_text(ledger, i, "text", S["statements"].get(i, {}).get("text", ""))))
    return "\n".join(lines) + "\n"


def render_open_risks(ledger, result, run):
    S = ledger.S
    lines = ["# Open risks", "", RECORDER_NOTE, ""]
    if result is None:
        lines += ["> result.json was not found, so the workflow's carried risks, escalations and skipped steps are not shown.", ""]
    res = result or {}
    carried = arr(res.get("carried_risks")) if result is not None else [o["id"] for o in ledger.blocking()]
    lines += ["## Carried objections", ""]
    if not carried:
        lines.append("None: no blocking objection was left open.")
    for i in carried:
        o = S["objections"].get(i)
        if o:
            lines.append("- **%s** (%s, %s, raised by %s on %s): \u201c%s\u201d Resolves if: %s" % (
                i, o["severity"], ledger.effective_status(o), raised_by(ledger, o), o["target"],
                full_text(ledger, i, "claim", o["claim"]), full_text(ledger, i, "resolves_if", o["resolves_if"]) or "not stated"))
    lines += ["", "## Accepted risks", ""]
    accepted = [o for o in S["objections"].values() if o["status"] == "accepted_risk"]
    if not accepted:
        lines.append("None.")
    for o in accepted:
        why = [h for h in o["history"] if h["action"] == "accept_risk"]
        lines.append("- **%s** (%s): \u201c%s\u201d Accepted by %s: %s" % (
            o["id"], o["severity"], full_text(ledger, o["id"], "claim", o["claim"]),
            why[-1]["prefix"] if why else "?", why[-1]["note"] if why else ""))
    lines += ["", "## Accepted uncertainties", ""]
    if not S["acceptedUncertainties"]:
        lines.append("None.")
    for i in S["acceptedUncertainties"]:
        lines.append("- %s: %s" % (i, full_text(ledger, i, "text", "")))
    g = ledger.gates()["gates"]
    lines += ["", "## Unsupported facts", ""]
    if not g["C5"]["detail"]:
        lines.append("None: every fact cites verified evidence.")
    for i in g["C5"]["detail"]:
        lines.append("- %s: %s" % (i, full_text(ledger, i, "text", "")))
    lines += ["", "## Load-bearing assumptions with no support", ""]
    if not g["C2"]["detail"]:
        lines.append("None: every load-bearing assumption is supported, tested or accepted.")
    for i in g["C2"]["detail"]:
        lines.append("- %s: %s" % (i, full_text(ledger, i, "text", "")))
    lines += ["", "## Questions raised during the run", ""]
    if not S["questions"]:
        lines.append("None.")
    for q in S["questions"].values():
        lines.append("- %s (for %s): %s" % (q["id"], q["route_to"] or "anyone", full_text(ledger, q["id"], "text", q["text"])))
    lines += ["", "## Escalations for you", ""]
    escs = arr(res.get("escalations"))
    if not escs:
        lines.append("None.")
    for e in escs:
        lines.append("- %s Options: %s. The council proceeded on: %s." % (
            text(e.get("question")), "; ".join(arr(e.get("options"))) or "not given", text(e.get("provisional_default")) or "not given"))
    lines += ["", "## Steps the budget skipped", ""]
    skipped = arr(res.get("skipped"))
    if not skipped:
        lines.append("None.")
    for s in skipped:
        lines.append("- Round %s: %s (%s)" % (s.get("round"), s.get("step"), s.get("reason")))
    audit = res.get("audit") or {}
    lines += ["", "## Audit items not addressed", ""]
    items = arr(audit.get("unaddressed"))
    if not items:
        lines.append("None.")
    for i in items:
        lines.append("- %s" % i)
    lines += ["", "## Record gaps", ""]
    gaps = []
    for f in arr(res.get("failures")):
        gaps.append("Seat run %s (%s, %s) returned nothing: %s" % (f.get("prefix") or "not started", f.get("seat"), f.get("mode"), f.get("error")))
    for r in arr(res.get("incomplete_reasons")):
        gaps.append("Incomplete: %s" % r)
    unknown = narrative_unknown_ids(run, ledger)
    if unknown:
        gaps.append("The narrative documents cite IDs that are not in the ledger: %s" % ", ".join(unknown))
    if not gaps:
        lines.append("None.")
    for gp in gaps:
        lines.append("- %s" % gp)
    return "\n".join(lines) + "\n"


def narrative_unknown_ids(run, ledger):
    cited = set()
    for name in ("00-final-decision.md", "01-decision-record.md", "05-runbook.md"):
        p = run / "final" / name
        if p.exists():
            cited.update(CITE_RE.findall(p.read_text(encoding="utf-8")))
    return sorted(i for i in cited if not ledger.is_known(i))


def render_process_record(run, ledger, result):
    S = ledger.S
    res = result or {}
    audit = res.get("audit") or {}
    lines = ["# Process record", "", RECORDER_NOTE, ""]
    if result is None:
        lines += ["> result.json was not found; budget, rulings and failures come from the workflow result and are missing here.", ""]
    rows = [
        ("Run", run.name),
        ("Tier", res.get("tier") or ledger.tier),
        ("Status", res.get("status", "unknown")),
        ("Outcome", res.get("outcome", "unknown")),
        ("Rounds", "%s of %s" % (res.get("rounds", S["round"]), res.get("max_rounds", "?"))),
        ("Agent runs", "%s of a budget of %s in the workflow, plus 1 framing run" % (res.get("runs_used", len(S["entries"])), res.get("run_budget", "?"))),
        ("Extra runs added by the Chair", res.get("extra_runs", 0)),
        ("Seat runs that returned nothing", len(arr(res.get("failures")))),
        ("Rule violations", len(S["violations"])),
        ("Audit", "%s%s" % (audit.get("verdict", "unknown"), " (after one remediation)" if audit.get("remediated") else "")),
    ]
    lines += ["| Item | Value |", "|---|---|"] + ["| %s | %s |" % (k, cell(str(v))) for k, v in rows]
    lines += ["", "## Runs", "", "| # | Round | Prefix | Seat |", "|---|---|---|---|"]
    for e in S["entries"]:
        lines.append("| %s | %s | %s | %s |" % (e["seq"], e["round"], e["prefix"], seat_name(e["seat"])))
    for f in arr(res.get("failures")):
        lines.append("| %s | — | %s | %s (returned nothing) |" % (f.get("seq") or "—", f.get("prefix") or "—", seat_name(f.get("seat"))))
    lines += ["", "## Rulings", ""]
    rulings = arr(res.get("rulings"))
    if not rulings:
        lines.append("None recorded.")
    else:
        lines += ["| Ruling | Round | Decision | Effective | Override | Rationale |", "|---|---|---|---|---|---|"]
        for r in rulings:
            lines.append("| %s | %s | %s | %s | %s | %s |" % (
                r.get("id"), r.get("round"), r.get("decision"), r.get("effective"), cell(r.get("overridden"), 200), cell(r.get("rationale"), 400)))
    g = ledger.gates()
    terrs, _ = cmd_trace(run, ledger)
    labels = {
        "C1": "no blocking objection open",
        "C2": "load-bearing assumptions supported",
        "C3": "Red Team attacked every active candidate",
        "C4": "at least two candidates",
        "C5": "no unsupported facts",
        "C6": "Verifier validated after candidates existed",
        "C7": "no new blocking objection in the last round",
    }
    lines += ["", "## Stopping protocol at the end", "", "| Gate | Hard | Met | Detail |", "|---|---|---|---|"]
    for k in ["C1", "C2", "C3", "C4", "C5", "C6", "C7"]:
        v = g["gates"][k]
        lines.append("| %s %s | %s | %s | %s |" % (k, labels[k], "yes" if k in g["hard"] else "no", "yes" if v["met"] else "no",
                                                 cell("; ".join(str(x) for x in v["detail"]), 300)))
    c8 = not [e for e in terrs if "C8" in e or "not in the ledger" in e]
    lines.append("| C8 every objection and dissent in the record | checked here | %s | %s |" % (
        "yes" if c8 else "no", cell("; ".join(terrs), 300)))
    lines += ["", "## Minutes", ""]
    rounds = sorted({e["round"] for e in S["entries"] if e["round"] >= 1})
    if not rounds:
        lines.append("No rounds ran.")
    for r in rounds:
        lines.append("- [Round %d](../minutes/round-%d.md)" % (r, r))
    return "\n".join(lines) + "\n"


def render_minutes(ledger, result, rnd):
    S = ledger.S
    calls = [(at, e) for at, e in ledger.raw if at["round"] == rnd]
    seqs = {at["seq"] for at, e in calls}
    lines = ["# Round %d minutes" % rnd, "", RECORDER_NOTE, "",
             "**Runs:** %s" % (", ".join("%s (%s)" % (at["prefix"], seat_name(at["seat"])) for at, e in calls) or "none"), ""]
    lines += ["## Challenges", ""]
    raised = [o for o in S["objections"].values() if o["round"] == rnd]
    if not raised:
        lines.append("No new objections.")
    for o in sorted(raised, key=lambda o: o["seq"]):
        lines.append("- %s, %s, by %s on %s%s: \u201c%s\u201d" % (
            o["id"], o["severity"], raised_by(ledger, o), o["target"], " (note)" if o["status"] == "note" else "",
            full_text(ledger, o["id"], "claim", o["claim"])))
    lines += ["", "## Reviews and mitigations", ""]
    moves = []
    for o in S["objections"].values():
        for h in o["history"]:
            if h["seq"] in seqs and h["action"] not in ("raise", "raise_note"):
                moves.append((h["seq"], "- %s: %s by %s%s%s" % (
                    o["id"], h["action"], h["prefix"], " [basis: %s]" % ", ".join(h["basis"]) if h["basis"] else "",
                    ": %s" % h["note"] if h["note"] else "")))
    if not moves:
        lines.append("None.")
    lines += [m for _, m in sorted(moves)]
    lines += ["", "## Validation", ""]
    tests = [t for t in S["tests"].values() if t["seq"] in seqs]
    verdicts = [(at, v) for at, e in calls if at["seat"] == "verifier" for v in arr(e.get("evidence_verdicts")) if isinstance(v, dict)]
    if not tests and not verdicts:
        lines.append("None.")
    for t in tests:
        lines.append("- %s %s on %s: %s" % (t["id"], t["result"], ", ".join(t["targets"]) or "—", full_text(ledger, t["id"], "hypothesis")))
    for at, v in verdicts:
        lines.append("- %s %s by %s%s" % (v.get("evidence"), "verified" if v.get("verified") is True else "rejected", at["prefix"],
                                           ": %s" % text(v.get("note")) if v.get("note") else ""))
    lines += ["", "## Revisions", ""]
    revs = []
    for at, e in calls:
        if at["seat"] != "architect":
            continue
        for c in arr(e.get("candidates")):
            if isinstance(c, dict):
                revs.append("- %s %s by %s%s" % (c.get("id"), "proposed" if ledger.full.get(c.get("id"), {}).get("at", {}).get("seq") == at["seq"] else "revised",
                                               at["prefix"], ": %s" % text(c.get("change_note")) if c.get("change_note") else ""))
        for r in arr(e.get("retired_candidates")):
            if isinstance(r, dict):
                revs.append("- %s retired by %s: %s" % (r.get("id"), at["prefix"], text(r.get("reason"))))
    if not revs:
        lines.append("None.")
    lines += revs
    lines += ["", "## Ruling", ""]
    rulings = [r for r in arr((result or {}).get("rulings")) if r.get("round") == rnd]
    if not rulings:
        chair = [e for at, e in calls if at["seat"] == "chair"]
        lines.append("Chair: %s. %s" % (text(chair[-1].get("decision")), text(chair[-1].get("rationale"))) if chair else "No ruling recorded.")
    for r in rulings:
        lines.append("- %s: ruled **%s**, effective **%s**.%s" % (r.get("id"), r.get("decision"), r.get("effective"),
                                                            " Override: %s." % r.get("overridden") if r.get("overridden") else ""))
        if r.get("rationale"):
            lines.append("  Rationale: %s" % r.get("rationale"))
    return "\n".join(lines) + "\n"


def cmd_render(run, ledger):
    result = read_json(run / "result.json")
    final = run / "final"
    final.mkdir(parents=True, exist_ok=True)
    (run / "minutes").mkdir(parents=True, exist_ok=True)
    written = []
    docs = {
        "02-argument-log.md": render_argument_log(ledger),
        "03-resource-register.md": render_resource_register(ledger),
        "04-experiment-log.md": render_experiment_log(ledger),
        "06-open-risks.md": render_open_risks(ledger, result, run),
    }
    for name, body in docs.items():
        (final / name).write_text(body, encoding="utf-8")
        written.append("final/" + name)
    rounds = sorted({e["round"] for e in ledger.S["entries"] if e["round"] >= 1})
    for r in rounds:
        (run / "minutes" / ("round-%d.md" % r)).write_text(render_minutes(ledger, result, r), encoding="utf-8")
        written.append("minutes/round-%d.md" % r)
    # the process record runs the trace check, so it is written last
    (final / "07-process-record.md").write_text(render_process_record(run, ledger, result), encoding="utf-8")
    written.append("final/07-process-record.md")
    return written


# ---------------------------------------------------------------------------
# status and new
# ---------------------------------------------------------------------------


def render_status(ledger):
    S = ledger.S
    g = ledger.gates()
    lines = ["Tier %s, round %d, %d entries, seq %d" % (ledger.tier, S["round"], len(S["entries"]), S["seq"]), "", "Candidates:"]
    for c in S["candidates"].values():
        lines.append("  %s v%d %s%s (%s)" % (c["id"], c["version"], "[retired] " if c["retired"] else "", c["title"], c["by"]))
    lines += ["", "Objections:"]
    for o in S["objections"].values():
        lines.append("  %s %-8s %-19s raised by %-15s on %s" % (o["id"], o["severity"], ledger.effective_status(o), o["raiser"], o["target"]))
    lines += ["", "Gates (hard: %s): %s" % (", ".join(g["hard"]), "all hard gates met" if g["hardMet"] else "hard gates failing")]
    for k, v in g["gates"].items():
        lines.append("  %s %s %s" % (k, "met   " if v["met"] else "FAILED", "; ".join(str(x) for x in v["detail"])))
    if S["violations"]:
        lines += ["", "Violations (%d):" % len(S["violations"])]
        for v in S["violations"][-15:]:
            lines.append("  #%s %s: %s" % (v["seq"], v["prefix"], v["message"]))
    return "\n".join(lines), g


def slugify(words):
    raw = re.sub(r"[^a-z0-9]+", " ", " ".join(words).lower()).split()
    stop = {"a", "an", "the", "of", "to", "and", "or", "for", "in", "on", "we", "should", "how", "what", "is", "do"}
    picked = [w for w in raw if w not in stop][:5] or raw[:5] or ["run"]
    return "-".join(picked)[:48].strip("-") or "run"


def cmd_new(words, root):
    base = Path(root)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M")
    name = "%s-%s" % (stamp, slugify(words))
    run = base / name
    n = 2
    while run.exists():
        run = base / ("%s-%d" % (name, n))
        n += 1
    for sub in ("entries", "notes", "candidates", "experiments", "minutes", "final"):
        (run / sub).mkdir(parents=True, exist_ok=True)
    return run


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def report(errors, warnings, as_json):
    if as_json:
        print(json.dumps({"ok": not errors, "errors": errors, "warnings": warnings}, ensure_ascii=False))
        return
    for e in errors:
        print("ERROR   %s" % e)
    for w in warnings:
        print("warning %s" % w)
    if not errors:
        print("OK" + (" (with %d warning(s))" % len(warnings) if warnings else ""))


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass
    ap = argparse.ArgumentParser(description="Replay, render, validate and trace a deliberation council ledger.")
    sub = ap.add_subparsers(dest="command", required=True)
    p_new = sub.add_parser("new", help="create a run directory and print its path")
    p_new.add_argument("title", nargs="+")
    p_new.add_argument("--root", default=".council")
    for name in ("validate", "state", "status", "render", "trace", "check"):
        p = sub.add_parser(name)
        p.add_argument("run_dir")
        p.add_argument("--json", action="store_true", help="machine-readable output")
    ns = ap.parse_args(argv)

    if ns.command == "new":
        print(cmd_new(ns.title, ns.root).as_posix())
        return 0

    run = Path(ns.run_dir)
    if not run.is_dir():
        print("error: %s is not a directory" % run, file=sys.stderr)
        return 2

    if ns.command == "validate":
        errors, warnings = cmd_validate(run)
        report(errors, warnings, ns.json)
        return 1 if errors else 0

    ledger, problems = replay(run)
    for p in problems:
        print("warning: %s" % p, file=sys.stderr)

    if ns.command == "state":
        if ns.json:
            print(json.dumps(ledger.S, ensure_ascii=False))
        else:
            print(render_status(ledger)[0])
        return 0

    if ns.command == "status":
        out, g = render_status(ledger)
        if ns.json:
            print(json.dumps({"tier": ledger.tier, "gates": g, "violations": ledger.S["violations"]}, ensure_ascii=False))
        else:
            print(out)
        return 0

    if ns.command == "render":
        written = cmd_render(run, ledger)
        if ns.json:
            print(json.dumps({"written": written}))
        else:
            for w in written:
                print("wrote %s" % w)
        return 0

    if ns.command == "trace":
        errors, warnings = cmd_trace(run, ledger)
        report(errors, warnings, ns.json)
        return 1 if errors else 0

    # check
    v_err, v_warn = cmd_validate(run)
    t_err, t_warn = cmd_trace(run, ledger)
    if not ns.json:
        print(render_status(ledger)[0])
        print("")
    report(v_err + t_err + problems, v_warn + t_warn, ns.json)
    return 1 if (v_err or t_err or problems) else 0


if __name__ == "__main__":
    sys.exit(main())
