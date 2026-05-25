/** Object key (no backend prefix) for the org-wide default staff profile photo. */
export const DEFAULT_STAFF_PROFILE_STORAGE_PATH = 'system/defaults/staff-profile-placeholder.png'

export function staffProfileStorageKey(path: string | null | undefined): string {
  if (!path) return ''
  return path.startsWith('s3:') ? path.slice(3) : path
}

export function isDefaultStaffProfilePath(path: string | null | undefined): boolean {
  const key = staffProfileStorageKey(path)
  return key === DEFAULT_STAFF_PROFILE_STORAGE_PATH || key.endsWith('staff-profile-placeholder.png')
}
