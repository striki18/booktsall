import { NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/auth';

/** Return canonical package runs and retain unlinked historical package records. */
export async function GET() {
  try {
    const { realmId, supabase } = await requireAuthContext();
    const { data: engagements, error: engagementError } = await supabase
      .from('audit_engagements')
      .select('id')
      .eq('realm_id', realmId);
    if (engagementError) throw engagementError;

    const engagementIds = (engagements ?? []).map((engagement: { id: string }) => engagement.id);
    let historicalPackages: any[] = [];
    if (engagementIds.length > 0) {
      const { data, error } = await supabase
        .from('evidence_packages')
        .select('id, engagement_id, status, created_at, zip_path, generated_package_id')
        .in('engagement_id', engagementIds)
        .is('generated_package_id', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      historicalPackages = (data ?? []).map((row: any) => ({ ...row, source_type: 'legacy_engagement' }));
    }

    const { data: packageRuns, error: packageError } = await supabase
      .from('generated_evidence_packages')
      .select('id, realm_id, source_type, engagement_id, status, created_at, zip_path, filename, start_date, end_date, stats, manifest, error_summary, package_version, previous_package_id')
      .eq('realm_id', realmId)
      .order('created_at', { ascending: false });
    if (packageError) throw packageError;

    const history = [...historicalPackages, ...(packageRuns ?? [])]
      .sort((left: any, right: any) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
    return NextResponse.json(history);
  } catch (error) {
    const status = error instanceof Error && error.message === 'UNAUTHORIZED' ? 401 : error instanceof Error && (error.message === 'NO_REALM_ID' || error.message === 'FORBIDDEN') ? 403 : 500;
    if (status !== 500) return NextResponse.json({ error: status === 401 ? 'Authentication required' : 'Forbidden' }, { status });
    console.error('Unexpected error in evidence history API');
    return NextResponse.json({ error: 'Failed to load evidence packages' }, { status: 500 });
  }
}