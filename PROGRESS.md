# Progress

One line per component. Update in the same commit as the work.
Full scope for each is in `PLAN.md`.

| # | Component | Status | Notes |
|---|---|---|---|
| — | Local stack — n8n 2.38.7 + Postgres 18, reference node export | ✅ done | Pre-existing |
| 0 | Context files, Makefile, file-size cap | ✅ done | One size test covers `.js`, `.py`, `.sql` |
| 1 | Triage schema and state-machine statements | ✅ done | 58 SQL assertions on the live Postgres 18, including two-connection races for claim and recovery. Applied to `triage` |
| 2 | Search profile | ✅ done | 13 concepts, 172 distinct notices retrieved on 2026-09-13, none truncated; 11 exclusions with measured reasons |
| 3 | Routing rules and output contract | ✅ done | 5 rules + review fallback; all 48 verdict × criteria combinations tested |
| 4 | Code modules | 🟡 tested, not in n8n | 6 modules; 67 tests including schema↔config drift. Never yet run inside a Code node |
| 5 | Labelling CLI | 🟡 built, set unlabelled | Draw verified live into a scratch file: 20 strata, 27 notices. The committed set is drawn and labelled by the owner — `make label` |
| 6 | Classifier | ⬜ not started | |
| 7 | Workflows | ⬜ not started | |
| 8 | Human review path | ⬜ not started | `review-queue.sql` and `record-review.sql` exist and are tested |
| 9 | Eval harness + `make eval` | ⬜ not started | Deferred by decision until the harness exists |
| 10 | README and known limitations | ⬜ not started | |

## Next step

**Label the evaluation set** — `make label`, by a person. The first run draws and freezes the
sample; later runs resume.

Then **component 6, the classifier.** Load the current Anthropic API documentation first. The
prompt must produce exactly the contract in `config/routing-rules.json`, and whatever it returns
goes through `validate-classification.js` unchanged. Settle the `currently_open` question in
`PLAN.md` before writing the prompt.

## Layer APIs

```js
buildRequests(profile)                          // -> [{ concept, method, path, query }]
mergeResults([{ concept, body }], { now })      // -> { notices, closed, truncated }
validateClassification(output, rules.contract)  // -> { ok, classification } | { ok: false, errors }
route(classification, rules)                    // -> { status, rule, rules_version }
formatNotification(row, rules.contract.categories)  // -> { text, has_link }
rollupMetrics(countRows, { minutesPerNotice })  // -> { processed, decided_without_human, sent_to_review, …, summary }
```

```
database/queries/claim.sql                  $1 jsonb batch, $2 execution id, $3 workflow version
database/queries/recover.sql                $1 execution id
database/queries/record-classification.sql  $1 reference, $2 execution id, $3 jsonb result
database/queries/review-queue.sql           $1 limit
database/queries/record-review.sql          $1 reference, $2 decision, $3 reviewer, $4 note
database/queries/metrics-counts.sql         $1 window start, $2 window end
```

## Open threads

- **MapleProcure silently ignores unknown query parameters.** `?q=software` returns every notice
  with `200`. It is the same hole `rest.py` closes for `region` — a misspelt parameter becomes an
  unfiltered search — and here it would put all 901 notices through classification in one run.
  `build-requests.js` refuses undocumented parameters on this side; the fix belongs upstream.
- **Search is capped at 100 rows with no offset.** A concept that grows past 100 matches loses
  rows with no way to page. `merge-results.js` reports it; the largest concept is 53 today.
- **Unverified in n8n, all component 7:**
  - How the Postgres node binds a `jsonb` parameter.
  - Whether its driver returns `timestamp` columns as strings or `Date`s. `format-notification.js`
    refuses a `Date` closing date, so a cast to text in the statement may be needed.
  - Whether a batch classifies inside the one-hour recovery threshold.
- **Sample composition.** In the live draw, several concept picks were boilerplate hits: furniture
  via `SaaS`, security guards via `license`, residential facilities via `information technology`.
  That is honest about what the profile retrieves. But a set with only a handful of clear matches
  gives the false-auto-route number little to measure. If the first pass through the set shows
  that, delete the file and redraw with `--per-concept 2` *before* labelling further — never
  after labels exist.
- **`MapleProcure Triage.pdf` is not tracked by git**, though `CLAUDE.md` cites it as the design.
