"""Draws the evaluation sample: which real notices a person will label.

Two kinds of stratum:

- **Concept strata**, one per concept in `config/search-profile.json`, searched exactly as the
  workflow searches it. They spread the sample across everything the profile retrieves.
- **Near-miss strata**: a near-miss term ANDed with one profile concept's keywords, such as
  `consulting software`. FTS5 requires every word, so each near-miss result is a notice the
  workflow retrieves anyway — the set never tests the classifier on something production never
  shows it. They exist to put genuine ambiguity in the set: consulting engagements that mention
  software, maintenance contracts, equipment bought with its software. A set without ambiguity
  routes nothing to review and so demonstrates nothing about that path.

Near-miss strata choose first, so notices shared with a broad concept count toward the ambiguity
quota rather than being used up by the concept. Selection is deterministic for a given seed and
set of search results. Notices already past closing are skipped by the rule
`workflows/code/merge-results.js` applies.

Nothing here decides, suggests or ranks a label.
"""

from __future__ import annotations

import random
from dataclasses import dataclass


@dataclass(frozen=True)
class NearMiss:
    id: str
    term: str
    within: str  # id of the profile concept whose keywords are ANDed on
    why: str


# Counts are total_matches when measured on 2026-09-13; they are context, not assertions.
NEAR_MISSES = (
    NearMiss("consulting-software", "consulting", "software",
             "Consulting and staffing engagements that mention software (12)"),
    NearMiss("consulting-it", "consulting", "information-technology",
             "Professional-services resourcing described as information technology (21)"),
    NearMiss("hardware-software", "hardware", "software",
             "Hardware supply or maintenance with software in scope (5)"),
    NearMiss("maintenance-software", "maintenance", "software",
             "Maintenance contracts that name the software being maintained (16)"),
    NearMiss("equipment-software", "equipment", "software",
             "Scientific and industrial equipment bought with its control software (13)"),
    NearMiss("installation-software", "installation", "software",
             "Installation and construction work that mentions software (7)"),
    NearMiss("training-platform", "training", "platform",
             "Training services delivered on, or about, a platform (7)"),
)


@dataclass(frozen=True)
class Stratum:
    id: str
    kind: str  # "concept" or "near-miss"
    keywords: str
    take: int


def strata(profile: dict, per_concept: int, per_near_miss: int) -> list[Stratum]:
    keywords = {concept["id"]: concept["keywords"] for concept in profile["concepts"]}
    result = [Stratum(cid, "concept", words, per_concept) for cid, words in keywords.items()]
    for near_miss in NEAR_MISSES:
        if near_miss.within not in keywords:
            raise ValueError(
                f"near-miss {near_miss.id!r} is within unknown concept {near_miss.within!r}; "
                "it would no longer be a subset of what the workflow retrieves"
            )
        result.append(Stratum(near_miss.id, "near-miss",
                              f"{near_miss.term} {keywords[near_miss.within]}", per_near_miss))
    return result


def is_closed(closing_date: str | None, now: str) -> bool:
    """Same rule as merge-results.js: past closing is closed; no closing date is not."""
    return closing_date is not None and closing_date < now


def select(
    results: dict[str, list[dict]], chosen_strata: list[Stratum], seed: int, now: str
) -> list[tuple[Stratum, dict]]:
    """Pick up to `take` unclosed, not-yet-chosen notices from each stratum's search rows."""
    rng = random.Random(seed)
    ordered = sorted(chosen_strata, key=lambda stratum: stratum.kind != "near-miss")
    chosen: list[tuple[Stratum, dict]] = []
    taken: set[str] = set()
    for stratum in ordered:
        rows = sorted(results[stratum.id], key=lambda row: row["reference_number"])
        rng.shuffle(rows)
        picked = 0
        for row in rows:
            if picked == stratum.take:
                break
            reference = row["reference_number"]
            if reference in taken or is_closed(row.get("closing_date"), now):
                continue
            chosen.append((stratum, row))
            taken.add(reference)
            picked += 1
    return chosen
