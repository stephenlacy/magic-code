export interface User {
  email: string;
}

export interface MagicCode {
  id: number;
  user_id: string;
  code: string;
  website: string;
  created_at: number;
}

export enum AuthStatus {
  LOADING = 'loading',
  AUTHENTICATED = 'authenticated',
  UNAUTHENTICATED = 'unauthenticated'
}