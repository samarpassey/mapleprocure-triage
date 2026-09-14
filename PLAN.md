# mapleprocure-triage — build plan

An n8n workflow that turns MapleProcure from a research tool into a triage pipeline. Design:
`MapleProcure Triage.pdf`, as amended in `docs/DESIGN-AMENDMENTS.md`.

Verified 2026-09-13 against the deployed service and the local stack, not from memory.

## Verified facts

| Thing | Value |
|---|---|
| MapleProcure base | `https://maple-procure.onrender.com`, bearer token, `read` scope. First call after idle can take ~1 min |
| Search | `GET /v1/tenders/search` — `keywords`, `category`, `closing_before`, `limit`. Default limit 20, **max 100, no offset** |
| Detail | `GET /v1/tenders/{reference_number}` — adds `description`, `gsin`, `unspsc`, `notice_type`, dates |
| Unknown reference | **`200` with `rows: []`** and a note — not `404` |
| Unknown query parameter | **Silently ignored.** `?q=software` returns `200` and all 901 notices, unfiltered |
| No credential | `401`, `{"error": "invalid_request", …}` |
| Envelope | `rows`, `row_count`, `total_matches`, `withheld`, `truncated`, `as_of`, `source_file`, `source_last_modified` (HTTP date), `source_row_count`, `coverage`, `notes` |
| Search row | `reference_number`, `title`, `buyer_name`, `closing_date`, `category`, `regions_of_delivery`, `notice_url` |
| Data | Open tender file only: 901 notices as of `2026-09-14T00:19:57Z`. 5 have no closing date; 53 have a closing date already past |
| Search engine | SQLite FTS5, `porter unicode61`. All words ANDed, stemmed (`licensing` = `license`), no synonyms or spelling variants (`licence` ≠ `license`), case-folded (`IT` = `it`) |
| `closing_before` | `closing_date <= ?` in SQL — **drops every notice with no closing date** |
| `notice_url` | Null on 11 of the 172 notices the profile retrieves (6.4%) |
| Local stack | n8n 2.38.7, Postgres 18.6, `PGDATA=/var/lib/postgresql/18/docker`, host Node 20.19, Python 3.12. No `psql` on the host — use the container's |
| Eval draw | 20 strata (13 concepts + 7 near-misses) searched live; 27 notices frozen, every one with a description |
| Postgres behaviour | `jsonb_to_recordset` maps JSON arrays to `text[]`; a duplicate key inside one `INSERT … ON CONFLICT DO NOTHING` is skipped, not an error; `'Sun, 13 Sep 2026 10:20:16 GMT'::timestamptz` parses |

## Components, in build order

### 0 — Context files and skeleton
`CLAUDE.md`, `PLAN.md`, `PROGRESS.md`, `docs/DECISIONS.md`, `docs/DESIGN-AMENDMENTS.md`.
`Makefile`. File-size cap as a test.

### 1 — Triage schema and state-machine statements
`database/schema.sql`: `triage_results`, one row per reference, status constrained to the amended
state set, coherence between status and the columns each status requires enforced by `CHECK`.
Indexes for exactly three queries: pending recovery, review queue, metrics rollup.
`database/queries/`: claim, recover, record classification, review queue, record review,
metrics counts. `database/tests/`: assertions against a scratch database — idempotent claim,
recovery that cannot double-claim, a stale execution unable to overwrite a result, constraints
rejecting incoherent rows, each of the three queries able to use its index.

### 2 — Search profile
`config/search-profile.json`: one entry per concept, each its own search call. Every concept
measured live, each under the 100-row cap with room to grow. Reasoning, including what was
excluded and why, recorded in the file.

### 3 — Routing rules and the output contract
`config/routing-rules.json`: the classification contract (relevance values, criteria, categories)
and the ordered rules from the design doc §6, amended. First match wins; fallback `NEEDS_REVIEW`.

### 4 — Code modules
Pure CommonJS in `workflows/code/`, each tested in `workflows/code/test/`:

| Module | Does |
|---|---|
| `build-requests.js` | Profile → one search request per concept; refuses any parameter the API does not document |
| `merge-results.js` | Merge and dedupe across searches, union the matched concepts, drop already-closed notices visibly, report truncated searches |
| `validate-classification.js` | Model output → a valid classification or a list of errors. Shape only |
| `route.js` | Valid classification + rules → routed status and the rule that fired |
| `format-notification.js` | Triage row → notification text. Null `notice_url` prints the reference |
| `metrics-rollup.js` | Status counts → rollup with the split always reported |

### 5 — Labelling CLI
`evaluation/label.py` over `evaluation/sampling.py`. Samples real notices from the live REST
endpoint, stratified across profile concepts plus deliberate near-misses that the profile would
retrieve anyway; fetches detail; freezes the sample into `evaluation/labelled-notices.json`;
shows title and description one at a time; takes match / not relevant / uncertain; resumable.
The set itself is labelled by a person.

### 6 — Classifier
Prompt, Anthropic API call, schema-constrained output. Verified against the live API with the
current SDK documentation before any of it is described.

### 7 — Workflows
`workflows/procurement-triage.json` and `workflows/error-handler.json`, generated from
`node-shapes.json` with module source placed into Code nodes. Imported into the local n8n and
executed end to end against the deployed MapleProcure and the local Postgres.

### 8 — Human review path
Review queue → decision → `record-review.sql`. Form-based, on the `formTrigger` node in the export.

### 9 — Eval harness
Node, calling the same `validate-classification.js` and `route.js` the workflow uses, over the
labelled set. Reports total, correct, auto-routed, review rate, invalid-output rate, **false
auto-routes** and **contradiction rate** side by side. `make eval` lands with it, not before.

### 10 — README and known limitations
Architecture, a real run transcript, the eval numbers, and `KNOWN_LIMITATIONS.md`: retrieval is
keyword-only, confidence is uncalibrated, 20–30 labelled notices is not evidence of production
quality, the time-saved figure is an estimate.

## If scope has to shrink, drop in this order
1. Form-based review (review by running `record-review.sql` directly)
2. The error workflow's alert channel (keep the Error Trigger capture)
3. Notification formatting beyond plain text

**Never cut:** claim-based dedup, provenance on every classified row, deterministic routing with a
review fallback, a person-labelled eval set, the false-auto-route number.

## Open decisions

Add a question here only while it is genuinely open; delete it when the answer lands in
`docs/DECISIONS.md`.

- **How module source reaches a Code node** — inlined into the JSON at generation time, or read
  from the `/workflows` mount. Decided in component 7, after checking what the task runner allows.
- **`currently_open` as a model criterion.** The model cannot know today's date unless the prompt
  supplies it, and `merge-results.js` already drops closed notices deterministically. Component 6.
- **`relevance: match` with `target_market_match: false`** is two incompatible statements, but
  routes to plain `NEEDS_REVIEW` through the fallback rather than `NEEDS_REVIEW_CONTRADICTION`.
  The routing outcome is the same; the contradiction rate would undercount it.
- **A claimed reference whose detail fetch returns `rows: []`** (closed and dropped from the open
  file between search and fetch). Component 7.
- **Notification channel.** `NOTIFY_WEBHOOK_URL` is generic; the payload shape depends on it.

## Standing rules
- Never publish a capability that has not run against a live system.
- A clean clone reproduces: `docker compose up -d && make db-apply && make test`.
- Gaps are disclosed, not hidden — in `PROGRESS.md` open threads until `KNOWN_LIMITATIONS.md` exists.
