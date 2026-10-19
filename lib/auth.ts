import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

/**
 * Server-side Supabase client for authentication using cookies.
 * This creates a client that can read the user's session from cookies.
 */
export async function getServerAuth() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: any }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  );

  const { data: { session } } = await supabase.auth.getSession();
  return { supabase, session };
}

/**
 * Get the current authenticated user from the session.
 * Returns null if no valid session exists.
 */
export async function getCurrentUser() {
  const { session } = await getServerAuth();
  return session?.user ?? null;
}

/**
 * Get the realm ID for the current authenticated user.
 * Returns null if no session or no realm_id in user metadata.
 */
export async function getUserRealmId(): Promise<string | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  
  // Check user metadata for realm_id (set during OAuth callback)
  return (user.user_metadata?.realm_id as string) || (user.app_metadata?.realm_id as string) || null;
}

/**
 * Verify the user is authenticated and optionally owns the given realm.
 * Throws if authentication fails or authorization fails.
 */
export async function requireAuth(options?: { realmId?: string }): Promise<{ user: any; realmId: string }> {
  const user = await getCurrentUser();
  
  if (!user) {
    throw new Error('UNAUTHORIZED');
  }
  
  let realmId = options?.realmId ?? await getUserRealmId();
  
  if (!realmId) {
    throw new Error('NO_REALM_ID');
  }
  
  // If realmId was explicitly provided, verify ownership
  if (options?.realmId) {
    const userRealmId = await getUserRealmId();
    if (userRealmId && userRealmId !== options.realmId) {
      throw new Error('FORBIDDEN');
    }
  }
  
  return { user, realmId };
}
