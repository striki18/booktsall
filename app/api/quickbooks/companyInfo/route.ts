import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getCompanyInfo } from '@/lib/quickbooks';

/** GET /api/quickbooks/companyInfo – returns the connected company's info. */
export async function GET() {
  try {
    const { realmId } = await requireAuth();
    const data = await getCompanyInfo(realmId);
    return NextResponse.json(data);
  } catch (e: any) {
    const status = e.message === 'UNAUTHORIZED' ? 401 : e.message === 'NO_REALM_ID' || e.message === 'FORBIDDEN' ? 403 : 500;
    return NextResponse.json({ error: status === 500 ? 'QuickBooks request failed' : e.message }, { status });
  }
}
