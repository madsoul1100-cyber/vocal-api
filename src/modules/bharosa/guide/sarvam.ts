/**
 * Same Sarvam speech APIs the working voice agent uses:
 * saarika for what the person said, bulbul for the spoken answer.
 */

const STT_URL = 'https://api.sarvam.ai/speech-to-text'
const TTS_URL = 'https://api.sarvam.ai/text-to-speech'

export function sarvamConfigured(): boolean {
  return Boolean(process.env.SARVAM_API_KEY?.trim())
}

function key(): string {
  return process.env.SARVAM_API_KEY?.trim() ?? ''
}

function languageCode(lang: string): string {
  if (lang.startsWith('te')) return 'te-IN'
  if (lang.startsWith('hi')) return 'hi-IN'
  return 'en-IN'
}

export async function transcribeSpeech(audio: Buffer, mime: string, language: string): Promise<string> {
  const form = new FormData()
  const type = mime.split(';')[0] || 'audio/webm'
  const ext = type.includes('mp4') ? 'mp4' : type.includes('wav') ? 'wav' : type.includes('mpeg') ? 'mp3' : 'webm'
  form.append('file', new Blob([new Uint8Array(audio)], { type }), `speech.${ext}`)
  form.append('language_code', language === 'auto' ? 'unknown' : languageCode(language))
  form.append('model', 'saarika:v2.5')
  const response = await fetch(STT_URL, {
    method: 'POST',
    headers: { 'api-subscription-key': key() },
    body: form,
    signal: AbortSignal.timeout(20_000),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`Sarvam speech-to-text failed (${response.status})`)
  const data = JSON.parse(raw) as { transcript?: string; text?: string }
  return String(data.transcript || data.text || '').trim()
}

export async function synthesizeSpeech(text: string, language: string): Promise<Buffer> {
  const response = await fetch(TTS_URL, {
    method: 'POST',
    headers: {
      'api-subscription-key': key(),
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: text.slice(0, 700),
      target_language_code: languageCode(language),
      speaker: 'priya',
      model: 'bulbul:v3',
      pace: 0.95,
      speech_sample_rate: 24000,
      output_audio_codec: 'mp3',
      temperature: 0.42,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const data = (await response.json().catch(() => ({}))) as { audios?: string[]; audio?: string; message?: string }
  if (!response.ok) throw new Error(data.message || `Sarvam speech failed (${response.status})`)
  const encoded = data.audios?.[0] || data.audio
  if (!encoded) throw new Error('Sarvam returned no audio')
  return Buffer.from(encoded, 'base64')
}
