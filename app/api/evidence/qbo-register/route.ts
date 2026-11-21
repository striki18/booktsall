import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { applyStoredEvidenceReviewDecisions, buildQboEvidenceRegister, getRegisterEntries, persistRegisterEntries } from '@/lib/qbo-evidence-register';

/**
 * GET /api/evidence/qbo-register?realmId=...&collectionRequestId=...&startDate=...&endDate=...
 * 
 * Returns the QBO evidence register with 4 final states:
 * - MATCHED: Correct attachment for this transaction
 * - WRONG_MATCHED: Attachment confidently matches a different QBO transaction
 * - MISSING: No supporting document exists for a transaction
 * - REVIEW_REQUIRED: Requires manual review
 */
export async function GET(request: Request) {
  try {
    const { realmId: authenticatedRealmId } = await requireAuth();
    const { searchParams } = new URL(request.url);
    const realmId = searchParams.get('realmId');
    const collectionRequestId = searchParams.get('collectionRequestId') || undefined;
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;

    if (!realmId) {
      return NextResponse.json({ error: 'realmId is required' }, { status: 400 });
    }
    if (realmId !== authenticatedRealmId) {
      return NextResponse.json({ error: 'realmId is not authorized for this account' }, { status: 403 });
    }

    const persistedEntries = await getRegisterEntries(realmId, collectionRequestId, startDate, endDate);
    const register = await applyStoredEvidenceReviewDecisions(persistedEntries, realmId, persistedEntries);

    return NextResponse.json(register);
  } catch (e: any) {
    console.error('QBO evidence register error');
    const status = e.message === 'UNAUTHORIZED' ? 401 : e.message === 'NO_REALM_ID' || e.message === 'FORBIDDEN' ? 403 : 500;
    return NextResponse.json({ error: status === 500 ? 'QBO evidence register request failed' : e.message }, { status });
  }
}

/**
 * POST /api/evidence/qbo-register
 * 
 * Builds and persists the QBO evidence register to the database.
 * Body: { realmId?, collectionRequestId?, startDate?, endDate? }
 */
export async function POST(request: Request) {
  try {
    const { realmId: authenticatedRealmId } = await requireAuth();
    let input: unknown;
    try { input = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return NextResponse.json({ error: 'Invalid register request' }, { status: 400 });
    }
    const { realmId, collectionRequestId, startDate, endDate } = input as Record<string, unknown>;
    if (typeof realmId !== 'string' || !realmId) return NextResponse.json({ error: 'realmId is required' }, { status: 400 });
    if (realmId !== authenticatedRealmId) return NextResponse.json({ error: 'realmId is not authorized for this account' }, { status: 403 });
    const validDate = (value: unknown): value is string => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(value + 'T00:00:00.000Z');
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
      return NextResponse.json({ error: 'A valid startDate and endDate are required' }, { status: 400 });
    }
    if (collectionRequestId !== undefined) {
      if (typeof collectionRequestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(collectionRequestId)) {
        return NextResponse.json({ error: 'Invalid collection request ID' }, { status: 400 });
      }
      const { data: ownedRequest, error: ownershipError } = await supabaseAdmin.from('collection_requests')
        .select('id').eq('id', collectionRequestId).eq('realm_id', realmId).maybeSingle();
      if (ownershipError) return NextResponse.json({ error: 'Unable to verify collection ownership' }, { status: 503 });
      if (!ownedRequest) return NextResponse.json({ error: 'Collection request is not authorized' }, { status: 403 });
    }
    const computed = await buildQboEvidenceRegister({ realmId, startDate, endDate, collectionRequestId: collectionRequestId as string | undefined });
    await persistRegisterEntries(computed, realmId);
    const persisted = await getRegisterEntries(realmId, collectionRequestId as string | undefined, startDate, endDate);
    const register = await applyStoredEvidenceReviewDecisions(persisted, realmId, persisted);
    return NextResponse.json({ success: true, count: register.length, summary: summarizeRegister(register), register });
  } catch (e: any) {
    console.error('QBO evidence register persist error');
    const status = e.message === 'UNAUTHORIZED' ? 401 : e.message === 'NO_REALM_ID' || e.message === 'FORBIDDEN' ? 403 : 500;
    return NextResponse.json({ error: status === 500 ? 'QBO evidence register request failed' : e.message }, { status });
  }
}

function summarizeRegister(entries: any[]) {
  const summary: Record<string, number> = {
    MATCHED: 0,
    WRONG_MATCHED: 0,
    MISSING: 0,
    REVIEW_REQUIRED: 0,
  };
  
  for (const entry of entries) {
    if (entry.registerState && summary[entry.registerState] !== undefined) {
      summary[entry.registerState]++;
    }
  }
  
  return summary;
}
