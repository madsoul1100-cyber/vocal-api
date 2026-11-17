/**
 * Public specimen bills gathered from web (TGSPDCL duplicate-bill / published samples).
 * Used for offline regression — not private customer data collected by us.
 *
 * Sources (17 Nov 2026 package + public pages):
 * - Gruha Jyothi domestic specimen (Wanaparthy / published summaries)
 * - Domestic USC 102629545 style line items (public duplicate-bill page content)
 */

export const SPECIMEN_DOMESTIC_A = `
TGSPDCL electricity bill
USC No.: 103813630
NAME: VENKATAMMA
CAT: 1 Domestic
CONTRACTED LOAD: 0.26 KW
UNITS: 83
period Dec 2024
ENERGY CHARGES: 199.80
FIXED CHARGES: 2.60
CUST CHARGES: 70.00
Electricity Duty: 4.98
Interest on ED: 0.03
SURCHARGE: 25.00
FSA/FCA Charges: 0.00
LOSS/GAIN: -0.41
BILL AMOUNT: 302.00
Gruha Jyothi Subsidy: 302.0
Net Bill Amount: 0.00
Arrears after 01/04/23: 413.00
ACD DUE: 0.00
TOTAL DUE: 413.00
`.trim()

export const SPECIMEN_DOMESTIC_B = `
TGSPDCL bill
USC No.: 102629545
CAT: 1 Domestic
CONTRACTED LOAD: 0.2 KW
UNITS: 70
period Feb 2026
Energy Charges: 157.20
Fixed Charges: 12.90
Customer Charges: 70.00
Electricity Duty: 4.20
Interest on ED: 0.00
FSA/FCA Charges: 0.00
LOSS/GAIN: -0.30
BILL AMOUNT: 244.00
GRUHA JYOTHI SUBSIDY: -244.00
NET BILL AMOUNT: 0.00
ACD Due: 0.00
TOTAL DUE: 0.00
`.trim()

/** Synthetic teaching example from manager §5 (amounts as “read from the bill”). */
export const SPECIMEN_SYNTHETIC_280 = `
electricity bill
service no: 1999001001
CAT: 1 Domestic
CONTRACTED LOAD: 2 KW
units 280
period Nov 2026
due 12
Energy charges: 1636
Fixed charges: 20
Customer charges: 100
Electricity duty: 17
total 1773
`.trim()

export const SPECIMEN_SYNTHETIC_240_PREV = `
electricity bill
service no: 1999001001
CAT: 1 Domestic
units 240
period Oct 2026
Energy charges: 1328
Fixed charges: 20
Customer charges: 100
Electricity duty: 14
total 1462
`.trim()
