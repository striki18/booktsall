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
            // Cookie writes are unavailable in some Server Component contexts.
          }
        },
      },
    }
  );

  const { data: { user }, error } = await supabase.auth.getUser();
  return { supabase, user: error ? null : user, error };
}

/**
 * Get the current authenticated user from the session.
 * Returns null if no valid session exists.
 */
export async function getCurrentUser() {
  const { user } = await getServerAuth();
  return user ?? null;
}

/**
 * Get the realm ID for the current authenticated user.
 * Returns null if no session or no server-controlled company binding.
 */
export async function getUserRealmId(): Promise<string | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  // Company ownership is written by the server into app_metadata, which users cannot edit.
  return (user.app_metadata?.realm_id as string) || null;
}

export async function requireUser(): Promise<any> {
  const user = await getCurrentUser();
  if (!user) throw new Error('UNAUTHORIZED');
  return user;
}

/**
 * Verify the user is authenticated and optionally owns the given realm.
 * Throws if authentication fails or authorization fails.
 */
export async function requireAuthContext(options?: { realmId?: string }) {
  const { supabase, user } = await getServerAuth();
  if (!user) throw new Error('UNAUTHORIZED');

  const realmId = (user.app_metadata?.realm_id as string) || null;
  if (!realmId) throw new Error('NO_REALM_ID');
  if (options?.realmId && options.realmId !== realmId) throw new Error('FORBIDDEN');

  return { supabase, user, realmId };
}

export async function requireAuth(options?: { realmId?: string }): Promise<{ user: any; realmId: string }> {
  const { user, realmId } = await requireAuthContext(options);
  return { user, realmId };
}
