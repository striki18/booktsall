import { NextResponse } from 'next/server';
import { getStoredToken } from '@/lib/quickbooks';
import { requireUser } from '@/lib/auth';

/** Returns non-secret connection status for the signed-in company. */
export async function GET() {
  try {
    const user = await requireUser();
    const realmId = (user.app_metadata?.realm_id as string) || null;
    if (!realmId) {
      return NextResponse.json({ error: 'No QuickBooks connection found for this account' }, { status: 404 });
    }
    const token = await getStoredToken(realmId);
    if (!token || token.realm_id !== realmId) {
      return NextResponse.json({ error: 'No QuickBooks connection found for this account' }, { status: 404 });
    }
    return NextResponse.json({ realm_id: token.realm_id, expires_at: token.expires_at });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'UNAUTHORIZED') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    console.error('QuickBooks token status failed:', code || 'Unknown error');
    return NextResponse.json({ error: 'Unable to read QuickBooks connection status' }, { status: 500 });
  }
}