import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { applyStoredEvidenceReviewDecisions, getRegisterEntries, persistRegisterEntries } from '@/lib/qbo-evidence-register';

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
    const body = await request.json();
    const realmId = body.realmId;
    const collectionRequestId = body.collectionRequestId;
    const startDate = body.startDate;
    const endDate = body.endDate;

    if (!realmId) {
      return NextResponse.json({ error: 'realmId is required' }, { status: 400 });
    }
    if (realmId !== authenticatedRealmId) {
      return NextResponse.json({ error: 'realmId is not authorized for this account' }, { status: 403 });
    }

    const register = await getRegisterEntries(realmId, collectionRequestId);

    // Persist to database
    await persistRegisterEntries(register, realmId);

    return NextResponse.json({ 
      success: true, 
      count: register.length,
      summary: summarizeRegister(register)
    });
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
