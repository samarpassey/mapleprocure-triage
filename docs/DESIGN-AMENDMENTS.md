# Amendments to the original design

The original design document is not part of this repository. This file restates what it said
wherever the build departs from it, then says what changed and why. It reads on its own. The
reasoning in full is in `docs/DECISIONS.md`.

Where this file and the original design disagree, this file is current.

## The original design, as cited

`config/routing-rules.json` and the tests cite the original by section. These are its sections.

| Section | What it covered |
|---|---|
| High-Level Behaviour | An hourly run in 16 steps: query MapleProcure, skip notices already processed, have an LLM extract structured data, validate it, route with deterministic rules, auto-route strong matches, queue ambiguous notices for a human, record irrelevant ones, persist every decision, notify on relevant opportunities, retry failures and send final failures to an error workflow |
| §4 AI-Assisted Tender Analysis | The shape of the model's output |
| §5 Validation | What is checked before any decision, and where invalid output goes |
| §6 Deterministic Routing | The rules that turn the model's output into a status |
| §7 Strong Match Path | What happens to a clear opportunity |
| §8 Human Review Path | What a person sees and decides |
| Workflow States | The status set |
| Error Handling, Dedicated Error Workflow | Retries, backoff and a separate workflow for final failures |
| Evaluation | A labelled set to measure the classifier |
| Impact Metrics | How manual work avoided is counted |

---

### A1. Workflow States: `PENDING` added

**Original.** Seven statuses: `AUTO_MATCH`, `NOT_RELEVANT`, `NEEDS_REVIEW`, `HUMAN_APPROVED`,
`HUMAN_REJECTED`, `CLASSIFICATION_FAILED` and `PROCESSING_FAILED`. It distinguished review, which is
expected behaviour, from errors.

**Changed.** `PENDING` is added as the initial status of every row. The original had no state for a
notice that has been claimed but not yet classified. Claim-based dedup needs one, and so does
recovery from an execution that died between claiming and classifying.

### A2. §6 Deterministic Routing: contradiction rule, and `NEEDS_REVIEW_CONTRADICTION`

**Original.** §6 gave five rules. Missing required fields, unclear scope and `relevance = uncertain`
each go to `NEEDS_REVIEW`. Target-market criteria satisfied with `relevance = match` and clear scope
goes to `AUTO_MATCH`. `relevance = not_relevant` goes to `NOT_RELEVANT`, whatever the criteria say.

**Changed.** When an output says `relevance = not_relevant` and also `software_related = true` and
`target_market_match = true`, it routes to a new status, `NEEDS_REVIEW_CONTRADICTION`. Under the
original rules a real opportunity could be dismissed with no human seeing it. The rule is evaluated
first of all, before `NOT_RELEVANT` and before the other review rules, so a contradiction is labelled
as one whatever else the output says. The separate status keeps "the model was unsure"
distinguishable from "the model contradicted itself", which is a prompt defect.

### A3. §5 Validation and §6: where unusable output goes

**Original.** §5 checked that the output is valid JSON, that required fields and criteria are
present, that `relevance` is a permitted value and that the fields are internally consistent. An
invalid response was not to crash the workflow. It would become `NEEDS_REVIEW` or
`CLASSIFICATION_FAILED` "depending on the failure". §6 separately routed missing required fields to
`NEEDS_REVIEW`.

**Changed.** One rule. Output that fails the contract (not JSON, wrong types, a value outside an
enum, a missing field) is `CLASSIFICATION_FAILED`. Output that passes is routed by the rules. A model
refusal is recorded the same way, with the stop reason as its error. `CLASSIFICATION_FAILED` rows
appear in the review queue.

### A4. Impact Metrics: what "manual review avoided" counts

**Original.** The example run processed 100 notices: 58 auto-routed, 17 to human review, 25 not
relevant. It reported "manual review avoided" as 58%, counting only the auto-routed matches, and
estimated time saved as 58 notices at three minutes each, about 2.9 hours, labelled an estimate.

**Changed.** Avoided = (`AUTO_MATCH` + `NOT_RELEVANT`) ÷ processed, and the split is always reported
with the headline. A notice dismissed without a human is also review avoided. The time-saved
estimate uses the same numerator.

### A5. Evaluation: not yet part of the build

**Original.** A small labelled dataset of 20 to 30 real notices, each labelled by hand as `MATCH`,
`NOT_RELEVANT` or `NEEDS_REVIEW`. The pipeline was to be measured on correct classifications,
auto-routed notices, human-review rate, invalid-output rate and false auto-routes, with false
auto-routes the most important. The repository layout listed `evaluation/labelled-notices.json` and
`evaluation/results.json`.

**Changed.** `evaluation/results.json` is not produced until an eval harness exists. Superseded by
A12.

### A6. §6 and §7: `AUTO_MATCH` requires every criterion

**Original.** §4's example output carried four boolean criteria: `software_related`,
`currently_open`, `scope_clear` and `target_market_match`, alongside `category`, `relevance`,
`rationale` and `confidence`. §6's `AUTO_MATCH` rule named three conditions: target market,
`relevance = match` and clear scope. §7 listed four reasons a strong match is routed: software
procurement, open opportunity, relevant market, scope clearly identified.

**Changed.** The stricter reading is taken. `AUTO_MATCH` requires `relevance = match` and every
criterion true. Anything less falls through to review. In addition, no rule may route to
`AUTO_MATCH` or `NOT_RELEVANT` unless the model's verdict agrees. Rules can narrow a verdict, never
override it. `route.js` refuses a rules file that breaks this. A7 later removes `currently_open`.

### A7. §4 AI-Assisted Tender Analysis and §7 Strong Match Path: `currently_open` removed

**Original.** As in A6: the output carried `currently_open`, and "open opportunity" was one of §7's
reasons for a strong match.

**Changed.** The criteria are `software_related`, `scope_clear` and `target_market_match`. Closed
notices are removed before classification, so openness is enforced in n8n, not asserted by the
model. `AUTO_MATCH` requires `relevance = match` and all three. This supersedes A6's four criteria.
The rest of A6 stands.

### A8. §6 Deterministic Routing: a match outside the target market is a contradiction

**Original.** §6's `AUTO_MATCH` rule required the target-market criteria to be satisfied. No rule
covered a `match` verdict whose criteria said the notice is outside the target market.

**Changed.** `relevance = match` with `target_market_match = false` routes to
`NEEDS_REVIEW_CONTRADICTION`, like the `not_relevant` contradiction in A2, and is evaluated with it
ahead of every other rule.

### A9. §4 and §6: confidence as a floor on automatic routes

**Original.** §4 said the confidence score can be stored for analysis but should not be trusted as
the sole routing mechanism. §6's rules did not use it.

**Changed.** A precise rule. Confidence below `confidence_floor.min` in `config/routing-rules.json`
(0.8) turns `AUTO_MATCH` or `NOT_RELEVANT` into `NEEDS_REVIEW`. Confidence never moves a notice
toward an automatic route.

### A10. §8 Human Review Path: the review queue is the triage table

**Original.** An ambiguous notice goes to `NEEDS_REVIEW` instead of being guessed. The review record
holds the tender reference, title, relevant notice text, model classification, rationale, extracted
criteria and source information. A person then decides `HUMAN_APPROVED` or `HUMAN_REJECTED`. Review
is a normal state of the workflow, not a failure.

**Changed.** That review record is the `triage_results` row itself, notice text included. There is
no separate review form. The queue is the rows in `NEEDS_REVIEW`, `NEEDS_REVIEW_CONTRADICTION` and
`CLASSIFICATION_FAILED`.

### A11. High-Level Behaviour steps 15 and 16, §7, Error Handling: no notification, no error workflow

**Original.** Relevant opportunities trigger a notification to Slack, Discord, email or a webhook,
showing the title, category, closing date, why it matched, the reference and the source. HTTP
failures are retried with backoff, and an execution that ultimately fails starts a dedicated error
workflow through n8n's Error Trigger. That workflow captures the workflow name, execution ID, failed
node, timestamp, error message and affected tender reference, and sends an alert.

**Changed.** No notification is sent for relevant opportunities, and there is no dedicated error
workflow. There is no notification channel. Failures are retried at node level, and a notice that
still fails is reclaimed by recovery until its attempts run out.

### A12. Evaluation: removed

**Original.** As in A5.

**Changed.** Supersedes A5. The evaluation set, the eval harness and `evaluation/results.json` are
not part of this build (`docs/DECISIONS.md`, 2026-09-14).
