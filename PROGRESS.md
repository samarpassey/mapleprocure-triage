# Progress

One line per step of the build order in `PLAN.md`, updated when a step lands. What already
existed before the scope cut is listed first.

| # | Component | Status | Notes |
|---|---|---|---|
| — | Local stack: n8n 2.38.7, Postgres 18, reference node export | ✅ done | Manual Trigger added to the export from the instance |
| — | Triage schema and state-machine statements | ✅ done | Claim, recovery with fencing and the attempt cap, record classification. 59 SQL assertions on the live Postgres 18, including two-connection races for claim and recovery |
| — | Search profile | ✅ done | 13 concepts, 172 distinct notices retrieved on 2026-09-13, none truncated; 11 exclusions with measured reasons |
| 1 | Overrules and new rules | ✅ done | Notice text stored with its hash computed in SQL; `currently_open` removed; confidence floor 0.8 on both automatic routes; match outside the target market is a contradiction. All 24 verdict × criteria combinations tested above and below the floor. Schema re-applied to `triage` |
| 2 | Classifier prompt | ✅ done | `config/classifier-prompt.md`, `config/classifier.json`. Ran live on 150 notices with `claude-opus-5` and structured output: 149 replies ended normally and all passed validation; 1 refusal is recorded as `CLASSIFICATION_FAILED` |
| 3 | Main triage workflow | ✅ done | `make workflow` writes 14 nodes. n8n's own validator: 0 errors, 0 warnings. Imported; every credential checked bound to its intended node after import |
| 4 | Error handler workflow | ➖ not built | No notification channel exists (`docs/DECISIONS.md`) |
| 5 | First live run | ✅ done | 2026-09-14 18:16 UTC, 30 s end to end. 13 searches returned 172 notices: 22 already closed and listed, 150 claimed and classified. 42 `AUTO_MATCH`, 88 `NOT_RELEVANT`, 19 `NEEDS_REVIEW` (7 scope unclear, 7 uncertain, 5 below the confidence floor), 0 contradictions, 1 `CLASSIFICATION_FAILED`. On every row the notice text starts with its own reference, the hash matches the text, and provenance is present. A second run claimed nothing |
| 6 | README | ✅ done | Four sections, written against the runs above. The workflow is published; its first scheduled execution (7, 2026-09-14 19:35:56 UTC) searched all 13 concepts, claimed nothing new and succeeded |

## Next step

None in the build order. The workflow is published and runs on its schedule.

## What the workflow runs

```js
buildRequests(profile)                                      // -> [{ concept, method, path, query }]
mergeResults([{ concept, body }], { now })                  // -> { notices, closed, truncated }
prepareClassification(detail, reference, { settings, prompt, contract })
                                                            // -> { found: false } | { found, notice_text, request, envelope }
validateClassification(output, rules.contract)              // -> { ok, classification } | { ok: false, errors }
route(classification, rules)                                // -> { status, rule, rules_version }
recordFor(response, prepared, { rules, promptVersion }, { validateClassification, route })
                                                            // -> record for record-classification.sql | null
```

```
database/queries/recover.sql                $1 execution id
database/queries/claim.sql                  $1 jsonb batch, $2 execution id, $3 workflow version
database/queries/record-classification.sql  $1 reference, $2 execution id, $3 jsonb record
```

## Open threads

- **MapleProcure silently ignores unknown query parameters.** `?q=software` returns every notice
  with `200`. A misspelt parameter would put all 901 notices through classification in one run.
  `build-requests.js` refuses undocumented parameters on this side; the fix belongs upstream.
- **Search is capped at 100 rows with no offset.** A concept that grows past 100 matches loses
  rows with no way to page. `merge-results.js` reports it; the largest concept is 53 today.
## Found on the live runs

- **An array in `queryReplacement` becomes a Postgres array literal.** The first live run failed at
  `Claim notices` with `cannot cast type text[] to jsonb`: the claim batch is a JavaScript array, and
  the Postgres node formatted it as `text[]`. The throwaway probe had passed an object, which the node
  formats as JSON, so the probe did not show this. Every jsonb parameter is now passed as
  `JSON.stringify(...)`, and the fixed workflow ran clean.
- **A credential reference without `id: null` is not resolved by name on import.** The first import
  bound `Classify` to `MapleProcure API`, the other HTTP header credential, which would have sent the
  MapleProcure token to the Anthropic API. It was caught by exporting the workflow after import,
  before any call went out. `build.js` now writes `id: null`, and bindings are checked after every
  import.
- **One refusal with the server-side fallback on.** `WS5844100605-Doc5844196633`, an agricultural
  UAV purchase, came back with `stop_reason: refusal`. It sits in the review queue as
  `CLASSIFICATION_FAILED`.
- **Timing.** The 150-notice backfill took 30 seconds, far inside recovery's one-hour threshold.
- **Recovery and the empty lookup, run live.** Two verification rows claimed two hours earlier were
  reclaimed by the next execution. The one on its first attempt was looked up, MapleProcure answered
  `200` with `rows: []`, it took the false branch of `Notice found?` and stayed `PENDING` on attempt
  2 under the new execution id. The one on its third attempt became `PROCESSING_FAILED`. Both rows
  were deleted afterwards.
- **The first scheduled fire came later than the cron suggests.** n8n derives the trigger's minute
  from the node id; for this node the cron is `38 43 */1 * * *`. After the restart at 18:20 UTC the
  first scheduled execution started at 19:35:56 UTC. Nothing fired at 18:43 or 19:43, and n8n logs
  cron registration and ticks only at debug level. The cause is not confirmed.
