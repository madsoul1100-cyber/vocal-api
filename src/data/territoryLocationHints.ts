/**
 * Colloquial / landmark hints for Greater Hyderabad metro area.
 * When present in intake text, territory candidates outside these district
 * subtrees are penalized (fixes homonyms like Narsingi-Medak vs Hyderabad).
 */
export const GREATER_HYDERABAD_DISTRICT_CODES = ['525', '547', '538'] as const

/** Normalized tokens — matched as substrings after normalizeForMatch. */
export const GREATER_HYDERABAD_TEXT_HINTS = [
  'hyderabad',
  'secunderabad',
  'ranga reddy',
  'rangareddy',
  'ranga reddy district',
  'ghmc',
  'greater hyderabad',
  'medchal malkajgiri',
  'medchal',
  'malkajgiri',
  'financial district',
  'gachibowli',
  'hitec city',
  'hitech city',
  'nanakramguda',
  'kokapet',
  'manikonda',
  'narsingi bus',
  'ncc urban',
  'ncc uran',
  'uran one',
  'snapp 24',
  'snap 24',
  'telangana capital',
  'cyberabad',
] as const

/** Extra aliases keyed by territory `code` (LGD) or normalized territory name. */
export const TERRITORY_NAME_ALIASES: Record<string, string[]> = {
  hyderabad: ['hydreabad', 'hydrabad', 'hyd', 'hmd', 'bhagyanagar'],
  'ranga reddy': ['rangareddy', 'r r district', 'rr district', 'cyberabad'],
  'medchal-malkajgiri': ['medchal', 'malkajgiri', 'medchal malkajgiri'],
  secunderabad: ['secunderbad', 'sceunderabad'],
  'greater hyderabad municipal corporation': ['ghmc', 'greater hyderabad'],
}
