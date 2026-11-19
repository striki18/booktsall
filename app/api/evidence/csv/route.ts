import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getTransactions, normalizeTransactionList } from '@/lib/quickbooks';
import { getAttachables, normalizeAttachables } from '@/lib/quickbooks';
import { applyStoredEvidenceReviewDecisions, buildQboEvidenceRegister } from '@/lib/qbo-evidence-register';
import { generateAndSaveCsvs } from '@/lib/output';

/**
 * GET /api/evidence/csv?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Generates evidence_register.csv and missing_documents.csv from the evidence register.
 * Saves them to the company output directory.
 */
export async function GET(request: Request) {
  try {
    const { realmId } = await requireAuth();
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: 'startDate and endDate are required' },
        { status: 400 }
      );
    }

    // 1. Fetch raw data
    const rawTxns = await getTransactions(startDate, endDate, realmId);
    const rawAttach = await getAttachables(realmId);

    // 2. Normalize
    const txns = normalizeTransactionList(rawTxns);
    const attach = normalizeAttachables(rawAttach);

    // 3. Build the evidence-aware register and overlay durable human decisions
    const computedRegister = await buildQboEvidenceRegister({
      realmId,
      startDate,
      endDate,
      transactions: txns,
      attachables: attach,
    });
    const register = await applyStoredEvidenceReviewDecisions(computedRegister, realmId);

    // 4. Generate and save CSVs
    const result = await generateAndSaveCsvs(register, realmId, startDate, endDate);

    return NextResponse.json({
      success: true,
      evidenceRegisterPath: result.evidenceRegisterPath,
      missingDocumentsPath: result.missingDocumentsPath,
      matchedCount: result.matchedCount,
      missingCount: result.missingCount,
    });
  } catch (e: any) {
    console.error('CSV generation error');
    const status = e.message === 'UNAUTHORIZED' ? 401 : e.message === 'NO_REALM_ID' || e.message === 'FORBIDDEN' ? 403 : 500;
    return NextResponse.json({ error: status === 500 ? 'CSV generation failed' : e.message }, { status });
  }
}
