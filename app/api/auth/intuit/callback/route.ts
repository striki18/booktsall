import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { cookies } from 'next/headers';
import { requireUser } from '@/lib/auth';

/**
 * Helper to exchange authorization code for tokens using PKCE.
 */
async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string
) {
  const clientId = process.env.INTUIT_CLIENT_ID!;
  const clientSecret = process.env.INTUIT_CLIENT_SECRET!;
  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${authHeader}`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${txt}`);
  }
  return res.json();
}

export async function GET(request: Request) {
  let user: any;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const realmId = url.searchParams.get('realmId');

  if (!code || !state || !realmId) {
    return NextResponse.json({ error: 'Missing required query parameters' }, { status: 400 });
  }

  const expectedRealmId = process.env.INTUIT_REALM_ID;
  if (!expectedRealmId || realmId !== expectedRealmId) {
    return NextResponse.json({ error: 'QuickBooks company is not authorized' }, { status: 403 });
  }

  // Retrieve cookies from the request (async in Next.js). Await the Promise as required by Next.js 16.
  const cookieStore = await cookies();
  const storedState = cookieStore.get('intuit_oauth_state')?.value;
  const codeVerifier = cookieStore.get('intuit_code_verifier')?.value;

  // Temporary server‑side logging for debugging the OAuth flow

  if (state !== storedState) {
    return NextResponse.json({ error: 'Invalid OAuth state' }, { status: 400 });
  }
  if (!codeVerifier) {
    return NextResponse.json({ error: 'Missing PKCE verifier' }, { status: 400 });
  }

  try {
    const tokenData = await exchangeCode(code, codeVerifier, process.env.INTUIT_REDIRECT_URI!);
  const expiresIn = Number(tokenData.expires_in);
  // Store expires_at as an ISO timestamp string (compatible with the
  // timestamp with time zone column). Previously we stored epoch seconds,
  // which caused a "date/time field value out of range" error after the
  // migration changed the column type.
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Upsert token row in Supabase
    const { error } = await supabaseAdmin
      .from('quickbooks_tokens')
      .upsert({
        realm_id: realmId,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
      }, { onConflict: 'realm_id' });

    if (error) {
      console.error('Supabase upsert error:', error);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    const { error: membershipError } = await supabaseAdmin
      .from('qbo_company_memberships')
      .upsert({ user_id: user.id, realm_id: realmId }, { onConflict: 'user_id,realm_id' });
    if (membershipError) throw membershipError;

    // Bind the selected company to server-controlled user metadata.
    const realmIds = new Set<string>([
      ...(Array.isArray(user.app_metadata?.qbo_realm_ids) ? user.app_metadata.qbo_realm_ids : []),
      ...(typeof user.app_metadata?.realm_id === 'string' ? [user.app_metadata.realm_id] : []),
      realmId,
    ]);
    const { error: metadataError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...user.app_metadata, realm_id: realmId, qbo_realm_ids: [...realmIds] },
    });
    if (metadataError) throw metadataError;

    // Clear cookies
    // Use an absolute URL for the redirect as required by Next.js 16.
    const resp = NextResponse.redirect(new URL('/quickbooks', request.url));
    resp.cookies.delete('intuit_oauth_state');
    resp.cookies.delete('intuit_code_verifier');
    return resp;
  } catch (e: any) {
    // Report failure explicitly; never make a failed OAuth exchange look successful.
    console.error('OAuth callback failed');
    const failureUrl = new URL('/quickbooks', request.url);
    failureUrl.searchParams.set('oauth', 'failed');
    const resp = NextResponse.redirect(failureUrl);
    resp.cookies.delete('intuit_oauth_state');
    resp.cookies.delete('intuit_code_verifier');
    return resp;
  }
}
