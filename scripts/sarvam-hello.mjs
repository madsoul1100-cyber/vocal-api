/**
 * One text-to-speech call. The key is read from .env.local.
 * Run from vocal-api: node scripts/sarvam-hello.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { SarvamAIClient } from 'sarvamai'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env.local') })

const apiSubscriptionKey = process.env.SARVAM_API_KEY?.trim()
if (!apiSubscriptionKey) {
  console.error('SARVAM_API_KEY is missing from .env.local')
  process.exit(1)
}

const client = new SarvamAIClient({ apiSubscriptionKey })
const text = 'Call 1912. That is the Telangana electricity helpline.'
const attempts = [
  { model: 'bulbul:v3', speaker: 'priya', language_code: 'en-IN' },
  { model: 'bulbul:v4-flash', speaker: 'simran_en_customer', language_code: 'en-IN' },
]

let saved = null
for (const attempt of attempts) {
  try {
    const response = await client.textToSpeech.convert({ text, ...attempt })
    const audio = Buffer.from(response.audios.join(''), 'base64')
    if (!audio.length) throw new Error('empty audio')
    const outDir = path.join(root, 'tmp')
    fs.mkdirSync(outDir, { recursive: true })
    const ext = audio[0] === 0x52 && audio[1] === 0x49 ? 'wav' : 'mp3'
    const outPath = path.join(outDir, `sarvam-hello.${ext}`)
    fs.writeFileSync(outPath, audio)
    saved = { ...attempt, bytes: audio.length, outPath }
    break
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${attempt.model} ${attempt.speaker}: ${message.replace(/sk_[A-Za-z0-9_]+/g, '[key]')}`)
  }
}

if (!saved) {
  console.error('No Sarvam voice returned audio')
  process.exit(1)
}

console.log(`model ${saved.model}`)
console.log(`speaker ${saved.speaker}`)
console.log(`bytes ${saved.bytes}`)
console.log(`file ${saved.outPath}`)
