/**
 * Usage summary + next-bill estimate from bills the user actually supplied.
 * Forecast is OFF until validated on held-out bills (manager TC-07 / §7).
 */

import type { GuideLang } from '../guide/playbooks.js'
import type { BillEstimate, BillMonthPoint, BillReading } from './types.js'

/** Need at least this many confirmed months before even considering a forecast. */
export const MIN_HISTORY_FOR_ESTIMATE = 3

/** Manager: do not show the wide 0.9–1.1 range until the method is validated. */
export function forecastEnabled(): boolean {
  return process.env.ELECTRICITY_BILL_FORECAST_ENABLED === '1'
}

export function normalizeServiceNo(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 6 ? digits : raw.replace(/\s+/g, '').toUpperCase() || null
}

export function readingToHistoryPoint(reading: BillReading): BillMonthPoint | null {
  if (reading.units == null || reading.total_inr == null) return null
  if (!Number.isFinite(reading.units) || !Number.isFinite(reading.total_inr)) return null
  const period = (reading.billing_period || 'This bill').trim().slice(0, 40)
  return {
    period,
    units: reading.units,
    total_inr: reading.total_inr,
    service_no: normalizeServiceNo(reading.service_no),
  }
}

export type HistoryMergeResult =
  | { ok: true; history: BillMonthPoint[]; service_no: string | null }
  | { ok: false; reason: 'different_service'; existing: string; incoming: string }

export function mergeHistoryForService(
  existing: BillMonthPoint[],
  activeService: string | null,
  point: BillMonthPoint,
): HistoryMergeResult {
  const incoming = point.service_no
  if (activeService && incoming && activeService !== incoming) {
    return { ok: false, reason: 'different_service', existing: activeService, incoming }
  }
  // Also block if history already has a different service
  const histSvc = existing.find((h) => h.service_no)?.service_no ?? activeService
  if (histSvc && incoming && histSvc !== incoming) {
    return { ok: false, reason: 'different_service', existing: histSvc, incoming }
  }
  const key = `${incoming ?? ''}::${point.period.toLowerCase()}`
  const without = existing.filter((p) => `${p.service_no ?? ''}::${p.period.toLowerCase()}` !== key)
  return {
    ok: true,
    history: [...without, point].slice(-12),
    service_no: incoming ?? histSvc ?? null,
  }
}

/** @deprecated prefer mergeHistoryForService */
export function mergeHistory(existing: BillMonthPoint[], point: BillMonthPoint): BillMonthPoint[] {
  const r = mergeHistoryForService(existing, null, point)
  return r.ok ? r.history : existing
}

export function usageChangeSentence(history: BillMonthPoint[], lang: GuideLang): string {
  if (history.length < 2) {
    return lang === 'te'
      ? 'ఇప్పటివరకు ఒక బిల్లు మాత్రమే ఉంది. వాడకం పోలికకు మునుపటి బిల్లులు కూడా పంపండి.'
      : lang === 'hi'
        ? 'अभी सिर्फ़ एक बिल है। इस्तेमाल की तुलना के लिए पिछले बिल भी भेजें।'
        : 'Only one bill is available so far. Send previous bills if you want a usage comparison.'
  }
  const prev = history[history.length - 2]!
  const curr = history[history.length - 1]!
  const delta = curr.units - prev.units
  if (delta === 0) {
    return lang === 'te'
      ? `మీరు గత నెలలా ${curr.units} యూనిట్లు వాడారు.`
      : lang === 'hi'
        ? `आपने पिछले महीने जितनी ही ${curr.units} यूनिट इस्तेमाल की।`
        : `You used the same ${curr.units} units as last month.`
  }
  if (delta > 0) {
    return lang === 'te'
      ? `మీరు ఈ నెల ${curr.units} యూనిట్లు వాడారు — గత నెల కంటే ${delta} ఎక్కువ.`
      : lang === 'hi'
        ? `आपने इस महीने ${curr.units} यूनिट इस्तेमाल की — पिछले महीने से ${delta} ज़्यादा।`
        : `You used ${curr.units} units this month, ${delta} more than last month.`
  }
  const less = Math.abs(delta)
  return lang === 'te'
    ? `మీరు ఈ నెల ${curr.units} యూనిట్లు వాడారు — గత నెల కంటే ${less} తక్కువ.`
    : lang === 'hi'
      ? `आपने इस महीने ${curr.units} यूनिट इस्तेमाल की — पिछले महीने से ${less} कम।`
      : `You used ${curr.units} units this month, ${less} fewer than last month.`
}

export function chartAscii(history: BillMonthPoint[]): string {
  if (!history.length) return ''
  const max = Math.max(...history.map((h) => h.units), 1)
  return history
    .map((h) => {
      const bars = Math.max(1, Math.round((h.units / max) * 12))
      return `${h.period}: ${'▓'.repeat(bars)} ${h.units} units (Rs ${Math.round(h.total_inr)})`
    })
    .join('\n')
}

/**
 * Estimate next bill as a range. Disabled unless ELECTRICITY_BILL_FORECAST_ENABLED=1.
 */
export function estimateNextBill(history: BillMonthPoint[]): BillEstimate | null {
  if (!forecastEnabled()) return null
  if (history.length < MIN_HISTORY_FOR_ESTIMATE) return null
  const totals = history.map((h) => h.total_inr).filter((n) => Number.isFinite(n) && n > 0)
  if (totals.length < MIN_HISTORY_FOR_ESTIMATE) return null
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length
  const variance = totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length
  const std = Math.sqrt(variance)
  // Reject overly wide ranges (TC-07 style 0.9min–1.1max was unhelpful)
  const low = Math.max(0, Math.floor(mean - std))
  const high = Math.ceil(mean + std)
  if (high - low > mean * 0.35 && mean > 0) return null
  if (high < low) return null
  return { low_inr: low, high_inr: high, basis_months: totals.length, labelled: true }
}

export function estimateSentence(estimate: BillEstimate | null, lang: GuideLang, history: BillMonthPoint[] = []): string {
  if (!forecastEnabled() || !estimate) {
    if (history.length) {
      const lines = history.map((h) => `${h.period}: ${h.units} u / Rs ${Math.round(h.total_inr)}`).join('; ')
      return lang === 'te'
        ? `గత బిల్లులు: ${lines}. తదుపరి బిల్లు అంచనా ఇంకా చూపను — ఫోర్‌కాస్ట్ విధానం ధృవీకరించే వరకు.`
        : lang === 'hi'
          ? `पिछले बिल: ${lines}. अगले बिल का अनुमान अभी नहीं — विधि जाँच तक।`
          : `Past bills: ${lines}. I am not showing a next-bill forecast until the method is validated.`
    }
    return lang === 'te'
      ? 'తదుపరి బిల్లు అంచనా ఇంకా చెప్పలేను. మునుపటి బిల్లులు పంపండి.'
      : lang === 'hi'
        ? 'अगले बिल का अनुमान अभी नहीं। कृपया पिछले बिल भेजें।'
        : 'I cannot estimate the next bill yet. Please send your previous bills.'
  }
  const low = Math.round(estimate.low_inr)
  const high = Math.round(estimate.high_inr)
  if (lang === 'te') {
    return `తదుపరి బిల్లు బహుశా Rs ${low} నుంచి Rs ${high} మధ్య ఉండవచ్చు. ఇది అంచనా మాత్రమే. (${estimate.basis_months} బిల్లుల ఆధారంగా)`
  }
  if (lang === 'hi') {
    return `अगला बिल शायद Rs ${low} से Rs ${high} के बीच हो। यह केवल अनुमान है। (${estimate.basis_months} बिलों पर आधारित)`
  }
  return `Probably between Rs ${low} and Rs ${high}. This is an estimate, not an official bill. (Based on ${estimate.basis_months} bills.)`
}
