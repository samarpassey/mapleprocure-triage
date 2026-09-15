# mapleprocure-triage — build plan

An n8n workflow that watches MapleProcure's open federal tenders, classifies each new notice with
Claude, routes the classification with deterministic rules, and leaves what it cannot decide in a
review queue in Postgres. Design: the original design, restated and amended in
`docs/DESIGN-AMENDMENTS.md`. This build order replaced the earlier plan on 2026-09-14
(`docs/DECISIONS.md`, "Scope cut").

## Verified facts

Verified against the deployed service and the local stack, not from memory.

| Thing | Value |
|---|---|
| MapleProcure base | `https://maple-procure.onrender.com`, bearer token, `read` scope. First call after idle can take ~1 min |
| Search | `GET /v1/tenders/search` — `keywords`, `category`, `closing_before`, `limit`. Default limit 20, **max 100, no offset** |
| Detail | `GET /v1/tenders/{reference_number}` — adds `description`, `gsin`, `unspsc`, `notice_type`, `procurement_method`, dates |
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
| Postgres behaviour | `jsonb_to_recordset` maps JSON arrays to `text[]`; a duplicate key inside one `INSERT … ON CONFLICT DO NOTHING` is skipped, not an error; `'Sun, 13 Sep 2026 10:20:16 GMT'::timestamptz` parses |
| n8n credentials | `Postgres triage` (postgres), `MapleProcure API` and `Anthropic API` (HTTP header auth), created in the instance by hand |
| n8n Postgres parameters | `options.queryReplacement` as one expression returning an array: each object element is sent as JSON text and binds to `$n::jsonb`; commas and quotes inside values survive. Probed with a throwaway workflow |
| n8n Postgres results | `timestamp` and `timestamptz` arrive as ISO strings in UTC. A `timestamp` is read in the container's zone first, so `2026-10-02T13:00:00` arrives as `2026-10-02T17:00:00.000Z`. `numeric` arrives as a string, `text[]` as an array |
| n8n Code node | JavaScript task runner; `$execution.id` is the stored execution id. `n8n execute --id` starts only from a Manual Trigger, and needs its own `N8N_RUNNERS_BROKER_PORT` while the server runs |
| n8n validator | `validateWorkflow` in `@n8n/workflow-sdk`, with the node definitions shipped in the image, checks parameters against each node's schema |

## Measured search profile

Measured 2026-09-13 against the live service. The reasoning is in `config/search-profile.json` and
`docs/DECISIONS.md`.

- 13 concepts, one search each, retrieve 172 distinct notices of 901. None was truncated; the
  largest concept, `application development`, matched 53.
- 53 notices in the open-tender file were already past their closing date and 5 had none.
  `closing_before` would silently drop the 5, so no date filter is sent; `merge-results.js` filters
  closed notices and lists them.
- `payments`, `grants` and `budgeting` are not searched alone. They match payment terms and funding
  clauses in construction notices; the top hit for `payments` is a solar microgrid.
- `IT services` is not searchable. Case-folding makes `IT` the pronoun: 239 matches, over the cap.
- `license` and `licence` return different notices, 24 and 5. Both are concepts.
- `procurement system` matches 135, because `procurement` appears in nearly every notice.

## Build order

### 1 — Overrules and new rules
- The notice text is stored on the triage row. `input_sha256` stays, computed from the stored text.
- `currently_open` leaves the contract. `strong-match` needs a match verdict and the other three
  criteria.
- `confidence_floor` in `config/routing-rules.json`: below it, AUTO_MATCH and NOT_RELEVANT become
  NEEDS_REVIEW.
- `relevance: match` with `target_market_match: false` routes to `NEEDS_REVIEW_CONTRADICTION`.

Touches `routing-rules.json`, `route.js`, `schema.sql`, `record-classification.sql` and their tests.

### 2 — Classifier prompt
`config/classifier-prompt.md`, written once against `config/search-profile.json`. Model, effort,
token limit and prompt version in `config/classifier.json`. `prepare-classification.js` builds the
request with `output_config.format`: a JSON schema generated from the contract, with
`additionalProperties: false` on every object and every field in `required`.
`classification-record.js` puts the response through `validate-classification.js` and `route.js`.

### 3 — Main triage workflow
`workflows/procurement-triage.json`, generated by `workflows/build.js` (`make workflow`). Every node
starts as a copy of its type in `workflows/reference/node-shapes.json`; module source, config and SQL
are inlined. Credentials by name: `Postgres triage`, `MapleProcure API`, `Anthropic API`.

```
Every hour | Run now → Recover stale claims → Build search requests → Search MapleProcure
  → Merge search results → Claim notices → Collect work → Fetch notice → Prepare classification
  → Notice found? → Classify → Validate and route → Record classification
```

From the export: `__rl` resource locators on Postgres schema and table (table operations only;
`executeQuery` has neither), `version: 3` inside filter options, `retryOnFail` at node level,
`executionOrder: "v1"` in settings. A lookup that returns `200` with `rows: []` takes the false
branch of `Notice found?` and leaves the claim to recovery. Imported into the instance and checked
with n8n's own validator until clean.

### 4 — Error handler workflow
Only if it is four nodes or fewer, set as the main workflow's Error Workflow. Not built: there is no
notification channel to send to (`docs/DECISIONS.md`). Node-level `retryOnFail` covers transient
failures.

### 5 — First live run
`n8n execute` against the deployed MapleProcure and the local Postgres. The first execution
backfills every open notice the profile retrieves.

### 6 — README
Four sections: what it does, pipeline, design decisions, running it. Verified behaviour only.

## Standing rules
- Never describe a capability that has not run against a live system.
- A clean clone reproduces: `docker compose up -d && make db-apply && make test`.
- `workflows/procurement-triage.json` is regenerated with `make workflow`, never edited by hand.
