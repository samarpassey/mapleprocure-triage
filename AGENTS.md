# MapleProcure Triage

An n8n automation layer over MapleProcure's REST API. On a schedule it searches open federal
tenders, claims the ones it has not seen, has Codex classify each against a business profile,
routes the result with deterministic rules and queues what the rules cannot decide for a human.
Postgres holds triage state and the audit trail. n8n 2.38.7 and Postgres 18.6 in Docker Compose;
Code node logic as plain JavaScript modules; the labelling CLI in stdlib Python.

The original design document is not in this repo. Where the build departs from it,
`docs/DESIGN-AMENDMENTS.md` states what the design said and what changed, keyed by its sections.

## What this is not

Not a search engine and not a copy of CanadaBuys — MapleProcure owns ingest, search and notice
text. This repo stores what was *decided* about a notice and which source record the decision was
based on. Not a dashboard, not multi-tenant, not an auth project, not a chatbot, not a replacement
for MapleProcure.

## Commands

| Command | What |
|---|---|
| `docker compose up -d` | n8n on `127.0.0.1:5678`, Postgres on `127.0.0.1:5432` |
| `make db-apply` | Apply `database/schema.sql` to the `triage` database |
| `make db-test` | SQL assertions in `database/tests/`, against a scratch database on the live Postgres |
| `make test` | JavaScript module tests, Python tests, and the file-size cap |
| `make label` | Label the evaluation set, one notice at a time, resumably |

## Invariants — do not break these without an entry in `docs/DECISIONS.md`

1. **Never describe a capability before it exists and has run against a live system** — in the
   README, this file, comments, anywhere. Passing unit tests is not "verified"; a workflow that
   has not been imported into n8n and executed does not work yet.
2. **Workflow JSON is generated against `workflows/reference/node-shapes.json`.** It is an export
   from this n8n instance. Never write a node structure, parameter name or `typeVersion` from
   memory. A node type that is not in the export gets exported from the instance first.
3. **The model proposes; `config/routing-rules.json` decides.** Rules are interpreted in one place,
   `workflows/code/route.js`, which both the workflow and the eval harness call. The fallback
   route is always a review state. Confidence never routes anything.
4. **Dedup is a claim, not a check.** `INSERT … ON CONFLICT DO NOTHING RETURNING`. No
   select-then-act anywhere — recovery reclaims with a conditional `UPDATE`, and a result is
   written only by the execution that holds the claim.
5. **Every classified row carries MapleProcure provenance** — `as_of`, `source_file`,
   `source_last_modified`, `source_row_count` — from the envelope of the response the model read.
   Enforced by `CHECK` constraints, not by convention.
6. **`notice_url` is never constructed.** It is null on roughly 6% of notices. Print the reference
   number instead.
7. **Code modules are pure.** CommonJS, no `require`, no n8n globals (`$input`, `$json`, `$now`),
   config and clock passed in as arguments. Each file must be usable whole as one Code node.
8. **A person labels the evaluation set.** Nothing in `evaluation/` calls a model to produce or
   suggest a label, and the labeller never shows which search stratum a notice came from.
9. **No source file over 250 lines** — `.js`, `.py`, `.sql` — enforced by
   `workflows/code/test/file-sizes.test.js`. Approaching the cap is the signal to split.
10. **Docs change in the same commit as the code they describe.** `PROGRESS.md` is updated as work
    lands, not at the end.
11. **Secrets live in `.env` or n8n's encrypted credential store**, never in workflow JSON or
    committed files. The MapleProcure token is `read` only; nothing here needs or asks for `pii` or
    `export`.

## Read these when

| File | When |
|---|---|
| `PROGRESS.md` | **Start of every session.** Component states, next step, open threads. |
| `PLAN.md` | Before starting a component. Verified API facts, scope, what gets dropped first. |
| `docs/DECISIONS.md` | When a choice feels arbitrary — it was probably decided already. |
| `docs/DESIGN-AMENDMENTS.md` | Before citing the original design for states, routing or metrics. |
| `workflows/reference/node-shapes.json` | Before writing or changing any workflow JSON. |
| `config/routing-rules.json` | Before touching classification, validation, routing or the eval. |

## Layout

```
config/               search-profile.json, routing-rules.json — shared by workflow and eval
database/init/        creates the triage database on first Postgres boot
database/schema.sql   triage_results
database/queries/     every statement the workflow runs, one per file, parameters documented
database/tests/       SQL assertions, run by `make db-test`
workflows/reference/  node-shapes.json — ground truth for workflow JSON
workflows/code/       Code node logic; tests in workflows/code/test/
evaluation/           labelling CLI and sampling; labelled-notices.json is committed
docs/                 DECISIONS.md, DESIGN-AMENDMENTS.md
```

## Repo conventions

- Public-facing repo. Committed files describe the code and nothing else — no notes to self, no
  personal context, no third-party names.
- Tests assert behaviour, not implementation. Module and Python tests never touch the network;
  `make db-test` deliberately runs against the local Postgres, because constraint and concurrency
  behaviour is the thing under test.
- SQL is parameterised. No string interpolation into a statement, in a module or a workflow node.
