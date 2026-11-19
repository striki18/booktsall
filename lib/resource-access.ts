import { requireAuthContext } from '@/lib/auth';

/** Verify a caller owns an engagement through the authenticated Supabase session. */
export async function requireOwnedEngagement(engagementId: string) {
  const { supabase, user, realmId } = await requireAuthContext();

  const { data, error } = await supabase
    .from('audit_engagements')
    .select('id')
    .eq('id', engagementId)
    .eq('realm_id', realmId)
    .maybeSingle();

  if (error) throw new Error('OWNERSHIP_LOOKUP_FAILED');
  if (!data) throw new Error('FORBIDDEN');
  return { supabase, user, realmId };
}

/** Resolve and verify ownership of an evidence request's parent engagement. */
export async function requireOwnedEvidenceRequest(evidenceRequestId: string) {
  const { supabase, user, realmId } = await requireAuthContext();

  const { data: requestRow, error: requestError } = await supabase
    .from('evidence_requests')
    .select('engagement_id')
    .eq('id', evidenceRequestId)
    .maybeSingle();
  if (requestError) throw new Error('OWNERSHIP_LOOKUP_FAILED');
  if (!requestRow?.engagement_id) throw new Error('FORBIDDEN');

  const { data: engagement, error: engagementError } = await supabase
    .from('audit_engagements')
    .select('id')
    .eq('id', requestRow.engagement_id)
    .eq('realm_id', realmId)
    .maybeSingle();
  if (engagementError) throw new Error('OWNERSHIP_LOOKUP_FAILED');
  if (!engagement) throw new Error('FORBIDDEN');

  return { supabase, user, realmId, engagementId: requestRow.engagement_id as string };
}

export function ownershipErrorStatus(error: unknown): number | null {
  const code = error instanceof Error ? error.message : '';
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'NO_REALM_ID' || code === 'FORBIDDEN') return 403;
  if (code === 'OWNERSHIP_LOOKUP_FAILED') return 500;
  return null;
}