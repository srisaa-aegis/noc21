import { PortalRole } from '../app/core/models';

/** Seeds a session before AuthService is instantiated (it restores from sessionStorage). */
export function seedSession(username: string, portal: PortalRole, roleId?: number | string, displayName = username): void {
  sessionStorage.setItem(
    'noc.session',
    JSON.stringify({ username, displayName, portal, role_id: roleId === undefined ? undefined : Number(roleId), loggedInAt: new Date().toISOString() }),
  );
}

export function resetBrowserState(): void {
  localStorage.clear();
  sessionStorage.clear();
}
