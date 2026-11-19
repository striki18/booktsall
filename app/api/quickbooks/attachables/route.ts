import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAttachables, normalizeAttachables } from '@/lib/quickbooks';

/**
 * GET /api/quickbooks/attachables – returns the raw Attachable records from QuickBooks.
 * This endpoint is used by the front‑end to fetch supporting documents (e.g., receipts).
 */
export async function GET(request: Request) {
  try {
    const { realmId } = await requireAuth();
    // Read only the authenticated company.
  const raw = await getAttachables(realmId);
  // Normalize the attachable records as required by Phase 3C.
  const normalized = normalizeAttachables(raw?.attachables ?? []);
  // Return the normalized attachable records.
  return NextResponse.json(normalized);
  } catch (e: any) {
    console.error('Attachables endpoint error');
    const status = e.message === 'UNAUTHORIZED' ? 401 : e.message === 'NO_REALM_ID' || e.message === 'FORBIDDEN' ? 403 : 500;
    return NextResponse.json({ error: status === 500 ? 'QuickBooks request failed' : e.message }, { status });
  }
};
