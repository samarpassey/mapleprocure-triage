import json
import unittest
from pathlib import Path

from evaluation import sampling

PROFILE = json.loads(
    (Path(__file__).resolve().parents[2] / "config" / "search-profile.json").read_text()
)
NOW = "2026-09-13T20:00:00"


def row(reference, closing_date="2026-10-20T14:00:00"):
    return {"reference_number": reference, "title": reference, "closing_date": closing_date}


def stratum(sid, kind="concept", take=1):
    return sampling.Stratum(sid, kind, sid, take)


class StrataTest(unittest.TestCase):
    def test_one_concept_stratum_per_profile_concept_searched_as_the_workflow_searches_it(self):
        concept_strata = [s for s in sampling.strata(PROFILE, 1, 2) if s.kind == "concept"]
        self.assertEqual(
            [(s.id, s.keywords) for s in concept_strata],
            [(c["id"], c["keywords"]) for c in PROFILE["concepts"]],
        )

    def test_every_near_miss_search_contains_a_profile_concept_so_the_workflow_retrieves_it(self):
        keywords = {c["id"]: c["keywords"] for c in PROFILE["concepts"]}
        by_id = {n.id: n for n in sampling.NEAR_MISSES}
        for s in sampling.strata(PROFILE, 1, 2):
            if s.kind == "near-miss":
                self.assertTrue(s.keywords.endswith(" " + keywords[by_id[s.id].within]), s.keywords)
                self.assertEqual(s.take, 2)

    def test_the_near_misses_named_in_the_design_are_present(self):
        ids = {n.id for n in sampling.NEAR_MISSES}
        self.assertIn("consulting-software", ids)
        self.assertIn("hardware-software", ids)

    def test_a_near_miss_within_a_concept_the_profile_dropped_is_refused(self):
        trimmed = {**PROFILE, "concepts": [c for c in PROFILE["concepts"] if c["id"] != "software"]}
        with self.assertRaisesRegex(ValueError, "no longer be a subset"):
            sampling.strata(trimmed, 1, 2)


class SelectTest(unittest.TestCase):
    def test_a_notice_in_two_strata_is_chosen_once(self):
        chosen = sampling.select(
            {"software": [row("cb-1")], "cloud": [row("cb-1"), row("cb-2")]},
            [stratum("software"), stratum("cloud")], seed=1, now=NOW,
        )
        self.assertEqual(sorted(r["reference_number"] for _, r in chosen), ["cb-1", "cb-2"])

    def test_near_miss_strata_choose_before_concept_strata(self):
        chosen = sampling.select(
            {"software": [row("shared")], "consulting-software": [row("shared")]},
            [stratum("software"), stratum("consulting-software", "near-miss")], seed=1, now=NOW,
        )
        self.assertEqual([(s.id, r["reference_number"]) for s, r in chosen],
                         [("consulting-software", "shared")])

    def test_each_stratum_contributes_at_most_its_quota(self):
        rows = [row(f"cb-{i}") for i in range(10)]
        chosen = sampling.select({"software": rows}, [stratum("software", take=3)], seed=1, now=NOW)
        self.assertEqual(len(chosen), 3)

    def test_a_stratum_with_fewer_rows_than_its_quota_gives_what_it_has(self):
        chosen = sampling.select({"licence": [row("cb-1")]}, [stratum("licence", take=5)],
                                 seed=1, now=NOW)
        self.assertEqual(len(chosen), 1)

    def test_closed_notices_are_skipped_and_undated_ones_kept(self):
        chosen = sampling.select(
            {"software": [row("closed", "2025-08-22T14:00:00"), row("undated", None)]},
            [stratum("software", take=2)], seed=1, now=NOW,
        )
        self.assertEqual([r["reference_number"] for _, r in chosen], ["undated"])

    def test_the_same_seed_and_results_draw_the_same_sample_whatever_order_rows_arrive_in(self):
        rows = [row(f"cb-{i}") for i in range(20)]
        strata = [stratum("software", take=4)]
        first = sampling.select({"software": rows}, strata, seed=7, now=NOW)
        again = sampling.select({"software": list(reversed(rows))}, strata, seed=7, now=NOW)
        self.assertEqual([r["reference_number"] for _, r in first],
                         [r["reference_number"] for _, r in again])


class ClosedRuleTest(unittest.TestCase):
    def test_matches_merge_results(self):
        self.assertTrue(sampling.is_closed("2025-08-22T14:00:00", NOW))
        self.assertFalse(sampling.is_closed(None, NOW))
        self.assertFalse(sampling.is_closed("2026-09-13T23:59:00", NOW))


if __name__ == "__main__":
    unittest.main()
