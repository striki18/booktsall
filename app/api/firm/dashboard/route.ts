import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';

type CompanyMembership = {
  realm_id: string;
  company_name: string | null;
  created_at: string;
};

export async function GET() {
  try {
    const user = await requireUser();
    const { data: memberships, error: membershipError } = await supabaseAdmin
      .from('qbo_company_memberships')
      .select('realm_id, company_name, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });

    if (membershipError) return NextResponse.json({ error: 'Unable to load company access' }, { status: 500 });

    const companies = await Promise.all(((memberships ?? []) as CompanyMembership[]).map(async (membership) => {
      const [tokenResult, registerResult, inboxResult] = await Promise.all([
        supabaseAdmin.from('quickbooks_tokens').select('expires_at').eq('realm_id', membership.realm_id).maybeSingle(),
        supabaseAdmin.from('qbo_evidence_register').select('register_state').eq('realm_id', membership.realm_id),
        supabaseAdmin.from('inbox_documents').select('processing_status').eq('realm_id', membership.realm_id).is('archived_at', null),
      ]);

      const registerRows = registerResult.data ?? [];
      const inboxRows = inboxResult.data ?? [];
      const counts = registerRows.reduce<Record<string, number>>((result, row) => {
        const state = typeof row.register_state === 'string' ? row.register_state : 'UNKNOWN';
        result[state] = (result[state] ?? 0) + 1;
        return result;
      }, {});
      const expiresAt = tokenResult.data?.expires_at ?? null;
      const tokenValid = typeof expiresAt === 'string' && Date.parse(expiresAt) > Date.now();
      const dataAvailable = !registerResult.error && !inboxResult.error;

      return {
        realmId: membership.realm_id,
        companyName: membership.company_name || `Company ${membership.realm_id}`,
        connectedAt: membership.created_at,
        active: user.app_metadata?.realm_id === membership.realm_id,
        connection: tokenResult.error ? 'unknown' : tokenValid ? 'connected' : 'needs_attention',
        expiresAt,
        dataAvailable,
        transactions: registerRows.length,
        matched: counts.MATCHED ?? 0,
        missing: counts.MISSING ?? 0,
        reviewRequired: (counts.REVIEW_REQUIRED ?? 0) + (counts.FLAGGED ?? 0) + (counts.DUPLICATE ?? 0),
        wrongMatched: counts.WRONG_MATCHED ?? 0,
        inboxDocuments: inboxRows.length,
        processingDocuments: inboxRows.filter((row) => row.processing_status === 'pending' || row.processing_status === 'processing').length,
      };
    }));

    return NextResponse.json({ companies });
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    console.error('Firm dashboard failed');
    return NextResponse.json({ error: 'Unable to load firm dashboard' }, { status: 500 });
  }
}
