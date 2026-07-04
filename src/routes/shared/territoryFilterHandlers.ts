import type { Request, Response, Router } from 'express'
import { requireAuth } from '@/middleware/requireAuth.js'
import { canAccessTerritoryFilter } from '@/lib/roleHierarchy.js'
import {
  getTerritoryPickerBootstrapV2,
  listTerritoryChildrenV2,
  parseTerritoryPickerQuery,
} from '@/services/territoryPickerV2Service.js'

export type TerritoryFilterUser = {
  id: string
  organization_id: string
  roles?: { name: string } | null
}

function vocalUser(req: Request): TerritoryFilterUser {
  return (req as Request & { vocalUser: TerritoryFilterUser }).vocalUser
}

function territoryForbidden(res: Response): void {
  res.status(403).json({ error: 'Insufficient role' })
}

function territoryNotFound(res: Response): void {
  res.status(404).json({
    error: 'Telangana territory data not found. Run npm run seed:territories in vocal-api.',
  })
}

/** GET .../territories/bootstrap — state + paginated districts (v2 contract). */
export async function handleTerritoryBootstrap(req: Request, res: Response): Promise<void> {
  const user = vocalUser(req)
  if (!canAccessTerritoryFilter(user.roles?.name)) {
    territoryForbidden(res)
    return
  }

  const opts = parseTerritoryPickerQuery(req.query as Record<string, unknown>)
  const bootstrap = await getTerritoryPickerBootstrapV2(user.organization_id, opts, {
    roleName: user.roles?.name,
    userId: user.id,
  })

  if (!bootstrap.ok) {
    territoryNotFound(res)
    return
  }

  res.json({
    levels: bootstrap.levels,
    state: bootstrap.state,
    districts: bootstrap.districts,
    pagination: bootstrap.pagination,
    filters: bootstrap.filters,
  })
}

/** GET .../territories/children?parent_id= — mandals under a district (v2 contract). */
export async function handleTerritoryChildren(req: Request, res: Response): Promise<void> {
  const user = vocalUser(req)
  if (!canAccessTerritoryFilter(user.roles?.name)) {
    territoryForbidden(res)
    return
  }

  const q = req.query.parent_id
  const parentId =
    typeof q === 'string' && q.trim() && q.trim() !== 'null' ? q.trim() : null
  const opts = parseTerritoryPickerQuery(req.query as Record<string, unknown>)
  const result = await listTerritoryChildrenV2(user.organization_id, parentId, opts, {
    roleName: user.roles?.name,
    userId: user.id,
  })

  if (result.parent_forbidden) {
    res.status(403).json({ error: 'Territory not in your assigned scope' })
    return
  }

  res.json({
    children: result.children,
    pagination: result.pagination,
    filters: result.filters,
  })
}

/** Register read-only cascade filter routes (bootstrap + children). */
export function registerTerritoryFilterRoutes(router: Router): void {
  router.get('/territories/bootstrap', requireAuth, handleTerritoryBootstrap)
  router.get('/territories/children', requireAuth, handleTerritoryChildren)
}
