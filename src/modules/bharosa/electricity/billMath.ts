/**
 * Usage summary + next-bill estimate from bills the user actually supplied.
 * Never invents history. Estimates only when enough reliable months exist.
 */

import type { GuideLang } from '../guide/playbooks.js'
import type { BillEstimate, BillMonthPoint, BillReading } from './types.js'

/** Need at least this many confirmed months before estimating the next bill. */
export const MIN_HISTORY_FOR_ESTIMATE = 2

export function readingToHistoryPoint(reading: BillReading): BillMonthPoint | null {
  if (reading.units == null || reading.total_inr == null) return null
  if (!Number.isFinite(reading.units) || !Number.isFinite(reading.total_inr)) return null
  const period = (reading.billing_period || 'This bill').trim().slice(0, 40)
  return { period, units: reading.units, total_inr: reading.total_inr }
}

export function mergeHistory(existing: BillMonthPoint[], point: BillMonthPoint): BillMonthPoint[] {
  const key = point.period.toLowerCase()
  const without = existing.filter((p) => p.period.toLowerCase() !== key)
  return [...without, point].slice(-12)
}

export function usageChangeSentence(history: BillMonthPoint[], lang: GuideLang): string {
  if (history.length < 2) {
    return lang === 'te'
      ? 'ఇప్పటివరకు ఒక బిల్లు మాత్రమే ఉంది. వాడకం పోలికకు మునుపటి బిల్లులు కూడా పంపండి.'
      : lang === 'hi'
        ? 'अभी सिर्फ़ एक बिल है। इस्तेमाल की तुलना के लिए पिछले बिल भी भेजें।'
        : 'Only one bill is available so far. Send previous bills if you want a usage comparison.'
  }
  const sorted = [...history]
  const prev = sorted[sorted.length - 2]!
  const curr = sorted[sorted.length - 1]!
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
 * Estimate next bill as a range from recent totals.
 * Uses min/max of recent months expanded by ~10%, never a single exact figure.
 */
export function estimateNextBill(history: BillMonthPoint[]): BillEstimate | null {
  if (history.length < MIN_HISTORY_FOR_ESTIMATE) return null
  const totals = history.map((h) => h.total_inr).filter((n) => Number.isFinite(n) && n > 0)
  if (totals.length < MIN_HISTORY_FOR_ESTIMATE) return null
  const min = Math.min(...totals)
  const max = Math.max(...totals)
  const low = Math.max(0, Math.floor(min * 0.9))
  const high = Math.ceil(max * 1.1)
  if (high < low) return null
  return {
    low_inr: low,
    high_inr: high,
    basis_months: totals.length,
    labelled: true,
  }
}

export function estimateSentence(estimate: BillEstimate | null, lang: GuideLang): string {
  if (!estimate) {
    return lang === 'te'
      ? 'తదుపరి బిల్లు అంచనా ఇంకా చెప్పలేను. నమ్మదగిన చరిత్ర ఉన్నప్పుడే అంచనా ఇస్తాను. దయచేసి మునుపటి బిల్లులు పంపండి.'
      : lang === 'hi'
        ? 'अगले बिल का अनुमान अभी नहीं दे सकती। पर्याप्त विश्वसनीय इतिहास होने पर ही अनुमान दूँगी। कृपया पिछले बिल भेजें।'
        : 'I cannot estimate the next bill yet. Please send your previous bills. I can give an estimate only when there is enough reliable history.'
  }
  const low = Math.round(estimate.low_inr)
  const high = Math.round(estimate.high_inr)
  if (lang === 'te') {
    return `తదుపరి బిల్లు బహుశా Rs ${low} నుంచి Rs ${high} మధ్య ఉండవచ్చు. ఇది అంచనా మాత్రమే — అధికారిక బిల్లు కాదు. (${estimate.basis_months} బిల్లుల ఆధారంగా)`
  }
  if (lang === 'hi') {
    return `अगला बिल शायद Rs ${low} से Rs ${high} के बीच हो। यह केवल अनुमान है — आधिकारिक बिल नहीं। (${estimate.basis_months} बिलों पर आधारित)`
  }
  return `Probably between Rs ${low} and Rs ${high}. This is an estimate, not an official bill. (Based on ${estimate.basis_months} bills.)`
}
