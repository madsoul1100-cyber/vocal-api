import type { GuideLang } from '../guide/playbooks.js'

export type ConnectionKind = 'home' | 'shop' | 'farm'

export interface BillCharge {
  /** Label as printed / read from the bill */
  label: string
  /** Amount in INR when readable */
  amount_inr: number | null
  /** Whether OCR was confident about this line */
  clear: boolean
  /** Canonical key when we recognise the charge */
  code?: string
}

export interface BillReading {
  service_no: string | null
  consumer_name: string | null
  billing_period: string | null
  units: number | null
  total_inr: number | null
  due_date: string | null
  discom: 'TGSPDCL' | 'TGNPDCL' | 'unknown' | null
  charges: BillCharge[]
  /** Fields the OCR marked unclear — never invent these */
  unclear_fields: string[]
  /** True when the image was not an electricity bill */
  not_a_bill: boolean
  raw_notes: string | null
}

export interface BillMonthPoint {
  period: string
  units: number
  total_inr: number
}

export interface BillEstimate {
  low_inr: number
  high_inr: number
  basis_months: number
  labelled: true
}

export type BillStage =
  | 'await_photo'
  | 'confirm'
  | 'fix_field'
  | 'explained'

export type ConnectionStage =
  | 'await_location'
  | 'ask_type'
  | 'ask_load'
  | 'confirm'
  | 'result'

export interface GeoPoint {
  lat: number
  lng: number
  label?: string
}

export interface PoleResult {
  available: boolean
  pole_id?: string
  distance_m?: number
  note: string
}

export interface MaterialLine {
  item: string
  quantity: string
  note?: string
}

export interface ConnectionCostEstimate {
  materials_work_low_inr: number
  materials_work_high_inr: number
  applicant_charges_low_inr: number
  applicant_charges_high_inr: number
  labelled: true
  source_note: string
}

export interface BillFlowState {
  feature: 'bill'
  stage: BillStage
  reading: BillReading | null
  /** Confirmed / corrected reading used for explanations */
  confirmed: BillReading | null
  history: BillMonthPoint[]
  fix_field: string | null
}

export interface ConnectionFlowState {
  feature: 'connection'
  stage: ConnectionStage
  location: GeoPoint | null
  location_text: string | null
  connection_type: ConnectionKind | null
  load_kw: number | null
  appliances_note: string | null
}

export type ElectricityState = BillFlowState | ConnectionFlowState

export interface ElectricityUiPayload {
  feature: 'bill' | 'connection'
  stage: string
  actions?: Array<{ id: string; label: string }>
  usage_chart?: BillMonthPoint[]
  estimate?: BillEstimate | null
  reading_summary?: Partial<BillReading> | null
  connection_summary?: {
    location_text?: string | null
    connection_type?: ConnectionKind | null
    load_kw?: number | null
    pole?: PoleResult | null
    materials?: MaterialLine[]
    cost?: ConnectionCostEstimate | null
  } | null
}

export interface ElectricityTurnResult {
  reply: string
  state: ElectricityState | null
  contacts: Array<{ name: string; phone?: string; url?: string; email?: string; covers: string }>
  ui: ElectricityUiPayload | null
  problem_id: 'power_bill_explain' | 'power_new_connection'
}

export type { GuideLang }
