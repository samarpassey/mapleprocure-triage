import json
import re
import tempfile
import unittest
from pathlib import Path

from evaluation import label

EVALUATION = Path(__file__).resolve().parents[1]


def notice(reference, stratum="consulting-software", notice_url="https://canadabuys.canada.ca/x"):
    return {"tender_reference": reference, "stratum": stratum, "title": f"Title {reference}",
            "description": "Line one.\r\nLine two.", "buyer_name": "DND", "category": "Services",
            "notice_type": "RFP", "procurement_method": None, "gsin_description": None,
            "unspsc_description": None, "closing_date": "2026-10-20T14:00:00",
            "notice_url": notice_url, "source": {"as_of": "2026-09-14T00:19:57+00:00"},
            "label": None, "labelled_at": None}


def label_set(*references):
    return {"sample": {"seed": 1}, "notices": [notice(r) for r in references]}


class Scripted:
    def __init__(self, *keys):
        self.keys, self.prompts = list(keys), 0

    def __call__(self, _prompt):
        self.prompts += 1
        return self.keys.pop(0)


def run(data, *keys):
    path = Path(tempfile.mkdtemp()) / "labelled-notices.json"
    shown = []
    label.session(data, path, read=Scripted(*keys), write=shown.append, clock=lambda: "T")
    return path, "\n".join(shown)


class LabelTest(unittest.TestCase):
    def test_the_three_keys_record_the_design_doc_labels(self):
        path, _ = run(label_set("a", "b", "c"), "m", "n", "u")
        saved = json.loads(path.read_text())
        self.assertEqual([n["label"] for n in saved["notices"]],
                         ["MATCH", "NOT_RELEVANT", "NEEDS_REVIEW"])
        self.assertEqual({n["labelled_at"] for n in saved["notices"]}, {"T"})

    def test_an_unknown_key_asks_again_and_records_nothing(self):
        data = label_set("a")
        keys = Scripted("yes", "", "m")
        label.session(data, Path(tempfile.mkdtemp()) / "f.json", read=keys, write=lambda _: None,
                      clock=lambda: "T")
        self.assertEqual((keys.prompts, data["notices"][0]["label"]), (3, "MATCH"))

    def test_quitting_keeps_every_label_already_given_and_resumes_after_them(self):
        path, _ = run(label_set("a", "b", "c"), "u", "q")
        resumed = label.load(path)
        self.assertEqual([n["tender_reference"] for n in label.pending(resumed)], ["b", "c"])

    def test_input_closing_mid_session_is_a_quit_not_a_crash(self):
        data = label_set("a", "b")
        keys = iter(["m"])

        def read(_prompt):
            try:
                return next(keys)
            except StopIteration:
                raise EOFError from None

        path = Path(tempfile.mkdtemp()) / "f.json"
        label.session(data, path, read=read, write=lambda _: None, clock=lambda: "T")
        self.assertEqual([n["label"] for n in label.load(path)["notices"]], ["MATCH", None])

    def test_a_skipped_notice_stays_unlabelled_and_comes_back_next_run(self):
        path, _ = run(label_set("a", "b"), "s", "n")
        self.assertEqual([n["tender_reference"] for n in label.pending(label.load(path))], ["a"])

    def test_the_file_is_replaced_whole_with_no_temporary_left_behind(self):
        path, _ = run(label_set("a"), "m")
        self.assertEqual([p.name for p in path.parent.iterdir()], ["labelled-notices.json"])

    def test_the_labeller_never_sees_the_stratum_a_notice_was_drawn_from(self):
        _, shown = run(label_set("a"), "q")
        self.assertNotIn("consulting-software", shown)
        self.assertNotIn("near-miss", shown.lower())

    def test_title_and_description_are_shown_with_windows_line_endings_normalised(self):
        _, shown = run(label_set("a"), "q")
        self.assertIn("Title a", shown)
        self.assertIn("Line one.\nLine two.", shown)

    def test_a_notice_without_a_url_shows_its_reference_and_no_invented_link(self):
        data = {"sample": {}, "notices": [notice("cb-9", notice_url=None)]}
        _, shown = run(data, "q")
        self.assertIn("no link in the source — reference cb-9", shown)
        self.assertNotRegex(shown, r"https?://")

    def test_record_refuses_anything_but_the_three_label_keys(self):
        with self.assertRaises(ValueError):
            label.record(notice("a"), "s", "T")

    def test_nothing_in_evaluation_calls_a_model(self):
        for source in EVALUATION.glob("*.py"):
            text = source.read_text().lower()
            self.assertIsNone(re.search(r"anthropic|openai|claude|/v1/messages", text), source.name)


if __name__ == "__main__":
    unittest.main()
