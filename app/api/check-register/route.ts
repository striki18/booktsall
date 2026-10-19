import { NextResponse, NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAuth } from '@/lib/auth';

/**
 * GET /api/check-register
 *
 * Returns QBO evidence register statistics for the authenticated user's realm.
 * Requires authentication and realm ownership verification.
 *
 * Query params:
 *   - realmId (optional): Specific realm to check (defaults to user's realm)
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Authentication & Authorization check
    const { realmId } = await requireAuth();

    // 2. Get realm from query param (optional override)
    const searchParams = request.nextUrl.searchParams;
    const requestedRealmId = searchParams.get('realmId') || realmId;

    if (!requestedRealmId) {
      return NextResponse.json(
        { error: 'No realm ID available. Provide realmId query param or ensure session has realmId.' },
        { status: 400 }
      );
    }

    // 3. Authorization: Verify user owns this realm
    if (realmId !== requestedRealmId) {
      return NextResponse.json({ error: 'Forbidden: Cannot access other realm data' }, { status: 403 });
    }

    const { data, error } = await supabaseAdmin
      .from('qbo_evidence_register')
      .select('*')
      .eq('realm_id', requestedRealmId);

    if (error) {
      console.error('Check-register query error:', error);
      return NextResponse.json({ error: 'Database query failed' }, { status: 500 });
    }

    const states: Record<string, number> = {};
    data.forEach(d => { states[d.register_state] = (states[d.register_state] || 0) + 1; });

    const txn145 = data.find(d => d.qbo_txn_id === '145' || d.qbo_txn_id === 145);

    return NextResponse.json({
      totalRows: data.length,
      states,
      transaction145: txn145 || null,
      allRows: data.map(d => ({
        qbo_txn_id: d.qbo_txn_id,
        qbo_txn_date: d.qbo_txn_date,
        register_state: d.register_state,
      })),
    });
  } catch (e: any) {
    // Handle auth errors specifically
    if (e.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (e.message === 'NO_REALM_ID') {
      return NextResponse.json({ error: 'No realm ID associated with user' }, { status: 400 });
    }
    if (e.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'Forbidden: Cannot access other realm data' }, { status: 403 });
    }
    console.error('Check-register unexpected error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
