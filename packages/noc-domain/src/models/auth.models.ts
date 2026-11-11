export type PortalRole = 'citizen' | 'dept' | 'admin';

/** Department role id (dept_roles.id) — the legacy RoleStatuses.txt keys 1-10. */
export type DeptRoleId = number;

/**
 * A login account (citizen, department user or admin) as the API returns it.
 * Passwords never leave the server.
 */
export interface UserAccount {
  id: number;
  username: string;
  displayName: string;
  portal: PortalRole;
  email: string;
  mobile: string;
  active: boolean;
  created_on: string;
  /** The account must choose its own password at the next sign-in. */
  must_change_password?: boolean;

  // Citizen profile (legacy register.aspx fields)
  gender?: string;
  dob?: string;
  /** Last four digits only (the full number is never stored). */
  aadhar_last4?: string;
  address?: string;

  // Department user attributes
  role_id?: DeptRoleId;
  /** District of jurisdiction (0 / undefined = HQ / state-wide). */
  district?: number;
  /**
   * Fire stations the officer is associated with. The officers of an application's workflow are the
   * officers of each designation associated with the fire station under which the property comes.
   */
  fire_station_ids?: number[];
  /** Associated with every fire station (Head Office officers). */
  all_stations?: boolean;
}

/** @deprecated kept as an alias for older code/tests — use UserAccount. */
export type SeedUser = UserAccount;

export interface Session {
  username: string;
  displayName: string;
  portal: PortalRole;
  role_id?: DeptRoleId;
  loggedInAt: string;
}

export interface LoginResult {
  success: boolean;
  error?: string;
  landing?: string;
  session?: Session;
}

export interface RegistrationRequest {
  name: string;
  mobile: string;
  email: string;
  gender: string;
  dob: string;
  aadhar: string;
  address: string;
}

export interface RegistrationResult {
  success: boolean;
  error?: string;
  username?: string;
  /**
   * Development builds only: the "set your password" link that is e-mailed to
   * the applicant (in production it is only e-mailed).
   */
  setPasswordUrl?: string;
}
