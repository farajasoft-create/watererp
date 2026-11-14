export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  twoFactorEnabled?: boolean;
  /** The organisation requires two-step sign-in and this user has not set it up. */
  mustEnrolTwoFactor?: boolean;
  /** The user's role in each module they can use. */
  access: { module: string; role: string; roleLabel: string; scope: string[] }[];
  /** Modules switched on for the organisation. */
  modules: string[];
  permissions: string[];
  organisation: { id: string; name: string; code: string; currency: string } | null;
}
