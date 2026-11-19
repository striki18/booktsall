import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getTransactions } from '@/lib/quickbooks';

/**
 * GET /api/quickbooks/transactions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Returns the TransactionList report from QuickBooks for the given range.
 * This endpoint is added solely for Phase 2A verification and can be removed later.
 */
export async function GET(request: Request) {
  try {
    const { realmId } = await requireAuth();
    const url = new URL(request.url);
    const startDate = url.searchParams.get('startDate') ?? '2023-01-01';
    const endDate = url.searchParams.get('endDate') ?? '2023-01-31';

  // Normalize the report for the API response without logging transaction data.
  const rawReport = await getTransactions(startDate, endDate, realmId);
  // Import the normalization helper directly to avoid an extra round‑trip.
  // The function is exported from `lib/quickbooks.ts`.
  const { normalizeTransactionList } = await import("@/lib/quickbooks");
  const normalized = normalizeTransactionList(rawReport);
  return NextResponse.json(normalized);
  } catch (e: any) {
    console.error('TransactionReport error');
    const status = e.message === 'UNAUTHORIZED' ? 401 : e.message === 'NO_REALM_ID' || e.message === 'FORBIDDEN' ? 403 : 500;
    return NextResponse.json({ error: status === 500 ? 'QuickBooks request failed' : e.message }, { status });
  }
}
