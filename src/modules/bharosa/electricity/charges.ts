/**
 * Charge explanations — delegates to status-gated KB (manager §6).
 */

import type { GuideLang } from '../guide/playbooks.js'
import { explainFromKb, matchKbRecord } from './kb.js'
import type { BillCharge } from './types.js'

export function matchCharge(label: string) {
  return matchKbRecord(label)
}

export function explainCharge(
  charge: BillCharge,
  lang: GuideLang,
  units: number | null,
): { title: string; body: string; known: boolean } {
  const ex = explainFromKb(charge.label, charge.amount_inr, lang, { units })
  return {
    title: ex.title,
    body: ex.body,
    known: ex.status !== 'unknown' && ex.status !== 'unverified',
  }
}

export function explainAllCharges(
  charges: BillCharge[],
  lang: GuideLang,
  units: number | null,
): string {
  if (!charges.length) {
    return lang === 'te'
      ? 'ఈ బిల్లులో వేరు వేరు ఛార్జ్ లైన్లు స్పష్టంగా చదవలేకపోయాను.'
      : lang === 'hi'
        ? 'इस बिल की अलग-अलग शुल्क पंक्तियाँ साफ़ नहीं पढ़ सकी।'
        : 'I could not read separate charge lines clearly on this bill.'
  }
  return charges
    .map((c, i) => {
      const ex = explainCharge(c, lang, units)
      const amt =
        c.amount_inr != null && Number.isFinite(c.amount_inr)
          ? ` (Rs ${Math.round(c.amount_inr * 100) / 100})`
          : ''
      return `${i + 1}. ${ex.title}${amt}: ${ex.body}`
    })
    .join('\n\n')
}
