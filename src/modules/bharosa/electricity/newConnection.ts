/**
 * New electricity connection estimate helpers.
 *
 * Pole GIS and official connection charges require utility-approved data.
 * Until that data is loaded (`ELECTRICITY_POLE_DATA_ENABLED=1` + sample set),
 * Feature 2 runs in limited form: intake + process guidance, no invented poles/costs.
 *
 * Sample materials bands below are illustrative engineering checklists for domestic
 * loads only — quantities are labelled as estimates and disabled unless the env flag
 * and an in-area pole hit are both present.
 */

import type { GuideLang } from '../guide/playbooks.js'
import type {
  ConnectionCostEstimate,
  ConnectionKind,
  GeoPoint,
  MaterialLine,
  PoleResult,
} from './types.js'

/** Rough Telangana bounding box — outside this we refuse estimates. */
const TG_BOUNDS = { minLat: 15.8, maxLat: 19.95, minLng: 77.2, maxLng: 81.8 }

/**
 * Tiny demo pole set for local testing only (Hyderabad-ish). Not official network data.
 * Enabled only when ELECTRICITY_POLE_DATA_ENABLED=1.
 */
const DEMO_POLES: Array<{ id: string; lat: number; lng: number }> = [
  { id: 'DEMO-HYD-P12', lat: 17.4435, lng: 78.391 },
  { id: 'DEMO-HYD-P18', lat: 17.4482, lng: 78.3825 },
  { id: 'DEMO-HYD-P21', lat: 17.435, lng: 78.4 },
]

export function poleDataEnabled(): boolean {
  return process.env.ELECTRICITY_POLE_DATA_ENABLED === '1'
}

export function costTablesEnabled(): boolean {
  return process.env.ELECTRICITY_CONNECTION_COST_ENABLED === '1'
}

export function isInsideTelangana(point: GeoPoint): boolean {
  return (
    point.lat >= TG_BOUNDS.minLat &&
    point.lat <= TG_BOUNDS.maxLat &&
    point.lng >= TG_BOUNDS.minLng &&
    point.lng <= TG_BOUNDS.maxLng
  )
}

function haversineM(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function findNearestPole(point: GeoPoint): PoleResult {
  if (!poleDataEnabled()) {
    return {
      available: false,
      note: 'Pole and network location data is not loaded from an approved utility source yet.',
    }
  }
  if (!isInsideTelangana(point)) {
    return {
      available: false,
      note: 'This location looks outside the area I cover.',
    }
  }
  let best: { id: string; d: number } | null = null
  for (const pole of DEMO_POLES) {
    const d = haversineM(point, pole)
    if (!best || d < best.d) best = { id: pole.id, d }
  }
  if (!best || best.d > 2500) {
    return {
      available: false,
      note: 'I do not have pole data for this place yet.',
    }
  }
  return {
    available: true,
    pole_id: best.id,
    distance_m: Math.round(best.d),
    note: 'Nearest pole from limited demo network data — not an official utility map. Confirm on site with the discom.',
  }
}

/** Suggest load (kW) from a plain appliance list — never silently pick without telling the user. */
export function suggestLoadFromAppliances(text: string): { kw: number; explanation: string } | null {
  const t = text.toLowerCase()
  let watts = 0
  const bits: string[] = []
  const add = (label: string, w: number, re: RegExp) => {
    if (re.test(t)) {
      watts += w
      bits.push(`${label} ~${w} W`)
    }
  }
  add('fan', 75, /\bfans?\b|పంఖా|पंखा/i)
  add('tube/LED lights', 40, /\blights?\b|bulb|led|దీపం|लाइट/i)
  add('TV', 120, /\btv\b|television|టీవీ|टीवी/i)
  add('fridge', 200, /fridge|ఫ్రిజ్|फ्रिज/i)
  add('mixer', 500, /mixer|మిక్సీ|मिक्सर/i)
  add('AC 1 ton', 1500, /\bac\b|air\s*condition|ఏసీ|एसी/i)
  add('geyser', 2000, /geyser|గీజర్|गीजर|water\s*heater/i)
  add('motor/pump', 750, /motor|pump|మోటార్|मोटर|पंप/i)
  if (!bits.length) return null
  const kw = Math.max(1, Math.ceil(watts / 1000))
  return {
    kw,
    explanation: `Based on what you listed (${bits.join(', ')}), a common starting load is about ${kw} kW. You can change this number.`,
  }
}

export function parseLoadKw(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:kw|k\.?w\.?|కి\.?\s*వా|किलोवाट)/i)
  if (m) {
    const n = Number(m[1])
    return Number.isFinite(n) && n > 0 && n <= 50 ? n : null
  }
  const bare = text.match(/^\s*(\d+(?:\.\d+)?)\s*$/)
  if (bare) {
    const n = Number(bare[1])
    return Number.isFinite(n) && n > 0 && n <= 50 ? n : null
  }
  return null
}

export function parseConnectionType(text: string): ConnectionKind | null {
  if (/farm|agriculture|వ్యవసాయ|खेत|कृषि/i.test(text)) return 'farm'
  if (/shop|commercial|store|దుకాణ|दुकान|व्यापार/i.test(text)) return 'shop'
  if (/home|house|domestic|residential|ఇల్లు|ఇంటి|घर|घरेलू/i.test(text)) return 'home'
  return null
}

export function parseLocationFromText(text: string): { point: GeoPoint | null; label: string | null } {
  const coord = text.match(
    /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/,
  )
  if (coord) {
    const lat = Number(coord[1])
    const lng = Number(coord[2])
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { point: { lat, lng, label: text.slice(0, 120) }, label: text.slice(0, 120) }
    }
  }
  const place = text
    .replace(/^my location:\s*/i, '')
    .replace(/\([^)]*\)\s*$/, '')
    .trim()
  return { point: null, label: place ? place.slice(0, 120) : null }
}

/**
 * Materials checklist for a domestic sample — only returned when pole+cost flags allow.
 * Reviewed as an engineering *example* for ~1–3 kW home service; not an official quote.
 */
export function materialsForConnection(args: {
  kind: ConnectionKind
  loadKw: number
  distanceM: number | null
}): MaterialLine[] | null {
  if (!costTablesEnabled()) return null
  if (args.kind !== 'home') return null
  const cableM = args.distanceM != null ? Math.max(15, Math.ceil(args.distanceM * 1.15)) : null
  return [
    { item: 'Service cable (estimate)', quantity: cableM != null ? `${cableM} m` : 'As per site survey', note: 'Estimate only' },
    { item: 'Energy meter', quantity: '1', note: 'Discom-supplied in many cases' },
    { item: 'MCB / cut-out', quantity: '1 set' },
    { item: 'Earthing', quantity: '1', note: 'As per site' },
    {
      item: 'Pole / stay (if needed)',
      quantity: args.distanceM != null && args.distanceM > 40 ? 'May be required' : 'Usually not for short spans',
    },
  ]
}

/**
 * Demo cost bands for domestic only when explicitly enabled.
 * Source: placeholder ranges for product testing — NOT official TGSPDCL/TGNPDCL charges.
 * Official amounts come after inspection.
 */
export function estimateConnectionCost(args: {
  kind: ConnectionKind
  loadKw: number
  distanceM: number | null
}): ConnectionCostEstimate | null {
  if (!costTablesEnabled()) return null
  if (args.kind !== 'home') return null
  if (args.loadKw <= 0 || args.loadKw > 10) return null

  const span = args.distanceM ?? 30
  const materialsLow = 8000 + Math.round(span * 40) + Math.round(args.loadKw * 500)
  const materialsHigh = Math.round(materialsLow * 1.45)
  const chargesLow = 1500 + Math.round(args.loadKw * 300)
  const chargesHigh = Math.round(chargesLow * 1.6)

  return {
    materials_work_low_inr: materialsLow,
    materials_work_high_inr: materialsHigh,
    applicant_charges_low_inr: chargesLow,
    applicant_charges_high_inr: chargesHigh,
    labelled: true,
    source_note:
      'Illustrative demo ranges for product testing (ELECTRICITY_CONNECTION_COST_ENABLED). Not an official quote. The electricity office gives the official amount after inspection.',
  }
}

export function nextStepsCopy(lang: GuideLang): string {
  if (lang === 'te') {
    return [
      'తర్వాతి అడుగులు:',
      '1. TGSPDCL (దక్షిణం / హైదరాబాద్): https://tgsouthernpower.org లేదా MeeSeva ద్వారా కొత్త కనెక్షన్ దరఖాస్తు.',
      '2. TGNPDCL (ఉత్తర జిల్లాలు): https://tgnpdcl.com',
      '3. MeeSeva: https://meeseva.telangana.gov.in',
      '4. సందేహాలకు 1912. భరోసా ఏ ఆఫీసుకూ దరఖాస్తు పంపదు — సమాచారం మాత్రమే.',
    ].join('\n')
  }
  if (lang === 'hi') {
    return [
      'अगले कदम:',
      '1. TGSPDCL (दक्षिण / हैदराबाद): https://tgsouthernpower.org या मीसेवा से नया कनेक्शन।',
      '2. TGNPDCL (उत्तरी जिले): https://tgnpdcl.com',
      '3. मीसेवा: https://meeseva.telangana.gov.in',
      '4. सहायता के लिए 1912। भरोसा किसी दफ़्तर में आवेदन नहीं भेजता — केवल जानकारी देता है।',
    ].join('\n')
  }
  return [
    'What to do next:',
    '1. TGSPDCL (south / Hyderabad): apply for a new connection on https://tgsouthernpower.org or through MeeSeva.',
    '2. TGNPDCL (northern districts): https://tgnpdcl.com',
    '3. MeeSeva: https://meeseva.telangana.gov.in',
    '4. For help, call 1912. Bharosa submits nothing to any office — it only informs.',
  ].join('\n')
}

export const CONNECTION_CONTACTS = [
  {
    name: 'TGSPDCL (southern power, including Hyderabad)',
    phone: '1912',
    url: 'https://tgsouthernpower.org',
    covers: 'Southern Telangana including Hyderabad',
  },
  {
    name: 'TGNPDCL (northern power)',
    phone: '1912',
    url: 'https://tgnpdcl.com',
    covers: 'Northern Telangana districts',
  },
  {
    name: 'MeeSeva',
    url: 'https://meeseva.telangana.gov.in',
    covers: 'New connection applications where published',
  },
]
