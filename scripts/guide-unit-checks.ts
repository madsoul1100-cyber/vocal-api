/**
 * Offline checks for the pure Guide helpers (no database, no LLM, no network).
 * Covers the code fixes from the Bharosa test review (4 Nov 2026):
 *   #3 truncation safety, #7 name echo, #12 phone grouping, plus the name-intro filters.
 *
 *   npx tsx scripts/guide-unit-checks.ts
 */
import assert from 'node:assert/strict'
import { declinesName, extractBareName, extractNamedIntro, isShortGreeting } from '../src/lib/citizenIntakeLadder.js'
import { BHAROSA_SYSTEM_PROMPT, buildGuideSystemPrompt, PRIYA_SOUL_PROMPT } from '../src/modules/bharosa/guide/prompts.js'
import { clipAtSentence, dropDanglingTail, groupPhoneNumbers } from '../src/modules/bharosa/guide/text.js'

let passed = 0
function check(label: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (err) {
    console.error(`FAIL ${label}\n     ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  }
}

// ---- T-09 / finding 7: name echo must keep the last syllable ("రవి", not "రవ")
check('Telugu name keeps its vowel sign', () => {
  assert.equal(extractNamedIntro('నా పేరు రవి. ఇప్పుడు సమాధానం చెప్పండి'), 'రవి')
})
check('Telugu name with two words', () => {
  assert.equal(extractNamedIntro('నా పేరు లక్ష్మి దేవి'), 'లక్ష్మి దేవి')
})
check('Hindi name keeps matras', () => {
  assert.equal(extractNamedIntro('मेरा नाम अनीता है'), 'अनीता')
})
check('English intro still works and title-cases', () => {
  assert.equal(extractNamedIntro('my name is anurag, i am from hyderabad'), 'Anurag')
})
check('"I am facing ..." is not a name', () => {
  assert.equal(extractNamedIntro('I am facing a power cut in Kukatpally'), null)
})
check('"I\'m from Hyderabad" is not a name', () => {
  assert.equal(extractNamedIntro("I'm from Hyderabad"), null)
})
check('plain problem text is not a name', () => {
  assert.equal(extractNamedIntro('There is no power in our street in Kukatpally'), null)
})
check('declined name is detected (EN)', () => {
  assert.equal(declinesName('I would rather not share my name. Just tell me what to do'), true)
  assert.equal(declinesName('I already said I prefer not to share my name. Please just answer the pension question.'), true)
})
check('declined name is detected (more phrasings)', () => {
  assert.equal(declinesName("I'd rather not share my name"), true)
  assert.equal(declinesName("I don't want to give my name"), true)
  assert.equal(declinesName('no need for my name'), true)
  assert.equal(declinesName('నా పేరు చెప్పను'), true)
  assert.equal(declinesName('There is no power in our street'), false)
})
check('greeting still detected, bare name helper unchanged for WhatsApp', () => {
  assert.equal(isShortGreeting('hii'), true)
  assert.equal(extractBareName('రవి'), 'రవి')
})

// ---- finding 12 / T-14: phone numbers grouped for reading and speech
check('1800 number grouped (12 digits)', () => {
  assert.equal(groupPhoneNumbers('పౌర సరఫరాల శాఖ 1967 లేదా 180042500333.'), 'పౌర సరఫరాల శాఖ 1967 లేదా 1800 425 00333.')
})
check('1800 number grouped (11 digits and dashes)', () => {
  assert.equal(groupPhoneNumbers('Call 18004250028 or 1800-425-0028.'), 'Call 1800 425 0028 or 1800 425 0028.')
})
check('short numbers and mobiles are left alone', () => {
  assert.equal(groupPhoneNumbers('Call 1912 or 155313 or 9440446106.'), 'Call 1912 or 155313 or 9440446106.')
})

// ---- finding 3: never show half a word
check('dropDanglingTail removes a cut word', () => {
  assert.equal(
    dropDanglingTail('You could contact the Executive Engineer. You could also reach out to your local corporator, as t'),
    'You could contact the Executive Engineer.',
  )
})
check('dropDanglingTail keeps a complete reply', () => {
  assert.equal(dropDanglingTail('Call 1912. Keep the complaint number.'), 'Call 1912. Keep the complaint number.')
})
check('clipAtSentence ends on a sentence', () => {
  const text = 'Call 1912 and give your area. Note the complaint number. Ask for the engineer if it is not fixed in two days.'
  const out = clipAtSentence(text, 70)
  assert.ok(out.endsWith('.'), out)
  assert.ok(text.startsWith(out), out)
})
check('clipAtSentence never cuts a Telugu word', () => {
  const text = 'మీ ఊరిలో కరెంట్ లేకపోతే 1912 కు కాల్ చేయండి। ఫిర్యాదు నంబర్ రాసుకోండి। ఇంజనీర్ ఆఫీసుకు కూడా వెళ్లవచ్చు।'
  const out = clipAtSentence(text, 60)
  assert.ok(out.endsWith('।'), out)
})
check('clipAtSentence falls back to a whole word', () => {
  const out = clipAtSentence('word '.repeat(40).trim(), 52)
  assert.ok(/word…$/.test(out), out)
})

// ---- prompts are the verbatim sheet text and assembled with state
check('prompt blocks carry the key rules from the review', () => {
  assert.match(BHAROSA_SYSTEM_PROMPT, /Names are optional\. Never ask for a name before helping\./)
  assert.match(BHAROSA_SYSTEM_PROMPT, /Help first, questions second\./)
  assert.match(BHAROSA_SYSTEM_PROMPT, /1800 425 00333, not 180042500333/)
  assert.match(PRIYA_SOUL_PROMPT, /like a cousin who knows every office in Hyderabad/)
  assert.match(PRIYA_SOUL_PROMPT, /No ego about scope\./)
})
check('system prompt never tells the model to ask for a name', () => {
  const prompt = buildGuideSystemPrompt({ languageName: 'Telugu', name: 'రవి', place: 'KPHB colony', problem: 'drainage block' })
  assert.match(prompt, /Citizen name: రవి \(use exactly as written\)/)
  assert.match(prompt, /Area on file: KPHB colony/)
  assert.doesNotMatch(prompt, /What should I call you/i)
  const declined = buildGuideSystemPrompt({ languageName: 'English', nameDeclined: true })
  assert.match(declined, /They declined to share it\. Never ask for it\./)
})

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures' : ''}`)
