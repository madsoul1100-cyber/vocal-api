/** Lower number = higher privilege in the org hierarchy. */
export const ROLE_HIERARCHY_BY_NAME: Record<string, number> = {
  super_admin: 1,
  central_support: 2,
  state_leader: 3,
  district_leader: 4,
  ground_worker: 5,
  media_volunteer: 6,
  legal_support: 7,
}

export const STAFF_CREATION_APPROVER_ROLES = ['super_admin', 'central_support'] as const

/** Roles that can open the workers UI and submit new staff (approval queue for non-approvers). */
export const STAFF_WORKER_MANAGER_ROLES = [
  'super_admin',
  'central_support',
  'state_leader',
  'district_leader',
] as const

export function canAccessWorkersPage(roleName: string | null | undefined): boolean {
  return !!roleName && (STAFF_WORKER_MANAGER_ROLES as readonly string[]).includes(roleName)
}

export function hierarchyLevelForRoleName(name: string | null | undefined): number | null {
  if (!name) return null
  return ROLE_HIERARCHY_BY_NAME[name] ?? null
}

export function canApproveStaffCreation(roleName: string | null | undefined): boolean {
  return !!roleName && (STAFF_CREATION_APPROVER_ROLES as readonly string[]).includes(roleName)
}

/** True when the actor must queue worker_activation_requests instead of inserting users directly. */
export function requiresStaffCreationApproval(roleName: string | null | undefined): boolean {
  return !!roleName && !canApproveStaffCreation(roleName)
}

/** Target role must be strictly lower in the org (higher hierarchy_level number). */
export function canAssignRoleLevel(actorLevel: number, targetLevel: number): boolean {
  return targetLevel > actorLevel
}
