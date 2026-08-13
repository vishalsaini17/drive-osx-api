export interface UserRow {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  full_name: string;
  recovery_email: string | null;
  mobile: string | null;
  password_hash: string;
  avatar_url: string | null;
  status: 'active' | 'suspended' | 'deleted';
  primary_organization_id: string | null;
  current_organization_id: string | null;
  mfa_enabled: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Public user shape. Field names are kept stable for existing clients. */
export interface UserView {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  recoveryEmail: string | null;
  mobile: string | null;
  avatarUrl: string | null;
  organizationId: string | null;
  createdAt: string;
}

export function toUserView(row: UserRow): UserView {
  return {
    id: row.id,
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.full_name,
    email: row.email,
    recoveryEmail: row.recovery_email,
    mobile: row.mobile,
    avatarUrl: row.avatar_url,
    organizationId: row.current_organization_id ?? row.primary_organization_id,
    createdAt: row.created_at.toISOString(),
  };
}

export interface SessionRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface AuthResult {
  token: string;
  refreshToken: string;
  expiresIn: number;
  user: UserView;
}
