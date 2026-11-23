/** Shared by the UI and routes. Only an omitted allowlist admits any authenticated user. */
export function snapshotAccessPolicy(config: unknown):
  | { mode: 'authenticated' }
  | { mode: 'allowlist'; users: ReadonlySet<string> }
  | { mode: 'disabled' } {
  if (config === undefined) return { mode: 'authenticated' };
  if (!Array.isArray(config) || config.length === 0) return { mode: 'disabled' };
  const users = Array.from(config);
  if (!users.every(user => typeof user === 'string' && user !== '' && user === user.trim())) {
    return { mode: 'disabled' };
  }
  return { mode: 'allowlist', users: new Set(users) };
}
