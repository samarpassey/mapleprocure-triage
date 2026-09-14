"""Label the evaluation set by hand: `make label`, or `python3 -m evaluation.label`.

The first run draws a sample of real notices from the deployed MapleProcure REST API (see
`sampling.py`), fetches each one's full text, and freezes it all into
`evaluation/labelled-notices.json`. Notices close and leave the open-tender file within weeks, so
the text a label was given against is kept beside the label. Later runs never redraw: they resume
at the first unlabelled notice.

One notice at a time — title, buyer, category, closing date, description. Deliberately not shown:
the search stratum a notice was drawn from. Knowing it was drawn as a near-miss biases the label.

    m  match          -> MATCH
    n  not relevant   -> NOT_RELEVANT
    u  uncertain      -> NEEDS_REVIEW
    s  skip           (asked again next run)
    q  quit

The file is rewritten atomically after every label. No model is called anywhere in this program;
a label is a keypress.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from evaluation import sampling

ROOT = Path(__file__).resolve().parents[1]
LABEL_FILE = ROOT / "evaluation" / "labelled-notices.json"
PROFILE_FILE = ROOT / "config" / "search-profile.json"
LABELS = {"m": "MATCH", "n": "NOT_RELEVANT", "u": "NEEDS_REVIEW"}
PROVENANCE = ("as_of", "source_file", "source_last_modified", "source_row_count")
NOTICE_FIELDS = ("title", "description", "buyer_name", "category", "notice_type",
                 "procurement_method", "gsin_description", "unspsc_description",
                 "closing_date", "notice_url")


def credentials() -> tuple[str, str]:
    values = dict(os.environ)
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() and key.strip() not in values:
                values[key.strip()] = value.strip()
    base, token = values.get("MAPLEPROCURE_BASE_URL"), values.get("MAPLEPROCURE_TOKEN")
    if not base or not token:
        raise SystemExit("MAPLEPROCURE_BASE_URL and MAPLEPROCURE_TOKEN must be set, in .env or the env")
    return base.rstrip("/"), token


def get_json(base: str, token: str, path: str, params: dict | None = None) -> dict:
    """GET with backoff on 503 and network errors only — MapleProcure's retryable failures."""
    url = base + path + ("?" + urllib.parse.urlencode(params) if params else "")
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code != 503:
                raise SystemExit(f"{error.code} from {path}: {error.read().decode(errors='replace')}")
        except urllib.error.URLError as error:
            print(f"  {path}: {error.reason}", file=sys.stderr)
        time.sleep(5 * 2**attempt)
    raise SystemExit(f"{path}: still unavailable after 5 attempts")


def draw(base: str, token: str, profile: dict, per_concept: int, per_near_miss: int, seed: int,
         now: str) -> dict:
    chosen_strata = sampling.strata(profile, per_concept, per_near_miss)
    results, searched = {}, []
    for stratum in chosen_strata:
        body = get_json(base, token, "/v1/tenders/search", {"keywords": stratum.keywords, "limit": 100})
        results[stratum.id] = body["rows"]
        searched.append({"id": stratum.id, "kind": stratum.kind, "keywords": stratum.keywords,
                         "total_matches": body["total_matches"], "truncated": body["truncated"]})
        print(f"  searched {stratum.keywords!r}: {body['total_matches']}", file=sys.stderr)
    notices = []
    for stratum, row in sampling.select(results, chosen_strata, seed, now):
        reference = row["reference_number"]
        body = get_json(base, token, f"/v1/tenders/{urllib.parse.quote(reference)}")
        if not body["rows"]:
            print(f"  {reference}: gone from the open file since the search; skipped", file=sys.stderr)
            continue
        detail = body["rows"][0]
        notices.append({"tender_reference": reference, "stratum": stratum.id,
                        **{field: detail.get(field) for field in NOTICE_FIELDS},
                        "source": {field: body[field] for field in PROVENANCE},
                        "label": None, "labelled_at": None})
    return {"sample": {"drawn_at": now, "seed": seed, "per_concept": per_concept,
                       "per_near_miss": per_near_miss, "profile_version": profile["version"],
                       "strata": searched},
            "notices": notices}


def load(path: Path) -> dict | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def save(path: Path, data: dict) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def pending(data: dict) -> list[dict]:
    return [notice for notice in data["notices"] if notice["label"] is None]


def record(notice: dict, key: str, at: str) -> None:
    if key not in LABELS:
        raise ValueError(f"not a label key: {key!r}")
    notice["label"], notice["labelled_at"] = LABELS[key], at


def render(notice: dict, position: int, total: int) -> str:
    description = (notice.get("description") or "(no description in the source)").replace("\r\n", "\n")
    paragraphs = [textwrap.fill(p, 96) for p in description.split("\n") if p.strip()]
    link = notice.get("notice_url") or f"no link in the source — reference {notice['tender_reference']}"
    return "\n".join([
        "", "=" * 96, f"[{position}/{total}]  {notice['title']}", "",
        f"Buyer: {notice.get('buyer_name') or '—'}    Category: {notice.get('category') or '—'}",
        f"Closing: {notice.get('closing_date') or 'not stated'}    Type: {notice.get('notice_type') or '—'}",
        f"GSIN: {notice.get('gsin_description') or '—'}    UNSPSC: {notice.get('unspsc_description') or '—'}",
        f"Notice: {link}", "", *paragraphs, "",
    ])


def session(data: dict, path: Path, read=input, write=print, clock=None) -> None:
    clock = clock or (lambda: datetime.now(ZoneInfo("America/Toronto")).isoformat(timespec="seconds"))
    labelled = len(data["notices"]) - len(pending(data))
    for notice in pending(data):
        labelled += 1
        write(render(notice, labelled, len(data["notices"])))
        while True:
            try:
                key = read("[m] match  [n] not relevant  [u] uncertain  [s] skip  [q] quit > ")
            except EOFError:  # input closed: the same as quitting; every label given is saved
                return
            key = key.strip().lower()
            if key in LABELS:
                record(notice, key, clock())
                save(path, data)
                break
            if key == "s":
                break
            if key == "q":
                return
    left = len(pending(data))
    write(f"\n{len(data['notices']) - left} labelled, {left} left.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--file", type=Path, default=LABEL_FILE)
    parser.add_argument("--per-concept", type=int, default=1)
    parser.add_argument("--per-near-miss", type=int, default=2)
    parser.add_argument("--seed", type=int, default=20260913)
    parser.add_argument("--draw-only", action="store_true", help="draw and freeze the sample, then stop")
    args = parser.parse_args(argv)
    data = load(args.file)
    if data is None:
        base, token = credentials()
        now = datetime.now(ZoneInfo("America/Toronto")).strftime("%Y-%m-%dT%H:%M:%S")
        profile = json.loads(PROFILE_FILE.read_text(encoding="utf-8"))
        print("Drawing the sample (the first call can take a minute while the service wakes)…",
              file=sys.stderr)
        data = draw(base, token, profile, args.per_concept, args.per_near_miss, args.seed, now)
        save(args.file, data)
        print(f"Froze {len(data['notices'])} notices into {args.file}", file=sys.stderr)
    if not args.draw_only:
        session(data, args.file)


if __name__ == "__main__":
    main()
