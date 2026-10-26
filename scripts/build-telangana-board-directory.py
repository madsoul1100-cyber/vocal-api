#!/usr/bin/env python3
"""Build a point-of-contact directory from published Telangana government pages.

Reads HTML already saved under a cache directory (default /tmp/tg-dir) and writes
JSON + CSV that match the Bharosa directory field map. This does not submit
complaints, log in, or pass OTP / CAPTCHA checks.
"""

from __future__ import annotations

import csv
import json
import re
from datetime import date
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path("/tmp/tg-dir")
OUT_DIR = ROOT / "data" / "directory"

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(
    r"(?:\+91[\s\-]?)?(?:"
    r"1800[\s\-]?\d{3}[\s\-]?\d{4}"
    r"|0\d{2,4}[\s\-]\d{5,8}"
    r"|[6-9]\d{9}"
    r"|\b(?:100|101|108|139|182|1091|1098|1912|155313)\b"
    r")"
)

DEPT_CATEGORIES = {
    "agriculture-and-co-operation": "agriculture",
    "animal-husbandry-and-fisheries": "animal husbandry",
    "archaeology": "culture",
    "backward-classes-welfare": "welfare",
    "cinematography": "culture",
    "consumer-affairs-food-civil-supplies": "civil supplies",
    "endowments": "endowments",
    "energy": "electricity",
    "environment-forests": "environment",
    "finance": "finance",
    "general-administration-political": "administration",
    "handlooms-textiles": "industries",
    "health-medical-family-welfare-science-technology": "health",
    "higher-education": "education",
    "home-department": "police",
    "housing": "housing",
    "industries-and-commerce": "industries",
    "information-and-public-relations": "information",
    "information-technology-electronics-and-communications": "information technology",
    "irrigation-and-cad": "irrigation",
    "labour-employment-training-and-factories": "labour",
    "law": "law",
    "legislative-affairs": "law",
    "mines-geology": "mines",
    "minorities-welfare": "welfare",
    "municipal-administration-urban-development": "municipal",
    "panchayat-raj-and-rural-development": "panchayat",
    "planning": "planning",
    "public-enterprises": "public enterprises",
    "revenue-commercial-taxes": "revenue",
    "revenue-prohibition-excise": "excise",
    "revenue-registration-and-stamps": "registration",
    "revenue": "revenue",
    "roads-and-buildings": "roads",
    "school-education-se-wing": "education",
    "social-welfare": "welfare",
    "sports-and-youth-services": "sports",
    "transport": "transport",
    "tribal-welfare": "welfare",
    "women-and-child-development": "women and child",
    "youth-advancement": "youth",
}

KEYWORD_CATEGORIES = [
    (r"electric|spdcl|npdcl|transco|genco|discom|vidyut", "electricity"),
    (r"water supply|sewer|hmwssb|drinking water", "water"),
    (r"municipal|ghmc", "municipal"),
    (r"sanitation|garbage", "sanitation"),
    (r"\btransport\b|\brtc\b", "transport"),
    (r"\broads?\b", "roads"),
    (r"pollution", "environment"),
    (r"\bforest", "environment"),
    (r"\bhealth\b|hospital", "health"),
    (r"\bschool\b|\beducation\b", "education"),
    (r"\bpolice\b", "police"),
    (r"\bfire\b", "fire"),
    (r"\bhousing\b", "housing"),
    (r"irrigation", "irrigation"),
    (r"civil supply|ration", "civil supplies"),
    (r"\brevenue\b", "revenue"),
    (r"registration", "registration"),
    (r"\blabour\b", "labour"),
    (r"industr", "industries"),
    (r"panchayat", "panchayat"),
]

PERSON_RE = re.compile(
    r"^(?:sri|smt|dr|prof|shri|kumari|ms|mr|sri\.|smt\.)\b|\b(?:ias|ips|ifs|irts)\b",
    re.I,
)


class TableGrabber(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[list[list[str]]] = []
        self.row: list[str] | None = None
        self.buf: list[str] = []
        self.capture = False
        self.colspan = 1
        self.tables: list[list[list[str]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        ad = {k: (v or "") for k, v in attrs}
        if tag == "table":
            self.stack.append([])
            self.row = None
            self.capture = False
        elif tag == "tr" and self.stack:
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.capture = True
            self.buf = []
            try:
                self.colspan = max(1, int(ad.get("colspan") or "1"))
            except ValueError:
                self.colspan = 1
        elif tag == "br" and self.capture:
            self.buf.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self.capture and self.row is not None:
            text = clean(" ".join("".join(self.buf).split()))
            self.row.append(text)
            if self.colspan > 1:
                self.row.append(f"__colspan__{self.colspan}")
            self.capture = False
        elif tag == "tr" and self.stack and self.row is not None:
            if any(c and not c.startswith("__colspan__") for c in self.row):
                self.stack[-1].append(self.row)
            self.row = None
        elif tag == "table" and self.stack:
            table = self.stack.pop()
            if table:
                self.tables.append(table)

    def handle_data(self, data: str) -> None:
        if self.capture:
            self.buf.append(data)


def clean(value: str) -> str:
    value = unescape(value).replace("\xa0", " ").replace("?", " ")
    value = value.replace("email id :-", " ").replace("email id:", " ").replace("email:", " ")
    value = re.sub(r"\s+", " ", value).strip(" -–—|,;/")
    return value


def emails_in(text: str) -> list[str]:
    found = []
    for raw in EMAIL_RE.findall(text):
        email = raw.strip(".").lower()
        if email.endswith((".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".js")):
            continue
        if email not in found:
            found.append(email)
    return found


def phones_in(text: str) -> list[str]:
    found = []
    for raw in PHONE_RE.findall(text):
        compact = re.sub(r"[^\d+]", "", raw)
        if len(compact) < 3:
            continue
        if compact not in found:
            found.append(compact if compact.startswith("+") or len(compact) <= 6 else compact)
    return found


def strip_contacts(text: str) -> str:
    text = EMAIL_RE.sub(" ", text)
    text = PHONE_RE.sub(" ", text)
    text = re.sub(r"\b(?:fax|phone|ph|tel|mob|mobile)\b[:\s]*", " ", text, flags=re.I)
    return clean(text)


def categories_for(department_slug: str, department: str, office: str) -> str:
    tags = []
    base = DEPT_CATEGORIES.get(department_slug)
    if base:
        tags.append(base)
    blob = f"{department} {office}"
    for pattern, tag in KEYWORD_CATEGORIES:
        if tag not in tags and re.search(pattern, blob, re.I):
            tags.append(tag)
    return ";".join(tags)


def escalation_for(designation: str, office: str) -> int:
    blob = f"{designation} {office}".lower()
    if any(k in blob for k in ("complaint", "customer service", "helpline", "help line", "grievance", "call centre", "call center", "control room")):
        return 1
    if any(k in blob for k in ("principal secretary", "prl. secretary", "prl secretary", "special chief", "spl. chief", "spl chief", "chief secretary")):
        return 3
    if any(k in blob for k in ("secretary to government", "secretary to govt", "cmd", "managing director", "commissioner", "chairman")):
        return 2
    return 2


def is_header_row(cells: list[str]) -> bool:
    plain = [c for c in cells if c and not c.startswith("__colspan__")]
    joined = " ".join(plain).lower()
    if "department" in joined and "email" in joined:
        return True
    if set(joined.split()) <= {"name", "designation", "office", "phone", "email", "s.no", "s.no.", "sl", "no"}:
        return True
    return False


def is_section(cells: list[str]) -> str | None:
    plain = [c for c in cells if c and not c.startswith("__colspan__")]
    colspan = any(c.startswith("__colspan__") for c in cells)
    if len(plain) == 1 and (colspan or len(plain[0]) > 8):
        label = strip_contacts(plain[0])
        if label and not emails_in(plain[0]) and not phones_in(plain[0]):
            return label
    return None


def plain_cells(cells: list[str]) -> list[str]:
    return [c for c in cells if c and not c.startswith("__colspan__")]


def header_map(cells: list[str]) -> dict[str, int] | None:
    plain = plain_cells(cells)
    labels = [c.lower() for c in plain]
    blob = " ".join(labels)
    if not any(token in blob for token in ("name", "designation", "email", "phone", "mobile")):
        return None
    mapping: dict[str, int] = {}
    for i, label in enumerate(labels):
        if "email" in label:
            mapping["email"] = i
        elif any(token in label for token in ("phone", "mobile", "contact")):
            mapping["phone"] = i
        elif "designation" in label or label in {"post", "role"}:
            mapping["designation"] = i
        elif "name" in label and "department" not in label:
            mapping["name"] = i
        elif any(token in label for token in ("department", "organization", "organisation", "office")):
            mapping["office"] = i
    return mapping or None


def split_name_designation(text_cells: list[str]) -> tuple[str, str]:
    people = [c for c in text_cells if PERSON_RE.search(c)]
    others = [c for c in text_cells if c not in people and not re.fullmatch(r"\d+", c)]
    if len(people) == 1:
        return people[0], others[0] if others else ""
    if len(text_cells) >= 2:
        return text_cells[1], text_cells[0]
    if text_cells:
        return text_cells[0], ""
    return "", ""


def record_from_cells(
    cells: list[str],
    *,
    department: str,
    department_slug: str,
    office: str,
    source_url: str,
    default_level: int,
    columns: dict[str, int] | None = None,
) -> dict | None:
    plain = plain_cells(cells)
    if len(plain) < 2:
        return None
    blob = " | ".join(plain)
    found_emails = emails_in(blob)
    found_phones = phones_in(blob)
    if not found_emails and not found_phones:
        return None

    if columns:
        def cell(key: str) -> str:
            idx = columns.get(key)
            return plain[idx] if idx is not None and idx < len(plain) else ""

        name = strip_contacts(cell("name"))
        designation = strip_contacts(cell("designation"))
        if not found_emails:
            found_emails = emails_in(cell("email"))
        if not found_phones:
            found_phones = phones_in(cell("phone"))
        office_cell = strip_contacts(cell("office"))
        if office_cell:
            office = office_cell
    else:
        text_cells = [strip_contacts(c) for c in plain]
        text_cells = [c for c in text_cells if c and not re.fullmatch(r"[\d\s\-+()/]+", c)]
        name, designation = split_name_designation(text_cells)

    if not name or name.lower() in {"email", "phone", "designation", "name", "si no", "s.no"}:
        return None
    if len(name) < 2 or len(name) > 160:
        return None

    # 4-column boards are designation | person. If the "name" is empty, use designation.
    if not name:
        return None

    return {
        "id": "",
        "name": name,
        "office": office or department,
        "designation": designation if designation and designation != name else "",
        "department": department,
        "email": found_emails[0] if found_emails else "",
        "phone": found_phones[0] if found_phones else "",
        "whatsapp": "",
        "jurisdiction_level": "state",
        "escalation_level": default_level if default_level == 1 else escalation_for(designation, office),
        "territory": "Telangana",
        "territory_code": "36",
        "categories": categories_for(department_slug, department, office),
        "source_url": source_url,
        "emails_extra": ";".join(found_emails[1:]),
        "phones_extra": ";".join(found_phones[1:]),
    }


def strip_fully_hidden(html: str) -> str:
    """Drop Elementor blocks hidden on every viewport. Several department pages
    keep another department's contact table in one of these unused blocks."""
    pattern = re.compile(
        r"<div\b[^>]*class=\"[^\"]*elementor-hidden-desktop[^\"]*elementor-hidden-tablet[^\"]*elementor-hidden-mobile[^\"]*\"[^>]*>",
        re.I,
    )
    pieces: list[str] = []
    cursor = 0
    for match in pattern.finditer(html):
        start = match.start()
        if start < cursor:
            continue
        depth = 0
        i = start
        end = None
        while i < len(html):
            nxt_open = html.find("<div", i)
            nxt_close = html.find("</div>", i)
            if nxt_close < 0:
                break
            if nxt_open != -1 and nxt_open < nxt_close:
                depth += 1
                i = nxt_open + 4
            else:
                depth -= 1
                i = nxt_close + 6
                if depth == 0:
                    end = i
                    break
        if end is None:
            continue
        pieces.append(html[cursor:start])
        cursor = end
    pieces.append(html[cursor:])
    return "".join(pieces)


def parse_tables(html: str) -> list[list[list[str]]]:
    parser = TableGrabber()
    parser.feed(strip_fully_hidden(html))
    return parser.tables


def dept_names() -> dict[str, str]:
    html = (CACHE / "secretariat.html").read_text(errors="ignore")
    found = re.findall(
        r'href="https://www\.telangana\.gov\.in/departments/([a-z0-9\-]+)/">([^<]+)',
        html,
    )
    return {slug: unescape(name).strip() for slug, name in found}


def rows_to_records(
    tables: list[list[list[str]]],
    *,
    department: str,
    department_slug: str,
    source_url: str,
    default_level: int = 2,
    fixed_office: str | None = None,
) -> list[dict]:
    out = []
    for table in tables:
        office = fixed_office or department
        columns = header_map(table[0]) if table else None
        for cells in table:
            if is_header_row(cells):
                continue
            section = is_section(cells)
            if section and not fixed_office:
                office = section
                continue
            rec = record_from_cells(
                cells,
                department=department,
                department_slug=department_slug,
                office=office,
                source_url=source_url,
                default_level=default_level,
                columns=None if section else columns,
            )
            if rec:
                out.append(rec)
    return out


def secretariat_records() -> list[dict]:
    html = (CACHE / "secretariat.html").read_text(errors="ignore")
    records = []
    for table in parse_tables(html):
        header = [c.lower() for c in table[0] if not c.startswith("__colspan__")]
        if "department" not in " ".join(header) or "email" not in " ".join(header):
            continue
        for cells in table[1:]:
            plain = [c for c in cells if not c.startswith("__colspan__")]
            if len(plain) < 5:
                continue
            department, name, designation, phone, email = plain[:5]
            found_emails = emails_in(email) or emails_in(" ".join(plain))
            found_phones = phones_in(phone)
            name = strip_contacts(name)
            if not name or not (found_emails or found_phones):
                continue
            records.append(
                {
                    "id": "",
                    "name": name,
                    "office": "Telangana Secretariat",
                    "designation": strip_contacts(designation),
                    "department": strip_contacts(department),
                    "email": found_emails[0] if found_emails else "",
                    "phone": found_phones[0] if found_phones else "",
                    "whatsapp": "",
                    "jurisdiction_level": "state",
                    "escalation_level": 3,
                    "territory": "Telangana",
                    "territory_code": "36",
                    "categories": categories_for("", department, department),
                    "source_url": "https://www.telangana.gov.in/contacts/secretariat/",
                    "emails_extra": ";".join(found_emails[1:]),
                    "phones_extra": ";".join(found_phones[1:]),
                }
            )
    return records


def utility_records() -> list[dict]:
    html = (CACHE / "public-utility.html").read_text(errors="ignore")
    parts = re.split(r'<span class="ekit-accordion-title">', html)
    records = []
    for part in parts[1:]:
        title = clean(re.sub(r"<[^>]+>", " ", part.split("</span>", 1)[0]))
        title = unescape(title).replace("&amp;", "&")
        chunk = part.split("</span>", 1)[-1]
        records.extend(
            rows_to_records(
                parse_tables(chunk),
                department="Public Utilities",
                department_slug="",
                source_url="https://www.telangana.gov.in/contacts/public-utility-contacts/",
                default_level=1,
                fixed_office=title,
            )
        )
    return records


def hod_list_records(html: str, *, department: str, department_slug: str, source_url: str) -> list[dict]:
    records = []
    html = strip_fully_hidden(html)
    for block in re.findall(r"<ul>(.*?)</ul>", html, flags=re.S | re.I):
        if "email" not in block.lower():
            continue
        fields: dict[str, str] = {}
        for li in re.findall(r"<li[^>]*>(.*?)</li>", block, flags=re.S | re.I):
            text = clean(re.sub(r"<[^>]+>", " ", li))
            if ":" not in text:
                continue
            key, value = text.split(":", 1)
            fields[key.strip().lower()] = value.strip()
        email = emails_in(fields.get("email id", "") or fields.get("email", ""))
        phone = phones_in(fields.get("contact no", "") or fields.get("phone", "") or fields.get("mobile", ""))
        name = strip_contacts(fields.get("name", ""))
        if not name or not (email or phone):
            continue
        records.append(
            {
                "id": "",
                "name": name,
                "office": department,
                "designation": strip_contacts(fields.get("designation", "")),
                "department": department,
                "email": email[0] if email else "",
                "phone": phone[0] if phone else "",
                "whatsapp": "",
                "jurisdiction_level": "state",
                "escalation_level": 2,
                "territory": "Telangana",
                "territory_code": "36",
                "categories": categories_for(department_slug, department, department),
                "source_url": source_url,
                "emails_extra": "",
                "phones_extra": "",
            }
        )
    return records


def department_records(names: dict[str, str]) -> list[dict]:
    records = []
    dept_dir = CACHE / "depts"
    for path in sorted(dept_dir.glob("*.html")):
        slug = path.stem
        department = names.get(slug, slug.replace("-", " ").title())
        html = path.read_text(errors="ignore")
        source_url = f"https://www.telangana.gov.in/departments/{slug}/"
        records.extend(
            rows_to_records(
                parse_tables(html),
                department=department,
                department_slug=slug,
                source_url=source_url,
            )
        )
        records.extend(hod_list_records(html, department=department, department_slug=slug, source_url=source_url))
    return records


def assign_ids(records: list[dict]) -> list[dict]:
    best: dict[str, dict] = {}
    for rec in records:
        key = "|".join([rec["name"].lower(), rec["office"].lower(), rec["phone"] or rec["email"]])
        current = best.get(key)
        if current is None or (rec["email"] and not current["email"]):
            best[key] = rec
    kept = []
    seen_ids: set[str] = set()
    for rec in best.values():
        slug = re.sub(
            r"[^a-z0-9]+",
            "-",
            f"{rec['office']}-{rec['designation'] or rec['name']}-{rec['email'] or rec['phone']}".lower(),
        ).strip("-")
        rec["id"] = slug[:180]
        if rec["id"] in seen_ids:
            rec["id"] = f"{rec['id']}-{len(seen_ids)}"
        seen_ids.add(rec["id"])
        kept.append(rec)
    kept.sort(key=lambda r: (r["department"].lower(), r["office"].lower(), r["name"].lower()))
    return kept


def main() -> None:
    names = dept_names()
    records = assign_ids(secretariat_records() + department_records(names) + utility_records())
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": {
            "name": "Telangana public-sector board directory",
            "fetched_at": date.today().isoformat(),
            "territory": "Telangana",
            "territory_code": "36",
            "pages": [
                "https://www.telangana.gov.in/contacts/secretariat/",
                "https://www.telangana.gov.in/contacts/public-utility-contacts/",
                "https://www.telangana.gov.in/departments/",
            ],
            "notes": (
                "Published office contacts for routing a citizen complaint by email or phone "
                "after a person approves the message. Open-data files on data.telangana.gov.in "
                "are historical statistics and are not included. This file does not submit "
                "forms on TGSPDCL, CPGRAMS, or any other portal."
            ),
        },
        "field_map": {
            "records_path": "records",
            "external_ref": "id",
            "contact_name": "name",
            "organization_name": "office",
            "role_designation": "designation",
            "department": "department",
            "email": "email",
            "phone": "phone",
            "whatsapp": "whatsapp",
            "jurisdiction_level": "jurisdiction_level",
            "escalation_level": "escalation_level",
            "territory_name": "territory",
            "territory_code": "territory_code",
            "categories": "categories",
        },
        "records": records,
    }
    json_path = OUT_DIR / "telangana-public-boards.json"
    csv_path = OUT_DIR / "telangana-public-boards.csv"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    columns = [
        "id", "name", "office", "designation", "department", "email", "phone",
        "whatsapp", "jurisdiction_level", "escalation_level", "territory",
        "territory_code", "categories", "source_url",
    ]
    with csv_path.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)
    with_email = sum(1 for r in records if r["email"])
    print(f"records={len(records)} with_email={with_email} json={json_path}")


if __name__ == "__main__":
    main()
