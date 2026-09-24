# MapleProcure Triage

Every hour this reads the new government contracts Canada has put out for bid, has an AI model
decide which ones are worth a look, and puts only the unclear ones in front of a person.

It is a working pipeline, not a demo. On its first live run, 2026-09-14, it processed 150 open
notices in 30 seconds and decided 130 of them without a human: 42 worth bidding on, 88 dismissed.
The remaining 20 went to the review queue. The next run claimed nothing, because every notice it
found had already been handled.

## How it works

- **One n8n workflow, self-hosted.** Docker Compose runs n8n 2.38.7 and Postgres 18.6 on
  localhost. A schedule trigger fires hourly, 13 keyword searches go out to the MapleProcure REST
  API, and every new notice is claimed in Postgres so no notice is ever processed twice.
- **Claude does the judging, fixed rules do the routing.** `claude-opus-5` returns a verdict,
  three criteria and a confidence score against a JSON schema. Rules in `config/routing-rules.json`
  turn that reply into one of seven statuses. The model never decides its own routing.
- **Anything unclear goes to a person, with its evidence.** Uncertain, contradictory, or below a
  0.8 confidence floor means the notice lands in a Postgres review queue carrying the notice text
  the model read, its rationale, the rule that sent it there, and the provenance of the source
  data. Twelve `CHECK` constraints stop a routed row from existing without that provenance.

Related: the API this runs against is
[samarpassey/maple-procure](https://github.com/samarpassey/maple-procure), deployed at
[maple-procure.onrender.com](https://maple-procure.onrender.com/healthz). This repository is
self-hosted and has no public URL of its own.

<!-- TODO: GIF here - the n8n canvas mid-execution, then the review-queue rows in psql. -->
<!-- TODO: screenshot here - one NEEDS_REVIEW row expanded, showing rationale + provenance. -->

## Run it

You need Docker, Node 20 or newer, Python 3, a MapleProcure token with `read` scope, and an
Anthropic API key. From a clean clone:

```
cp .env.example .env          # set POSTGRES_PASSWORD and N8N_ENCRYPTION_KEY
make test                     # 87 JavaScript tests, 22 Python tests, no services needed
docker compose up -d          # n8n on http://127.0.0.1:5678, Postgres on 127.0.0.1:5432
make db-apply                 # create the triage table
```

`make test` and `make workflow` run with nothing else installed, so the code and the generated
workflow can be checked before any credentials exist. `make db-test` runs the SQL assertions
against a scratch database on the running Postgres.

Then, in the n8n UI at `http://127.0.0.1:5678`, create three credentials with exactly these names.
The workflow JSON refers to them by name and never contains a secret.

| Name | Type | Settings |
|---|---|---|
| `Postgres triage` | Postgres | Host `postgres`, port `5432`, database `triage`, user `n8n`, your `POSTGRES_PASSWORD` |
| `MapleProcure API` | Header Auth | Name `Authorization`, value `Bearer <token>` |
| `Anthropic API` | Header Auth | Name `x-api-key`, value your API key |

Import the workflow, run it once, then publish it so the hourly schedule takes over:

```
docker compose exec n8n n8n import:workflow --input=/workflows/procurement-triage.json
docker compose exec -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id=mapleProcureTriage
docker compose exec n8n n8n publish:workflow --id=mapleProcureTriage
docker compose restart n8n
```

The first run classifies every open notice the search profile finds. Later runs claim only notices
not seen before.

Read the review queue:

```
docker compose exec postgres psql -U n8n -d triage -c \
  "SELECT tender_reference, status, title, rationale FROM triage_results
   WHERE status IN ('NEEDS_REVIEW', 'NEEDS_REVIEW_CONTRADICTION', 'CLASSIFICATION_FAILED')
   ORDER BY closing_date NULLS LAST"
```

Regenerate the workflow after changing anything in `config/`, `workflows/code/` or
`database/queries/`: `make workflow`. `evaluation/` holds a command-line tool for hand-labelling
sampled notices against the same three outcomes the router produces; `make label` runs it.

## Pipeline

One n8n workflow, `workflows/procurement-triage.json`, runs the whole path.

1. **Every hour** or **Run now**. A Schedule Trigger, and a Manual Trigger for runs on demand.
2. **Recover stale claims**. Takes back notices an earlier execution claimed more than an hour ago
   and never finished. A notice on its third attempt is marked `PROCESSING_FAILED` instead.
3. **Build search requests**. One search per concept in `config/search-profile.json`. Parameters
   MapleProcure does not document are refused before any call is made.
4. **Search MapleProcure**. `GET /v1/tenders/search`, once per concept.
5. **Merge search results**. Removes duplicates across searches and keeps the concepts that found
   each notice. Notices already past their closing date are listed and left out. Searches that hit
   the 100-row cap are reported.
6. **Claim notices**. `INSERT … ON CONFLICT DO NOTHING RETURNING` in Postgres. The rows returned are
   the new notices this execution owns. A notice seen before is never claimed again.
7. **Collect work**. The claimed notices, plus any recovered in step 2.
8. **Fetch notice**. `GET /v1/tenders/{reference}` for the full notice and its provenance.
9. **Prepare classification**. Builds the Claude request from the notice. A lookup that returns
   no rows means the notice is gone.
10. **Notice found?** A notice that is gone stays claimed and is retried by recovery.
11. **Classify**. The Claude Messages API, with the reply constrained to a JSON schema.
12. **Validate and route**. Checks the reply against the contract, then applies
    `config/routing-rules.json`.
13. **Record classification**. Writes the status, the classification, the notice text and its
    provenance. Only the execution that holds the claim can write.

| Status | Meaning |
|---|---|
| `AUTO_MATCH` | A clear, confident match |
| `NOT_RELEVANT` | A clear, confident dismissal |
| `NEEDS_REVIEW` | Uncertain, unclear scope, below the confidence floor, or no rule matched |
| `NEEDS_REVIEW_CONTRADICTION` | The verdict and the criteria disagree |
| `CLASSIFICATION_FAILED` | The model refused, or the reply did not satisfy the contract |
| `PENDING` | Claimed, not yet classified |
| `PROCESSING_FAILED` | Recovery gave up after three attempts |

## Design decisions

**Confidence is a floor on automatic routing.** Claude returns a verdict, three criteria and a
confidence score. A notice becomes `AUTO_MATCH` only with a match verdict, all three criteria true
and confidence of at least 0.8. It becomes `NOT_RELEVANT` only with a not-relevant verdict its
criteria agree with, at the same confidence. Below 0.8, both go to `NEEDS_REVIEW`. Confidence holds
a notice back. It never pushes one forward. Nothing terminal happens without both a clear verdict
and high confidence, or a human.

**Contradictions get their own status.** "Not relevant" while the criteria say software in the
target market is a contradiction. So is "match" while the criteria say outside the target market.
Both go to `NEEDS_REVIEW_CONTRADICTION`, and those rules run before all others. "Unsure" stays
distinguishable from "said two incompatible things", and neither is dismissed.

**Review is a first-class state.** The review queue is the triage table: rows in `NEEDS_REVIEW`,
`NEEDS_REVIEW_CONTRADICTION` and `CLASSIFICATION_FAILED`. Each row holds the notice text Claude read,
the classification, the rationale, the criteria and the rule that sent it there. A reply that fails
validation is kept with its errors and raw text. Any reply no rule matches falls back to review.

**Refusals are a recorded state.** Classification runs over unfiltered public data, and a model can
decline a legitimate notice. The pipeline records a refusal as `CLASSIFICATION_FAILED` and routes it
to review with the other states that need a person. The notice is kept with its text and provenance,
and a person sees it.

**Provenance is carried end to end.** Every routed row carries its reference number, the source
file, MapleProcure's ingestion time, the file's last-modified date and row count, the model, the
prompt version, the rules version and a hash of the input. The source file, MapleProcure's ingestion
time, the file's last-modified date and row count come from MapleProcure's response. The model and
the input hash come from the classification request and its reply. The prompt version and rules
version are written by the pipeline from `config/`. Twelve `CHECK` constraints enforce the state
invariants in Postgres. One of them refuses any routed row without its provenance.

**Search fans out across 13 concepts.** MapleProcure's search requires every term in a query to
match. One query holding the whole business profile matches nothing. `config/search-profile.json`
defines 13 concepts, each its own search. The workflow merges and deduplicates the results before it
claims anything.

**Self-hosted and pinned.** Docker Compose runs n8n 2.38.7 and Postgres 18.6, bound to localhost.
Credentials live in n8n's encrypted credential store. The workflow JSON names them and never
contains them.

**Prompt and rules live in `config/`.** The classifier prompt, its settings, the search profile and
the routing rules each have one file. It is the single source for the workflow and for anything
else that reads them. `make workflow` generates the workflow from them, the code in
`workflows/code/` and the SQL in `database/queries/`. The reply schema comes from the same contract
the validator and the router read, and routing is interpreted in one module, `route.js`.

