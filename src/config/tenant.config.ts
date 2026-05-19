/**
 * Tenant Configuration
 * ====================
 *
 * Single source of truth for everything that varies per deployment.
 *
 * To onboard a new client:
 *   1. Clone this repo to a new branch / new repo for the client.
 *   2. Edit the values in `TENANT_CONFIG` below.
 *   3. Replace `/public/logo.svg` with the client's logo.
 *   4. Set up a new Supabase/Vercel/Clerk project, populate env vars,
 *      and run the seed scripts (see README).
 *
 * Anything that varies between tenants MUST live here. If you find a
 * hardcoded "My Leader" / "JTG" / brand color anywhere else in the code,
 * that's a refactor candidate — file an issue and migrate it.
 *
 * Runtime-editable settings (SLA windows, feature flags, etc.) live in
 * the `organization_settings` table, NOT here. Use this file only for
 * deploy-time identity and wiring.
 */

export interface TenantConfig {
  /** Platform-level branding — usually constant across tenants. */
  app: {
    /** Product name shown in headers, nav, sign-in. Currently "My Leader". */
    name: string
    /** Single-letter or short logo bubble (e.g. "M"). */
    shortName: string
    /** Short tagline shown on landing page hero. */
    tagline: string
    /** SEO meta description. */
    description: string
    /** Path to the SVG logo under /public. */
    logoPath: string
    /** Path to the favicon under /public. */
    faviconPath: string
  }

  /** Party / organisation identity — varies per tenant. */
  party: {
    /** URL-safe slug. Used in ticket numbers, audit logs. */
    slug: string
    /** Short display name (e.g. "JTG"). */
    name: string
    /** Full official name. Same as `name` if no separate full form. */
    fullName: string
    /** Optional public website URL. */
    websiteUrl?: string
    /** Contact email shown on landing page. */
    contactEmail: string
    /** Production domain (no scheme). Used for absolute URLs. */
    productionDomain: string
  }

  /** Brand colors. Injected as CSS variables by TenantThemeProvider. */
  brand: {
    /** Main action color — used in buttons, badges, primary nav bubble. */
    primaryColor: string
    /** Darker shade for hover states + gradients. */
    primaryColorDark: string
    /** Accent color used in landing page icons + highlights. */
    accentColor: string
  }

  /** Telegram bots. Citizen-facing + worker-facing. */
  bots: {
    citizen: {
      /** Bot username WITHOUT the leading "@". */
      username: string
      /** Friendly name used in bot replies. */
      welcomeName: string
    }
    worker: {
      username: string
      welcomeName: string
    }
  }

  /** Geographic root and hierarchy labels for the territory tree. */
  geography: {
    /** Country (e.g. "India"). For reference only. */
    country: string
    /** Top-level territory name (e.g. "Telangana"). */
    rootName: string
    /** Approximate centroid of the root area. */
    rootCentroid: { lat: number; lng: number }
    /** Ordered hierarchy levels — used to label the tree per deployment. */
    levels: readonly string[]
    /** The constituency this client is launching in (optional). */
    primaryConstituency?: string
  }

  /** Language defaults. Drives LLM intake replies and seed copy. */
  language: {
    /** Primary language code (ISO 639-1). */
    primary: string
    /** Other languages the LLM should respond in if the user uses them. */
    supported: readonly string[]
  }

  /**
   * Civic scope policy. Goes into the LLM system prompt and into any
   * "what we help with" page in the app. Adjust per tenant to reflect
   * what the organisation actually wants to serve.
   */
  civicScope: {
    /** One-line summary. */
    summary: string
    /** Topics this org WILL help with. */
    included: readonly string[]
    /** Topics this org WILL NOT help with. */
    excluded: readonly string[]
    /** Polite-decline message templates in user's language. */
    politeDecline: {
      en: string
      te: string
    }
  }

  /** Operational defaults. */
  operations: {
    /** IANA timezone (e.g. "Asia/Kolkata"). */
    timezone: string
    /** Support email for escalations / internal contact. */
    supportEmail: string
  }
}

// =============================================================================
// Active tenant configuration — JTG / Sircilla / Telangana
// =============================================================================
export const TENANT_CONFIG: TenantConfig = {
  app: {
    name: 'My Leader',
    shortName: 'M',
    tagline: 'Your Voice, Straight to Your Leader',
    description:
      'Report civic issues directly to your MLA. No middlemen, no filters. Real on-ground intelligence for leaders and workers across Telangana.',
    logoPath: '/logo.svg',
    faviconPath: '/favicon.ico',
  },

  party: {
    slug: 'jtg',
    name: 'JTG',
    fullName: 'JTG',
    contactEmail: 'hello@bevocal.in',
    productionDomain: 'vocal-app-one.vercel.app',
  },

  brand: {
    // Primary action color used in dashboard chrome, badges, primary nav bubble.
    // Today this defaults to the existing blue palette; swap to the JTG hex
    // when the brand is finalised.
    primaryColor: '#3b82f6',
    primaryColorDark: '#1d4ed8',
    // Accent color — used in the landing-page hero icons + highlights.
    // Currently the existing red so visual identity stays consistent.
    accentColor: '#CC0000',
  },

  bots: {
    citizen: {
      username: 'Bevocal_bot',
      welcomeName: 'My Leader assistant',
    },
    worker: {
      username: 'Vocal_worker_bot',
      welcomeName: 'My Leader Worker Bot',
    },
  },

  geography: {
    country: 'India',
    rootName: 'Telangana',
    rootCentroid: { lat: 17.385, lng: 78.4867 }, // central Hyderabad
    levels: ['state', 'district', 'constituency', 'mandal', 'ward'] as const,
    primaryConstituency: 'Sircilla',
  },

  language: {
    primary: 'te',
    supported: ['te', 'en'] as const,
  },

  // Scope informed by the public grievance taxonomy at
  // docs/research/telangana_public_grievance_topics.md (§10 category map).
  civicScope: {
    summary:
      'We help citizens of Telangana resolve civic, governance, and public-service issues that involve government bodies or public agencies. We do not handle private disputes between individuals.',
    included: [
      'Civic infrastructure (drainage, potholes, waterlogging, garbage, streetlights, public toilets)',
      'Utilities (drinking water, tankers, power cuts, voltage fluctuations)',
      'Mobility (traffic violations, congestion, public transport, autos/cabs)',
      'Land and urban governance (land records, Dharani/Bhu Bharati, land grabbing, HYDRAA, evictions, illegal construction)',
      'Welfare and entitlements (housing schemes, ration cards, pensions, Prajavani complaints)',
      'Police and legal accountability (FIR refusal, women safety, cybercrime)',
      'Health and environment (stray dogs, pollution, lake/nala/river pollution)',
      'Youth and jobs (TGPSC delays, unemployment, fake consultancies)',
      'Corruption and bribery by public officials',
      'Accountability for officials and contractors on failed civic works',
    ],
    excluded: [
      'Family disputes, inheritance/property bifurcation between relatives',
      'Marital, romantic, or personal relationship issues',
      'Private financial disputes between individuals',
      'Commercial or business disputes between private parties',
      'Religious or community-internal personal matters',
      'Issues already in active court proceedings (we cannot intervene legally)',
    ],
    politeDecline: {
      en:
        "Thank you for reaching out. This matter looks like a private or personal issue — we're only able to help with civic, governance, and public-service grievances that involve a government body. For your situation, we'd suggest seeking appropriate legal or community support. Wishing you the best.",
      te:
        'మీరు తెలియజేసిన సమస్యకు ధన్యవాదాలు. ఇది వ్యక్తిగత లేదా ప్రైవేట్ విషయంగా కనిపిస్తోంది — మేము ప్రభుత్వ సంస్థలకు సంబంధించిన పౌర, పరిపాలన మరియు ప్రజా సేవల ఫిర్యాదులలో మాత్రమే సహాయపడగలము. మీ పరిస్థితికి తగిన న్యాయపరమైన లేదా సామాజిక మద్దతును పొందమని సూచిస్తున్నాము.',
    },
  },

  operations: {
    timezone: 'Asia/Kolkata',
    supportEmail: 'hello@bevocal.in',
  },
}

/**
 * Convenience exports — for ergonomic destructured imports.
 * `import { tenantApp, tenantParty, tenantBrand } from '@/config/tenant.config.js'`
 */
export const tenantApp        = TENANT_CONFIG.app
export const tenantParty      = TENANT_CONFIG.party
export const tenantBrand      = TENANT_CONFIG.brand
export const tenantBots       = TENANT_CONFIG.bots
export const tenantGeography  = TENANT_CONFIG.geography
export const tenantLanguage   = TENANT_CONFIG.language
export const tenantCivicScope = TENANT_CONFIG.civicScope
export const tenantOps        = TENANT_CONFIG.operations
