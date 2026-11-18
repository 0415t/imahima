import { isAuthApiError, isAuthError } from '@supabase/supabase-js';
import { requestStep } from './timeouts';

type IdentityLookup = (token: string) => Promise<{ userId: string | null; error: unknown | null }>;
type Authentication = { userId: string; status: 200 } | { userId: null; status: 401 | 503 };

// Classify only errors from the trusted Auth lookup, never request-supplied data.
// Unknown errors and contradictory status/code combinations fail closed as 503.
export function authenticationErrorStatus(error: unknown): 401 | 503 {
  if (!isAuthError(error)) return 503;
  if (error.status === 400 && (error.name === 'AuthSessionMissingError' || error.name === 'AuthInvalidJwtError')) return 401;
  if (!isAuthApiError(error)) return 503;
  const credentialCodes = ['bad_jwt', 'no_authorization', 'user_not_found', 'session_not_found', 'session_expired'];
  if ([400, 401, 403].includes(error.status) &&
      (credentialCodes.includes(error.code ?? '') || (error.status === 401 && error.code === undefined))) return 401;
  return 503;
}

export async function authenticate(lookup: IdentityLookup, token: string): Promise<Authentication> {
  try {
    const result = await requestStep(() => lookup(token));
    if (result.error) return { userId: null, status: authenticationErrorStatus(result.error) };
    if (typeof result.userId === 'string' && result.userId.length > 0) return { userId: result.userId, status: 200 };
    return { userId: null, status: 503 };
  } catch (error) {
    return { userId: null, status: authenticationErrorStatus(error) };
  }
}
