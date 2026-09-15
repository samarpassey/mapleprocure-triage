# Decisions

Newest last. One entry per decision that would otherwise look arbitrary later.

---

### 2026-09-13 — Call MapleProcure over REST, not MCP

n8n decides whether to retry from the HTTP status. MCP is JSON-RPC: a tool-level error arrives
inside an HTTP `200`, so to n8n a refused or failed call is a success, and its retry setting can
neither fire on a transient failure nor hold back on a permanent one. MapleProcure now exposes
`GET /v1/tenders/search` and `GET /v1/tenders/{reference_number}` beside `/mcp`, through the same
query layer and with the same provenance envelope, failing as `401` / `403` / `422` / `503`. Only
`503` is worth retrying — it means the deploy is still rebuilding its database.

Two behaviours of those routes shape this repo, both verified live:

- An unknown reference is `200` with `rows: []`, not `404`. A lookup that finds nothing is not
  an error, so the workflow branches on the empty list rather than on the status.
- Unknown query parameters are ignored, not refused. A misspelt parameter is an unfiltered search.
  `build-requests.js` allows only the documented parameters.

### 2026-09-13 — Stack pinned at n8n 2.38.7 and Postgres 18

Both images are pinned to exact versions, because both floating choices already failed once. n8n
2.38.7 declined Postgres 16. Moving to Postgres 18 broke the volume: the official `postgres:18`
image keeps its data under a version-specific directory (`PGDATA=/var/lib/postgresql/18/docker`,
confirmed in the running container). So the volume mounts at `/var/lib/postgresql` rather than
the long-standing `/var/lib/postgresql/data`. A version bump is a deliberate change to
`docker-compose.yml` with a new entry here, never a pull of `latest`.

### 2026-09-13 — Workflow JSON is generated against an exported schema, not built in the editor

`workflows/reference/node-shapes.json` is exported from this n8n instance and holds every node
type the project needs, with the `typeVersion` this instance actually runs. Node parameter shapes
change between `typeVersion`s, and a structure written from memory can import without an error
while behaving differently. Generated JSON is also diffable and reviewable, which a workflow edited
in the canvas and exported afterwards is not. The export is ground truth; a node type missing from
it is exported from the instance before it is used.

### 2026-09-13 — One search per concept, because FTS5 ANDs every word

MapleProcure's search is SQLite FTS5 with the `porter unicode61` tokenizer. Every keyword must
appear, and there are no synonyms. The design doc's keyword list sent as one query — software,
SaaS, cloud, digital platform, … — asks for a notice containing all of them, and matches nothing.
So `config/search-profile.json` holds one entry per concept, each becoming its own search call,
merged and deduplicated before Postgres sees anything.

Measuring each candidate against the live data changed the list more than theory did:

- **Stemming merges some variants and not others.** `license` and `licensing` both return 24;
  `licence`, the Canadian spelling, returns 5 different ones. Both spellings are separate concepts.
- **Case-folding makes `IT` the pronoun.** `IT services` returns 239 of 901 notices. No acronym
  that collides with an English word is usable.
- **Several design-doc areas are procurement boilerplate.** `payments`, `grants` and `budgeting`
  match payment terms and funding clauses in construction notices — the top hit for `payments` is a
  solar microgrid. `procurement` appears in nearly every notice. These areas are reached through the
  software, platform and financial-system concepts they intersect with, not searched alone.
- **The cap is 100 rows with no offset.** A concept over 100 matches silently loses rows, so
  every concept is kept well under it, and a truncated search is reported at run time, not ignored.

### 2026-09-13 — Dedup is a claim: `INSERT … ON CONFLICT DO NOTHING RETURNING`

Select-then-insert races. Two overlapping executions both see a reference as new and both
classify it: double the model spend, and two notifications for one tender. Inserting the batch
with `ON CONFLICT (tender_reference) DO NOTHING RETURNING` makes the insert itself the check. The
rows returned are exactly the ones this execution claimed, whatever else is running, and
re-running the same batch claims nothing. The statement lives in `database/queries/`, where it can
be read, tested against the live Postgres, and cited, rather than inside a node's parameters.

A claim without recovery would strand work: an execution that dies after claiming leaves rows in
`PENDING` forever. So recovery exists — and it must not reintroduce the race it recovers from.

### 2026-09-13 — Routing rules live in one config file, read by the workflow and the eval

`config/routing-rules.json` holds the ordered rules and the output contract they refer to. The
workflow and the eval harness read the same file, so the eval measures the routing that actually
runs. One file is necessary but not sufficient: two interpreters of the same file can still drift.
So the rules are interpreted once, in `workflows/code/route.js`, and both callers use that module.

### 2026-09-13 — The evaluation set is labelled by a person, never by a model

A model-labelled set would score the classifier against a classifier, so its agreement numbers
would measure nothing. Every label in `evaluation/labelled-notices.json` comes from a keypress in
`evaluation/label.py`, and nothing in `evaluation/` calls a model.

The sample is built to make the review path demonstrable. A set with no genuine ambiguity routes
nothing to a human, and so proves nothing about the path the design most depends on. It is
stratified across profile concepts and includes deliberate near-misses: consulting engagements that
mention software, hardware maintenance contracts. The labels are the design doc's `MATCH`,
`NOT_RELEVANT` and `NEEDS_REVIEW` — "uncertain" at the prompt records `NEEDS_REVIEW`, which is the
correct routing for a notice its own labeller could not call.

### 2026-09-13 — A contradiction between verdict and criteria gets its own status

The design doc's §6 rules auto-dismiss any `relevance: not_relevant` notice, including one whose
own criteria say `software_related: true` and `target_market_match: true`. That is a dismissal with
no human in it that no one ever sees, and it is how a real opportunity is lost silently. A rule
ahead of `NOT_RELEVANT` routes that output to review.

It routes to `NEEDS_REVIEW_CONTRADICTION`, not plain `NEEDS_REVIEW`, because the two need different
fixes. "I am not sure" is a hard tender. Two incompatible statements is a prompt problem. So the
contradiction rate is reported beside the false-auto-route number, as a direct signal that the
criteria and the verdict are pulling apart. Rule order is load-bearing, so a test pins it. This
departs from §6 and is recorded as an amendment in `docs/DESIGN-AMENDMENTS.md`.

### 2026-09-13 — Output that fails validation is `CLASSIFICATION_FAILED`, shown in the review queue

The doc gives two answers for unusable model output — §5 allows `NEEDS_REVIEW` or
`CLASSIFICATION_FAILED`, §6 routes missing fields to `NEEDS_REVIEW`. The line is drawn at
validation. Output that parses and satisfies the contract is routed by the rules, and anything
inconclusive lands in `NEEDS_REVIEW`. Output that does not satisfy the contract — not JSON, wrong
types, a value outside an enum, a missing field — is `CLASSIFICATION_FAILED`, with the validation
errors stored. It still appears in the review queue: a failure should not be able to sit unseen,
and its status still says it was a failure rather than ambiguity.

### 2026-09-13 — "Manual review avoided" counts every notice decided without a human

The doc's example reports 58% avoided from 58 auto-matched, 17 reviewed and 25 not relevant — a
figure that counts `AUTO_MATCH` alone. A dismissed notice also needed no person to read it, so the
honest figure is 83%. The rollup always reports the split with the headline, never the headline
alone: "83% decided without a human — 58 auto-matched, 25 dismissed; 17 sent to review". A
headline that folds the dismissals in would otherwise hide where missed opportunities live.

### 2026-09-13 — No `make eval` until the eval harness exists

The harness needs the classifier prompt and the Anthropic call, and neither exists yet. A
Makefile target pointing at nothing would describe a capability that is not there. The target
lands with component 9, in the same change as the harness it runs.

### 2026-09-13 — `PENDING`, `routed_status`, and a human decision that is a status

The doc's state set has no state for a notice that is claimed but not yet classified, and a claim
needs one (amendment A1). The doc lists `human_decision` as a column beside the workflow status.
Here the decision *is* the status — `HUMAN_APPROVED` or `HUMAN_REJECTED` — because two columns
that must agree eventually disagree. Overwriting the status would lose one thing: whether the row
reached review as uncertain, contradictory or failed. That is kept in `routed_status`, which
classification writes once and review never touches. The metrics rollup reads it, so a
contradiction a person later approved still counts as a contradiction.

What each status requires of the row is enforced by named `CHECK` constraints, not by the
statements that write it. Examples: provenance on anything routed; review fields exactly when a
person decided; validation errors exactly when classification failed; a notification only for a
relevant opportunity. A future statement that forgets a column fails loudly instead of writing an
unauditable row.

### 2026-09-13 — Recovery reclaims with a conditional `UPDATE`, fences the old execution, and gives up

A recovery `SELECT` followed by classification would bring back the race the claim removed: two
executions find the same stale row and both classify it. `recover.sql` is one `UPDATE … WHERE
status = 'PENDING' AND claimed_at < now() - interval '1 hour' RETURNING`. Under READ COMMITTED,
a concurrent run blocks on the row lock. It then re-checks the `WHERE` against the updated row and
skips it. `make db-test` proves this, and the same for the claim, with two real connections: the
second is seen waiting on the lock before the first commits, not merely running after it.

Reclaiming moves `execution_id`, and `record-classification.sql` writes only where the id still
matches. An execution that was slow rather than dead cannot overwrite the result of the one that
took over. A row stale on its third attempt becomes `PROCESSING_FAILED` instead of being reclaimed.
Otherwise a notice that crashes the run every time would crash every run. The one-hour threshold
assumes a batch classifies within an hour. That is unmeasured until the workflow runs.

### 2026-09-13 — The triage row stores a hash of the model's input, not the notice text

MapleProcure owns the notice text. Copying descriptions here would make this the second copy of
CanadaBuys the design rules out. `input_sha256` identifies exactly what the model was sent, and
`source_last_modified` identifies the source file it came from. The cost is real: once a notice
closes and leaves the open-tender file, its text cannot be fetched from MapleProcure again. The eval
set is the one exception, because a label is meaningless without the text it was given against, so
`labelled-notices.json` keeps the text.

### 2026-09-13 — Closed notices are filtered in n8n, not with `closing_before`

MapleProcure offers `closing_before` but not `closing_after`. On 2026-09-13, 53 of the 901 notices
in the open-tender file had closing dates already past. `closing_before` is `closing_date <= ?`,
which also excludes the 5 notices with no closing date, with nothing to show they existed — the
same retrieval hole MapleProcure's REST routes refuse `region` over. So no date filter is sent.
`merge-results.js` leaves past-closing notices out of the claim batch and lists them. It keeps
undated notices, and compares as local wall-clock text because the source states no time zone.

### 2026-09-13 — Code node logic is pure CommonJS, one module per node, under a 250-line cap

Code node logic lives in `workflows/code/` as plain modules with no `require` and no n8n globals.
Each file stands alone inside one Code node, and `node --test` can run each one against the real
config files, with no n8n running. How the source gets into the node is not decided yet (see
`PLAN.md`), and nothing here depends on the answer. The line cap is MapleProcure's — 250 — applied
by one test to `.js`, `.py` and `.sql` alike.

### 2026-09-13 — The eval sample: near-misses inside retrieval, text frozen, stratum hidden

Each near-miss stratum ANDs a term onto one profile concept's keywords — `consulting software`,
`hardware software`. Every near-miss is therefore a notice the workflow retrieves anyway, and the
classifier is never scored on input production never gives it. Near-miss strata choose first, so
a notice shared with a broad concept counts toward the ambiguity quota. The draw is deterministic
for a seed.

The full text and envelope provenance are frozen into the file at draw time, because the open-tender
file drops closed notices within weeks. The labelling prompt does not show which stratum a notice
came from: knowing it was drawn as a near-miss is a hint toward "uncertain". Defaults — one notice
per concept and two per near-miss, at most 27 — sit inside the doc's 20–30.

### 2026-09-14 — Scope cut: a working pipeline tonight over a measured one

The plan had an evaluation track: a person-labelled set of notices, a harness scoring the classifier
against it, `make eval`, prompt tuning against the scores, and a form for deciding review-queue
rows. None of it sits on the path from a schedule to a routed row in Postgres, and all of it was
still ahead. It is cut, not deferred. What ships tonight is the pipeline: search, merge, claim,
classify, route, record.

Entries above about the evaluation set and the harness record what was decided at the time. They
no longer describe planned work. `evaluation/label.py` stays in the repository, unused by the
pipeline. Tests cover what the workflow executes at run time and nothing else new. The classifier
prompt is written once and not tuned. Review happens in the `triage_results` table.

The cut does not touch claim-based dedup, recovery with fencing and the attempt cap, `PENDING` as a
state, provenance on every classified row, deterministic routing with a review fallback, the
contradiction rule ahead of every other rule, no rule auto-routing against the model's own verdict,
closed notices filtered and listed, no date filter sent, or unknown search parameters blocked
client-side.

### 2026-09-14 — Overruled: the triage row stores the notice text

This supersedes "The triage row stores a hash of the model's input, not the notice text". With the
review form cut, the review queue is the `triage_results` table itself. A `NEEDS_REVIEW` row a person
cannot read is not a review queue, and once a notice closes and leaves the open-tender file,
MapleProcure cannot return its text. `notice_text` holds exactly what the model was sent, and the
provenance constraint requires it on every classified row. `input_sha256` stays, for change
detection. `record-classification.sql` computes it from the text it stores, so the two cannot
disagree.

### 2026-09-14 — Overruled: `currently_open` is not a criterion

`merge-results.js` removes every notice whose closing date has passed before anything is claimed,
so every notice the model reads is open by construction. Asking the model to assert it adds a
field the model can only guess at, and that field sat inside the `AUTO_MATCH` rule. It is gone from
the contract, the prompt and the response schema. `AUTO_MATCH` requires `relevance: match` with
`software_related`, `scope_clear` and `target_market_match` all true. `route.js` refuses a rule that
names `currently_open`, because the contract no longer has it.

### 2026-09-14 — Confidence is a floor on automatic routes

The earlier rule was that confidence routes nothing. It now holds notices back, and does nothing
else. When the rule that fired would decide a notice without a human and the model's confidence is
below `confidence_floor.min` in `config/routing-rules.json`, the notice goes to `NEEDS_REVIEW` with
`routing_rule` set to `below-confidence-floor`. Confidence never authorizes a route: a notice headed
for review goes to review at any confidence, and a test pins that.

The floor applies to `NOT_RELEVANT` as well as `AUTO_MATCH`. A dismissal the model was unsure of is
the silent loss the contradiction rule exists to prevent. Nothing terminal happens without a clear
verdict and high confidence, or a person. The threshold is 0.8, a config value. `route.js` refuses a
floor of 0, so the floor cannot be switched off without anyone noticing. The response schema cannot
express a numeric range, so `validate-classification.js` still checks that confidence lies from 0
to 1.

### 2026-09-14 — A match outside the target market is a contradiction

`relevance: match` with `target_market_match: false` is two incompatible statements, like the
`not_relevant` case. It used to reach plain `NEEDS_REVIEW` through the fallback. It now has its own
rule, `contradiction-match-off-market`, routing to `NEEDS_REVIEW_CONTRADICTION`. Both contradiction
rules come before every other rule, so a contradiction is always labelled as one.

### 2026-09-14 — Structured outputs shape the classifier's reply; validation still runs

`prepare-classification.js` sets `output_config.format` to a JSON schema generated at run time from
the contract in `config/routing-rules.json`. The schema, the validator and the rules therefore share
one vocabulary. Every object sets `additionalProperties: false` and lists every property in
`required`. Every response still goes through `validate-classification.js`. A refusal or a
`max_tokens` stop can return text that does not match the schema, and the schema cannot bound
confidence. The request opts into the API's server-side refusal fallback, which can answer with
another model, so `model_name` is read from the response.

### 2026-09-14 — Module source, config and SQL are inlined into the workflow at generation

`workflows/build.js` writes `workflows/procurement-triage.json`. Each node starts as a copy of its
type in the reference export. Code nodes get the modules and config files inlined, and Postgres
nodes get the statements from `database/queries/` verbatim. Reading files at run time would mean
enabling filesystem access for Code nodes, or adding file nodes that are not in the reference export
plus a mount for `config/`. Generation keeps the imported workflow self-contained. It also puts
every behaviour change in a reviewable diff of one file. The workflow version written onto claimed
rows is a hash of everything the generator reads. `prompt_version` and `rules_version` are written
onto every classified row.

### 2026-09-14 — A lookup with no rows, or a call that keeps failing, leaves the claim to recovery

For a reference that has left the open-tender file, `GET /v1/tenders/{reference}` returns `200` with
`rows: []`. `prepare-classification.js` reads "not found" from the body, never from the status. On
the false branch of `Notice found?` nothing is written and the row stays `PENDING`. `recover.sql`
reclaims it after an hour, and after the third attempt it becomes `PROCESSING_FAILED`. A notice that
closed between search and lookup ends there, with no classification invented for it. A transient
empty response, such as MapleProcure rebuilding its database, gets retried. The detail fetch and the
Anthropic call take the same path after their node-level retries (`onError: continueRegularOutput`),
so one failing notice cannot stop the rest of its batch.

### 2026-09-14 — No error workflow, and no notifications

The error handler was to be Error Trigger, format, notify. The notify step has nowhere to send: no
notification channel is configured and n8n holds no notification credential. Failures are handled
at node level instead. Every call out of n8n has `retryOnFail`, and a notice that still fails is
left to recovery. A failed execution shows in n8n's execution list. For the same reason no
notification is sent for `AUTO_MATCH`. The routed row in `triage_results` is the output.

### 2026-09-14 — A Manual Trigger beside the schedule

The design allows manual runs. `n8n execute --id` refuses a workflow whose only trigger is a Schedule
Trigger: it starts only from a Manual Trigger or an Execute Workflow Trigger, verified against the
instance. So the workflow has both a schedule and a Manual Trigger, feeding the same first node. The
Manual Trigger shape was exported from the instance into `workflows/reference/node-shapes.json`
before use.

### 2026-09-14 — Secrets live in `.env` or n8n's encrypted credential store

Invariant 11 said secrets live only in `.env`. The system never worked that way, and should not.
The Anthropic API key is an n8n credential, encrypted at rest with `N8N_ENCRYPTION_KEY`, and no node
reads it from the environment. Copying it into `.env` would add a plaintext copy that nothing reads.
`.env` holds what the containers and the local tools read at start: the Postgres password, the
encryption key, and the MapleProcure URL and token for `evaluation/label.py`. The invariant now
reads: secrets live in `.env` or n8n's encrypted credential store, never in workflow JSON or
committed files. Workflow JSON names credentials and never contains them.

### 2026-09-14 — The design document is not kept in the repository

The original design was a PDF at the repo root, cited by section. It is removed from the tree and
from history, and ignored. `docs/DESIGN-AMENDMENTS.md` now restates what the original said wherever
the build departs from it, and lists the sections that `config/` and the tests cite, so every
reference resolves without the PDF.
