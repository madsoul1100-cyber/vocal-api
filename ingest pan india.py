"""
================================================================================
VOCAL — Pan-India Territory Database Ingestion
================================================================================

Loads the complete India civic + political administrative hierarchy into
the schema defined in vocal_territory_database.xlsx.

Sources (in order of authority):
  1. LGD (lgdirectory.gov.in)  — official GoI master, mirrored daily by ramSeraph
  2. India Post                — PIN codes with lat/long (data.gov.in)
  3. ECI                       — Parliamentary + Assembly constituencies
  4. Datameet                  — AC shapefiles for spatial junction
  5. Nominatim/OSM             — fill missing village lat/long

Output: SQLite file (vocal_territory.db) — easily imported into Postgres/Supabase.

Usage:
    python ingest_pan_india.py --phase 1   # LGD load
    python ingest_pan_india.py --phase 2   # PIN codes
    python ingest_pan_india.py --phase 3   # PIN ↔ village fuzzy mapping
    python ingest_pan_india.py --phase 4   # AC ↔ mandal spatial junction
    python ingest_pan_india.py --phase 5   # Geocode missing villages
    python ingest_pan_india.py --all       # Everything in sequence

Requirements:
    pip install pandas sqlalchemy requests py7zr rapidfuzz geopandas shapely tqdm
================================================================================
"""

import argparse
import os
import sys
import time
import subprocess
from pathlib import Path

import pandas as pd
import requests
from sqlalchemy import create_engine, text
from tqdm import tqdm

# -------------------------------------------------------------------
# CONFIG
# -------------------------------------------------------------------
DATA_DIR = Path("./vocal_data")
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = "./vocal_territory.db"
engine = create_engine(f"sqlite:///{DB_PATH}")

LGD_ARCHIVE_INDEX = "https://ramseraph.github.io/opendata/lgd/archives/"
PINCODE_CSV_URL = "https://www.data.gov.in/files/ogdpv2dms/s3fs-public/dataurl03122020/pincode.csv"
DATAMEET_AC_REPO = "https://github.com/datameet/maps"

# India bounding box for lat/long sanity
INDIA_BBOX = (8.0, 37.0, 68.0, 98.0)  # min_lat, max_lat, min_lng, max_lng


# -------------------------------------------------------------------
# UTILITIES
# -------------------------------------------------------------------
def download(url: str, dest: Path, chunk: int = 8192):
    """Stream-download a file with progress bar."""
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  ✓ {dest.name} already downloaded ({dest.stat().st_size / 1e6:.1f} MB)")
        return
    print(f"  → Downloading {url}")
    r = requests.get(url, stream=True, timeout=120)
    r.raise_for_status()
    total = int(r.headers.get("content-length", 0))
    with open(dest, "wb") as f, tqdm(total=total, unit="B", unit_scale=True) as pbar:
        for c in r.iter_content(chunk):
            f.write(c)
            pbar.update(len(c))


def in_india(lat, lng) -> bool:
    try:
        return INDIA_BBOX[0] <= float(lat) <= INDIA_BBOX[1] and INDIA_BBOX[2] <= float(lng) <= INDIA_BBOX[3]
    except (TypeError, ValueError):
        return False


# -------------------------------------------------------------------
# PHASE 1 — LGD master load
# -------------------------------------------------------------------
def phase_1_lgd():
    """
    Download and load the full LGD CSV dump.
    Produces tables: states, districts, sub_districts, blocks, villages,
                     urban_local_bodies, wards, gram_panchayats,
                     parliamentary_constituencies, assembly_constituencies
    """
    print("\n" + "=" * 70)
    print("PHASE 1: LGD master load")
    print("=" * 70)

    # The ramSeraph mirror publishes daily archives. We need the latest one.
    # Manual step: visit https://ramseraph.github.io/opendata/lgd/archives/
    # and copy the most recent .7z filename. Or scrape the archive index.
    print("\nStep 1.1: Locate latest LGD archive")
    print(f"  → Visit {LGD_ARCHIVE_INDEX}")
    print(f"  → Copy the latest archive URL and set LGD_ARCHIVE_URL below.")

    LGD_ARCHIVE_URL = os.environ.get("LGD_ARCHIVE_URL", "")
    if not LGD_ARCHIVE_URL:
        print("\n  ✗ LGD_ARCHIVE_URL env var not set. Example:")
        print("    export LGD_ARCHIVE_URL='https://ramseraph.github.io/opendata/lgd/archives/2025-XX-XX.7z'")
        print("  Then re-run.")
        return

    archive_path = DATA_DIR / "lgd_latest.7z"
    download(LGD_ARCHIVE_URL, archive_path)

    # Extract using py7zr (ramSeraph notes standard unzip doesn't work)
    print("\nStep 1.2: Extracting archive (this takes ~5 min)")
    import py7zr
    extract_dir = DATA_DIR / "lgd_extracted"
    extract_dir.mkdir(exist_ok=True)
    with py7zr.SevenZipFile(archive_path, mode="r") as z:
        z.extractall(path=extract_dir)
    print(f"  ✓ Extracted to {extract_dir}")

    # Load each CSV into SQLite
    print("\nStep 1.3: Loading CSVs into SQLite")
    file_to_table = {
        "states.csv":                          "states",
        "districts.csv":                       "districts",
        "sub_districts.csv":                   "sub_districts",
        "blocks.csv":                          "blocks",
        "villages.csv":                        "villages",
        "urban_local_bodies.csv":              "urban_local_bodies",
        "wards.csv":                           "wards",
        "gram_panchayats.csv":                 "gram_panchayats",
        "parliamentary_constituencies.csv":    "parliamentary_constituencies",
        "assembly_constituencies.csv":         "assembly_constituencies",
    }

    for filename, tablename in file_to_table.items():
        csv_path = next(extract_dir.rglob(filename), None)
        if not csv_path:
            print(f"  ✗ {filename} not found in archive — skipping")
            continue
        print(f"  → Loading {filename} ...", end=" ", flush=True)
        # Read in chunks for memory safety on the 640K-row villages.csv
        first = True
        total = 0
        for chunk in pd.read_csv(csv_path, chunksize=50000, low_memory=False, encoding="utf-8"):
            chunk.columns = [c.strip().lower().replace(" ", "_") for c in chunk.columns]
            chunk.to_sql(tablename, engine, if_exists="replace" if first else "append", index=False)
            first = False
            total += len(chunk)
        print(f"{total:,} rows")

    # Build indexes for fast joins
    print("\nStep 1.4: Building indexes")
    with engine.begin() as conn:
        index_specs = [
            ("idx_districts_state",     "districts",     "state_code"),
            ("idx_subdistricts_district","sub_districts","district_code"),
            ("idx_villages_subdistrict","villages",     "subdistrict_code"),
            ("idx_villages_state",      "villages",     "state_code"),
            ("idx_ulb_district",        "urban_local_bodies", "district_code"),
            ("idx_wards_ulb",           "wards",        "ulb_code"),
            ("idx_ac_state",            "assembly_constituencies", "state_code"),
            ("idx_pc_state",            "parliamentary_constituencies", "state_code"),
        ]
        for name, table, col in index_specs:
            try:
                conn.execute(text(f"CREATE INDEX IF NOT EXISTS {name} ON {table}({col})"))
                print(f"  ✓ {name}")
            except Exception as e:
                print(f"  ✗ {name}: {e}")

    print("\n✓ Phase 1 complete. Tables loaded.")


# -------------------------------------------------------------------
# PHASE 2 — India Post PIN code master
# -------------------------------------------------------------------
def phase_2_pincodes():
    print("\n" + "=" * 70)
    print("PHASE 2: PIN codes")
    print("=" * 70)

    pin_path = DATA_DIR / "pincode_master.csv"
    download(PINCODE_CSV_URL, pin_path)

    print("\nStep 2.1: Loading PIN codes")
    df = pd.read_csv(pin_path, encoding="utf-8", low_memory=False)
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
    print(f"  → {len(df):,} post-office rows")

    # Lat/long sanity filter
    df["lat_ok"] = df.apply(lambda r: in_india(r.get("latitude"), r.get("longitude")), axis=1)
    bad = (~df["lat_ok"]).sum()
    print(f"  → {bad:,} rows have out-of-India lat/long — flagged but kept")

    df.to_sql("pincodes", engine, if_exists="replace", index=False)

    with engine.begin() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pin_code ON pincodes(pincode)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pin_district ON pincodes(district)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pin_state ON pincodes(statename)"))

    print("✓ Phase 2 complete.")


# -------------------------------------------------------------------
# PHASE 3 — PIN ↔ Village fuzzy mapping
# -------------------------------------------------------------------
def phase_3_pin_village_map():
    print("\n" + "=" * 70)
    print("PHASE 3: PIN ↔ Village fuzzy mapping")
    print("=" * 70)
    from rapidfuzz import process, fuzz

    print("\nStep 3.1: Reading pincodes and villages from DB")
    pins = pd.read_sql("SELECT pincode, officename, district, statename, latitude, longitude FROM pincodes", engine)
    villages = pd.read_sql("SELECT village_code, village_name, district_code, district_name, state_code FROM villages", engine)
    print(f"  → {len(pins):,} PINs, {len(villages):,} villages")

    # Match within same district only (correct + much faster)
    print("\nStep 3.2: Building district-scoped fuzzy matches")
    mappings = []
    pins["officename_clean"] = pins["officename"].fillna("").str.upper().str.replace(r"\s+(B\.O|S\.O|H\.O)$", "", regex=True).str.strip()
    villages["village_name_clean"] = villages["village_name"].fillna("").str.upper().str.strip()

    grouped_villages = villages.groupby("district_name")
    for district, pin_group in tqdm(pins.groupby("district"), desc="Districts"):
        district_upper = str(district).upper()
        match_keys = [k for k in grouped_villages.groups.keys() if str(k).upper() == district_upper]
        if not match_keys:
            continue
        village_subset = grouped_villages.get_group(match_keys[0])
        village_names = village_subset["village_name_clean"].tolist()
        village_ids = village_subset["village_code"].tolist()
        for _, pin_row in pin_group.iterrows():
            office = pin_row["officename_clean"]
            if not office:
                continue
            best = process.extractOne(office, village_names, scorer=fuzz.ratio, score_cutoff=85)
            if best:
                _, score, idx = best
                mappings.append({
                    "pincode": pin_row["pincode"],
                    "officename": pin_row["officename"],
                    "village_code": village_ids[idx],
                    "village_name": village_names[idx],
                    "match_score": score,
                })

    map_df = pd.DataFrame(mappings)
    print(f"\n  → {len(map_df):,} high-confidence (≥85) PIN ↔ village mappings")
    map_df.to_sql("pin_village_map", engine, if_exists="replace", index=False)

    with engine.begin() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pvm_pin ON pin_village_map(pincode)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pvm_village ON pin_village_map(village_code)"))

    print("✓ Phase 3 complete. Review low-score rows in vocal admin panel.")


# -------------------------------------------------------------------
# PHASE 4 — AC ↔ Mandal spatial junction
# -------------------------------------------------------------------
def phase_4_ac_mandal_junction():
    print("\n" + "=" * 70)
    print("PHASE 4: AC ↔ Mandal spatial junction")
    print("=" * 70)

    try:
        import geopandas as gpd
    except ImportError:
        print("  ✗ geopandas not installed. Run: pip install geopandas shapely")
        return

    print("\nStep 4.1: Clone Datameet maps repo (if not already)")
    repo_dir = DATA_DIR / "datameet_maps"
    if not repo_dir.exists():
        subprocess.run(["git", "clone", "--depth", "1", DATAMEET_AC_REPO, str(repo_dir)], check=True)

    print("\nStep 4.2: Locate AC + sub-district shapefiles")
    ac_shp = next(repo_dir.rglob("*assembly*.shp"), None)
    sub_shp = next(repo_dir.rglob("*sub*district*.shp"), None) or next(repo_dir.rglob("*subdistrict*.shp"), None)
    if not (ac_shp and sub_shp):
        print(f"  ✗ Couldn't find shapefiles in {repo_dir}. Check repo structure manually.")
        return

    print(f"  ✓ AC shapefile: {ac_shp}")
    print(f"  ✓ Sub-district shapefile: {sub_shp}")

    print("\nStep 4.3: Computing intersections (this takes ~30 min)")
    ac_gdf = gpd.read_file(ac_shp).to_crs(epsg=7755)  # India equal-area projection
    sub_gdf = gpd.read_file(sub_shp).to_crs(epsg=7755)
    sub_gdf["sub_area"] = sub_gdf.geometry.area

    overlay = gpd.overlay(ac_gdf, sub_gdf, how="intersection")
    overlay["intersect_area"] = overlay.geometry.area
    # Recover original sub_area for ratio
    overlay = overlay.merge(sub_gdf[["geometry", "sub_area"]].drop(columns="geometry"), left_index=True, right_index=True, how="left")
    overlay["coverage_pct"] = (overlay["intersect_area"] / overlay["sub_area"]) * 100

    junction = overlay[overlay["coverage_pct"] > 1.0].drop(columns="geometry")
    print(f"  → {len(junction):,} AC ↔ Mandal mappings (coverage > 1%)")
    junction.to_sql("ac_subdistrict_map", engine, if_exists="replace", index=False)

    print("✓ Phase 4 complete.")


# -------------------------------------------------------------------
# PHASE 5 — Geocode missing villages
# -------------------------------------------------------------------
def phase_5_geocode_villages(batch_size: int = 1000, use_google: bool = False):
    print("\n" + "=" * 70)
    print("PHASE 5: Geocode missing villages")
    print("=" * 70)
    print("\n⚠ WARNING: 640K villages × 1 req/sec on Nominatim = ~7 days.")
    print("  Options:")
    print("   a) Run a local Nominatim Docker instance (fastest, free)")
    print("   b) Use Google Geocoding API (~$3,200 for full India)")
    print("   c) Skip — most LGD villages already have lat/long")

    # Check how many are actually missing
    missing = pd.read_sql(
        "SELECT COUNT(*) AS n FROM villages WHERE latitude IS NULL OR longitude IS NULL OR latitude = ''",
        engine,
    )
    n_missing = int(missing.iloc[0]["n"])
    print(f"\n  → {n_missing:,} villages missing lat/long")

    if n_missing == 0:
        print("  ✓ All villages already geocoded by LGD. Nothing to do.")
        return

    print("\n(Implementation skeleton — uncomment and configure provider before running)")
    # Sample Nominatim caller below
    #
    # missing_df = pd.read_sql("SELECT village_code, village_name, subdistrict_name, district_name FROM villages WHERE latitude IS NULL LIMIT 1000", engine)
    # for _, row in tqdm(missing_df.iterrows(), total=len(missing_df)):
    #     q = f"{row['village_name']}, {row['subdistrict_name']}, {row['district_name']}, India"
    #     r = requests.get(
    #         "https://nominatim.openstreetmap.org/search",
    #         params={"q": q, "format": "json", "limit": 1, "countrycodes": "in"},
    #         headers={"User-Agent": "Vocal-Civic-App/1.0 (contact@example.com)"},
    #     )
    #     time.sleep(1.1)  # Rate limit
    #     hits = r.json()
    #     if hits:
    #         with engine.begin() as conn:
    #             conn.execute(text("UPDATE villages SET latitude=:lat, longitude=:lng WHERE village_code=:vc"),
    #                          {"lat": hits[0]["lat"], "lng": hits[0]["lon"], "vc": row["village_code"]})


# -------------------------------------------------------------------
# VALIDATION
# -------------------------------------------------------------------
def validate():
    print("\n" + "=" * 70)
    print("VALIDATION")
    print("=" * 70)
    checks = [
        ("States loaded",        "SELECT COUNT(*) FROM states",                          36),
        ("Districts loaded",     "SELECT COUNT(*) FROM districts",                       700),  # ≥
        ("Sub-districts loaded", "SELECT COUNT(*) FROM sub_districts",                   6000),
        ("Villages loaded",      "SELECT COUNT(*) FROM villages",                        600000),
        ("PCs loaded",           "SELECT COUNT(*) FROM parliamentary_constituencies",    543),
        ("ACs loaded",           "SELECT COUNT(*) FROM assembly_constituencies",         4000),
        ("PIN codes loaded",     "SELECT COUNT(*) FROM pincodes",                        150000),
        ("Orphan villages",      "SELECT COUNT(*) FROM villages v LEFT JOIN sub_districts s ON v.subdistrict_code = s.subdistrict_code WHERE s.subdistrict_code IS NULL", 0),
    ]
    for label, query, expected_min in checks:
        try:
            n = pd.read_sql(query, engine).iloc[0, 0]
            status = "✓" if (n >= expected_min if label != "Orphan villages" else n == 0) else "✗"
            print(f"  {status} {label}: {n:,}  (expected ≥{expected_min:,})")
        except Exception as e:
            print(f"  ? {label}: {e}")


# -------------------------------------------------------------------
# MAIN
# -------------------------------------------------------------------
if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", type=int, help="Run a single phase (1-5)")
    ap.add_argument("--all", action="store_true", help="Run all phases")
    ap.add_argument("--validate", action="store_true", help="Run validation only")
    args = ap.parse_args()

    if args.validate:
        validate()
    elif args.all:
        phase_1_lgd()
        phase_2_pincodes()
        phase_3_pin_village_map()
        phase_4_ac_mandal_junction()
        phase_5_geocode_villages()
        validate()
    elif args.phase == 1: phase_1_lgd()
    elif args.phase == 2: phase_2_pincodes()
    elif args.phase == 3: phase_3_pin_village_map()
    elif args.phase == 4: phase_4_ac_mandal_junction()
    elif args.phase == 5: phase_5_geocode_villages()
    else:
        ap.print_help()
