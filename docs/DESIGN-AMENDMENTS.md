# Amendments to the design document

`MapleProcure Triage.pdf` is the design as written and is not edited. Each entry below names the
section it changes, what changed, and why. The reasoning in full is in `docs/DECISIONS.md`.

Where this file and the PDF disagree, this file is current.

---

### A1 — Workflow States: `PENDING` added

The PDF's state set has no state for a notice that has been claimed but not yet classified. Claim-
based dedup needs one, and so does recovery from an execution that died between claiming and
classifying. `PENDING` is the initial status of every row.

### A2 — §6 Deterministic Routing: contradiction rule, and `NEEDS_REVIEW_CONTRADICTION`

§6 routes every `relevance = not_relevant` to `NOT_RELEVANT`. Amended: when the same output also
says `software_related = true` and `target_market_match = true`, it routes to the new status
`NEEDS_REVIEW_CONTRADICTION`. The rule is evaluated first of all — necessarily before
`NOT_RELEVANT`, and also before the other review rules, so a contradiction is labelled as one
whatever else the output says. Otherwise a real opportunity can be dismissed with no human seeing
it. The separate status keeps
"the model was unsure" distinguishable from "the model contradicted itself", which is a prompt
defect, and the contradiction rate is reported with the false-auto-route number.

### A3 — §5 Validation and §6: where unusable output goes

§5 allows `NEEDS_REVIEW` or `CLASSIFICATION_FAILED` "depending on the failure"; §6 routes missing
required fields to `NEEDS_REVIEW`. Amended to one line: output that fails the contract (not JSON,
wrong types, value outside an enum, missing field) is `CLASSIFICATION_FAILED`; output that passes
is routed by the rules. `CLASSIFICATION_FAILED` rows appear in the review queue.

### A4 — Impact Metrics: what "manual review avoided" counts

The PDF's example computes 58% from `AUTO_MATCH` alone. Amended: avoided = (`AUTO_MATCH` +
`NOT_RELEVANT`) ÷ processed, and the split is always reported with the headline. The time-saved
estimate uses the same numerator.

### A6 — §6 and §7: `AUTO_MATCH` requires all four criteria

§6's rule names three conditions — target market, `relevance = match`, scope clear. §7 gives the
reasons a strong match is routed as four: software procurement, open, relevant market, scope
clearly identified. The stricter reading is taken: `AUTO_MATCH` requires `relevance = match` and
`software_related`, `currently_open`, `scope_clear` and `target_market_match` all true. Anything
less falls through to review. In addition, no rule may route to `AUTO_MATCH` or `NOT_RELEVANT`
unless the model's verdict agrees — rules can narrow a verdict, never override it. `route.js`
refuses a rules file that breaks this.

### A5 — Evaluation: eval harness is not yet part of the build

The PDF's repository structure lists `evaluation/results.json`. It is not produced until the eval
harness exists (component 9 in `PLAN.md`).
