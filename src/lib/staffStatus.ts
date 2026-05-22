/** Staff lifecycle on the Workers tab. */
export type StaffStatus = 'pending' | 'active' | 'inactive'

export function deriveUserStaffStatus(
  active: boolean,
  approvedAt: string | null | undefined,
): StaffStatus {
  if (!active) return 'inactive'
  if (!approvedAt) return 'pending'
  return 'active'
}

export interface StaffCategoryCounts {
  pending: number
  active: number
  inactive: number
  total: number
}
