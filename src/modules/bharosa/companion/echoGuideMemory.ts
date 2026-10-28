/**
 * Bharosa Guide ↔ Echo Memory bridge.
 * Writes compact issue facts; recalls only relevant edges for the LLM prompt.
 */

import { playbookById } from '../guide/playbooks.js'
import {
  echoCitizenEntityId,
  echoMemoryConfigured,
  echoRecall,
  echoRemember,
  formatEchoFactsForPrompt,
  type EchoEntity,
  type EchoFact,
  type EchoRecalledFact,
} from './echoMemoryClient.js'

export async function recallEchoForCitizen(args: {
  citizenId: string
  name?: string | null
  query: string
  topK?: number
}): Promise<{ facts: EchoRecalledFact[]; promptBlock: string }> {
  if (!echoMemoryConfigured()) return { facts: [], promptBlock: '' }
  const about = [echoCitizenEntityId(args.citizenId)]
  const q =
    args.query.trim() ||
    [args.name, 'Telangana help issues'].filter(Boolean).join(' ')
  // Prefer structural about=citizen; also run a soft query for related facts
  let facts = await echoRecall({ query: q.slice(0, 400), topK: args.topK ?? 8, about })
  if (!facts.length) {
    facts = await echoRecall({
      query: `${args.name ?? ''} ${q}`.trim().slice(0, 400),
      topK: args.topK ?? 8,
    })
  }
  return { facts, promptBlock: formatEchoFactsForPrompt(facts) }
}

/** Persist one real Guide issue as graph facts (token-cheap later). */
export async function writeEchoGuideEpisode(args: {
  sessionId: string
  citizenId: string
  name?: string | null
  place?: string | null
  problemId?: string | null
  problemSummary?: string | null
  status?: string | null
  language?: string | null
  /** Returning citizens → do not assume_new */
  assumeNew?: boolean
}): Promise<void> {
  if (!echoMemoryConfigured()) return
  const summary = (args.problemSummary || args.problemId || '').trim()
  if (!summary) return

  const citizenNode = echoCitizenEntityId(args.citizenId)
  const pb = args.problemId ? playbookById(args.problemId) : null
  const issueTitle = pb?.titles.en || summary.slice(0, 80)
  const issueNode = `issue:${(args.problemId || issueTitle).toLowerCase().replace(/\s+/g, '_').slice(0, 60)}`

  const entities: EchoEntity[] = [
    { name: citizenNode, type: 'person' },
    { name: issueNode, type: 'issue' },
  ]
  if (args.name?.trim()) {
    entities.push({ name: args.name.trim().slice(0, 80), type: 'person' })
  }
  if (args.place?.trim()) {
    entities.push({ name: args.place.trim().slice(0, 80), type: 'place' })
  }

  const facts: EchoFact[] = [
    {
      source: citizenNode,
      target: issueNode,
      relation_type: 'reported',
      fact: `${args.name?.trim() || 'Citizen'} reported: ${issueTitle}. Status: ${args.status ?? 'open'}.${args.language ? ` Lang: ${args.language}.` : ''}`,
      confidence: 'extracted',
    },
  ]
  if (args.name?.trim()) {
    facts.push({
      source: citizenNode,
      target: args.name.trim().slice(0, 80),
      relation_type: 'named',
      fact: `Citizen ${citizenNode} is called ${args.name.trim()}.`,
      confidence: 'extracted',
    })
  }
  if (args.place?.trim()) {
    const place = args.place.trim().slice(0, 80)
    facts.push({
      source: issueNode,
      target: place,
      relation_type: 'located_in',
      fact: `Issue "${issueTitle}" is in ${place}.`,
      confidence: 'extracted',
    })
    facts.push({
      source: citizenNode,
      target: place,
      relation_type: 'lives_near',
      fact: `${args.name?.trim() || 'Citizen'} associated with area ${place}.`,
      confidence: 'inferred',
    })
  }
  if (summary && summary !== issueTitle) {
    facts.push({
      source: citizenNode,
      target: issueNode,
      relation_type: 'described',
      fact: summary.slice(0, 400),
      confidence: 'extracted',
    })
  }

  await echoRemember({
    sessionId: args.sessionId,
    entities,
    facts,
    assumeNew: args.assumeNew === true,
    project: 'bharosa-guide',
  })
}
