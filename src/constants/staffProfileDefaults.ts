/** Shared storage key for the org-wide default staff profile photo. */
export const DEFAULT_STAFF_PROFILE_STORAGE_PATH = 'system/defaults/staff-profile-placeholder.png'

export function resolveStaffProfileStoragePath(
  imageUrl: string | null | undefined,
): string {
  const trimmed = typeof imageUrl === 'string' ? imageUrl.trim() : ''
  return trimmed || DEFAULT_STAFF_PROFILE_STORAGE_PATH
}

export function isDefaultStaffProfilePath(path: string | null | undefined): boolean {
  return path === DEFAULT_STAFF_PROFILE_STORAGE_PATH
}
