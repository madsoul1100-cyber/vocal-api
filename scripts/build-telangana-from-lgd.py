#!/usr/bin/env python3
"""
One-shot: download Telangana mandals from LGD CSV → telangana-full.json

Usage (from vocal-api/):
  python3 scripts/build-telangana-from-lgd.py
  python3 scripts/build-telangana-from-lgd.py --csv path/to/local.csv

Then load into DB:
  ORG_ID=<uuid> npm run seed:territories -- data/territories/telangana-full.json
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE_JSON = ROOT / "data" / "territories" / "telangana.json"
OUT_JSON = ROOT / "data" / "territories" / "telangana-full.json"
DEFAULT_CSV_URL = (
    "https://gist.githubusercontent.com/planemad/"
    "b2195c7feb506f8436659f36da1e58af/raw/india-subdistricts-lgd.csv"
)

# LGD district name variants → normalized key used in telangana.json district names
DISTRICT_ALIASES: dict[str, str] = {
    "jagitial": "jagtial",
    "jangoan": "jangaon",
    "jayashankarbhupalapally": "jayashankarbhupalpally",
    "kumurambheemasifabad": "komarambheemasifabad",
    "mahabubabad": "mahabubabad",
    "warangalrural": "warangal",
    "warangalurban": "warangal",
}


def norm_name(value: str) -> str:
    s = re.sub(r"[^a-z0-9]", "", (value or "").lower())
    return DISTRICT_ALIASES.get(s, s)


def load_base() -> dict:
    with BASE_JSON.open(encoding="utf-8") as f:
        return json.load(f)


def build_district_map(base: dict) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for node in base.get("territories", []):
        if node.get("level") != 2:
            continue
        mapping[norm_name(node["name"])] = node["key"]
    return mapping


def download_csv(url: str) -> str:
    print(f"Downloading LGD CSV from:\n  {url}")
    with urllib.request.urlopen(url, timeout=120) as resp:
        return resp.read().decode("utf-8", errors="replace")


def read_csv_text(text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for row in csv.DictReader(text.splitlines()):
        rows.append(row)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Build telangana-full.json from LGD mandal CSV")
    parser.add_argument("--csv", help="Local CSV path (skip download)")
    parser.add_argument("--url", default=DEFAULT_CSV_URL, help="CSV download URL")
    args = parser.parse_args()

    if not BASE_JSON.exists():
        print(f"Missing base file: {BASE_JSON}", file=sys.stderr)
        return 1

    base = load_base()
    district_map = build_district_map(base)

    if args.csv:
        csv_path = Path(args.csv)
        if not csv_path.exists():
            print(f"CSV not found: {csv_path}", file=sys.stderr)
            return 1
        csv_text = csv_path.read_text(encoding="utf-8", errors="replace")
        print(f"Using local CSV: {csv_path}")
    else:
        csv_text = download_csv(args.url)

    lgd_rows = read_csv_text(csv_text)
    tg_rows = [r for r in lgd_rows if (r.get("State Code") or "").strip() == "36"]

    # Keep state, districts, ULBs, wards from base; drop sample mandals (TG-SD-*)
    kept = [t for t in base["territories"] if not str(t.get("key", "")).startswith("TG-SD-")]

    mandals = []
    skipped = 0
    unmapped: dict[str, int] = {}

    for row in tg_rows:
        district_name = row.get("District Name (In English)", "")
        parent_key = district_map.get(norm_name(district_name))
        if not parent_key:
            key = district_name.strip().upper() or "UNKNOWN"
            unmapped[key] = unmapped.get(key, 0) + 1
            skipped += 1
            continue

        sd_code = (row.get("Sub-District Code") or "").strip()
        sd_name = (row.get("Sub-District Name") or "").strip()
        if not sd_code or not sd_name:
            skipped += 1
            continue

        mandals.append(
            {
                "key": f"TG-LGD-{sd_code}",
                "level": 3,
                "name": sd_name,
                "code": sd_code,
                "parent": parent_key,
                "meta": {
                    "kind": "mandal",
                    "subdistrict_type": "Mandal",
                    "lgd_district_code": (row.get("District Code") or "").strip(),
                    "lgd_district_name": district_name,
                    "source": "LGD india-subdistricts-lgd.csv",
                },
            }
        )

    out = {
        "source": "LGD india-subdistricts-lgd.csv + vocal territory database.xlsx (ULBs/wards)",
        "state": base.get("state", "Telangana"),
        "levels": base.get("levels"),
        "territories": kept + mandals,
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    with OUT_JSON.open("w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")

    by_level = {1: 0, 2: 0, 3: 0, 4: 0}
    for t in out["territories"]:
        by_level[int(t["level"])] = by_level.get(int(t["level"]), 0) + 1

    print(f"\nWrote {OUT_JSON}")
    print(f"  total territories: {len(out['territories'])}")
    print(f"  level 1 (state): {by_level.get(1, 0)}")
    print(f"  level 2 (districts): {by_level.get(2, 0)}")
    print(f"  level 3 (mandals+ULBs): {by_level.get(3, 0)}  (+{len(mandals)} mandals from LGD)")
    print(f"  level 4 (wards): {by_level.get(4, 0)}")
    if skipped:
        print(f"  skipped rows: {skipped}")
    if unmapped:
        print("  unmapped districts:", ", ".join(f"{k}({v})" for k, v in sorted(unmapped.items())))

    print("\nNext — load into database:")
    print("  ORG_ID=<your-org-uuid> npm run seed:territories -- data/territories/telangana-full.json")
    print("  ORG_ID=<your-org-uuid> npm run audit:territories")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
