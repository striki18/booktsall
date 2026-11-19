import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getTransactions, normalizeTransactionList } from '@/lib/quickbooks';
import { getAttachables, normalizeAttachables } from '@/lib/quickbooks';
import { applyStoredEvidenceReviewDecisions, buildQboEvidenceRegister } from '@/lib/qbo-evidence-register';

/**
 * GET /api/evidence/register?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Returns the evidence register – a joined view of transactions and their
 * related attachable documents. The endpoint is the minimal implementation for
 * Phase 4A.
 */
export async function GET(request: Request) {
  try {
    const { realmId } = await requireAuth();
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    if (!startDate || !endDate) {
      return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 });
    }

    // 1. Fetch raw data
    const rawTxns = await getTransactions(startDate, endDate, realmId);
    const rawAttach = await getAttachables(realmId);

    // 2. Normalize
    const txns = normalizeTransactionList(rawTxns);
    const attach = normalizeAttachables(rawAttach);

    // Build the evidence-aware register and overlay durable human decisions.
    const computedRegister = await buildQboEvidenceRegister({
      realmId,
      startDate,
      endDate,
      transactions: txns,
      attachables: attach,
    });
    const register = await applyStoredEvidenceReviewDecisions(computedRegister, realmId);

    return NextResponse.json(register);
  } catch (e: any) {
    console.error('Evidence register error');
    const status = e.message === 'UNAUTHORIZED' ? 401 : e.message === 'NO_REALM_ID' || e.message === 'FORBIDDEN' ? 403 : 500;
    return NextResponse.json({ error: status === 500 ? 'Evidence register request failed' : e.message }, { status });
  }
}
