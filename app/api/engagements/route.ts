import { NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/auth';
function authFailure(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'UNAUTHORIZED') {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  if (code === 'NO_REALM_ID' || code === 'FORBIDDEN') {
    return NextResponse.json({ error: 'No authorized QuickBooks company is connected' }, { status: 403 });
  }
  return null;
}

/** POST /api/engagements – create a new audit engagement */
export async function POST(request: Request) {
  try {
    // Read raw request body and attempt to parse JSON.
    const raw = await request.text();
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      // Attempt a tolerant parse: add quotes around unquoted keys.
      const tolerant = raw.replace(/([a-zA-Z0-9_]+):/g, '"$1":');
      try {
        payload = JSON.parse(tolerant);
      } catch (e) {
        console.error('Failed to parse JSON payload (even tolerant):', raw);
        throw new Error('Invalid JSON payload');
      }
    }
    const { realmId: authenticatedRealmId, supabase } = await requireAuthContext();
    const {
      realm_id,
      company_name,
      audit_type,
      start_date,
      end_date,
    } = payload;

    if (!realm_id || !company_name || !audit_type || !start_date || !end_date) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (realm_id !== authenticatedRealmId) {
      return NextResponse.json({ error: 'realm_id is not authorized for this account' }, { status: 403 });
    }

    // Check for existing draft engagement with same parameters to avoid duplicates.
    const { data: existing, error: existingErr } = await supabase
      .from('audit_engagements')
      .select('*')
      .eq('realm_id', realm_id)
      .eq('audit_type', audit_type)
      .eq('start_date', start_date)
      .eq('end_date', end_date)
      .eq('status', 'draft')
      .single();
    if (existingErr && existingErr.code !== 'PGRST116') {
      // PGRST116 = No rows found – ignore.
      throw existingErr;
    }
    if (existing) {
      // Return the existing engagement instead of creating a new one.
      return NextResponse.json(existing);
    }

    // Insert the new engagement.
    const { data, error } = await supabase
      .from('audit_engagements')
      .insert([
        {
          realm_id,
          company_name,
          audit_type,
          start_date,
          end_date,
        },
      ])
      .select();
    if (error) throw error;
    if (!data || (Array.isArray(data) && data.length === 0)) {
      console.warn('Supabase insert returned no data; returning request payload');
      return NextResponse.json({
        realm_id,
        company_name,
        audit_type,
        start_date,
        end_date,
        status: 'draft',
      });
    }
    const inserted = data as any[];
    const newEngagement = inserted[0];

    // ----- Evidence Plan generation -----
    // Check if evidence already exists for this engagement (duplicate protection).
    const { data: existingPlan } = await supabase
      .from('audit_evidence_plan')
      .select('id')
      .eq('engagement_id', newEngagement.id);
    if (existingPlan && existingPlan.length > 0) {
      // Evidence already generated; skip generation.
      return NextResponse.json(newEngagement);
    }

    // Fetch all catalog items ordered by display_order.
    const { data: catalog, error: catalogErr } = await supabase
      .from('audit_evidence_catalog')
      .select('id')
      .order('display_order', { ascending: true });
    if (catalogErr) {
      // Roll back engagement creation.
      await supabase.from('audit_engagements').delete().eq('id', newEngagement.id);
      throw catalogErr;
    }

    // Prepare evidence plan rows.
  const planRows = (catalog as any[]).map(item => ({
    engagement_id: newEngagement.id,
    catalog_id: item.id,
    status: 'requested',
  }));

    // Insert evidence plan rows.
    const { error: planErr } = await supabase.from('audit_evidence_plan').insert(planRows);
    if (planErr) {
      // Roll back engagement creation.
      await supabase.from('audit_engagements').delete().eq('id', newEngagement.id);
      throw planErr;
    }

    // Return the newly created engagement.
    return NextResponse.json(newEngagement);
  } catch (e: any) {
    const authResponse = authFailure(e);
    if (authResponse) return authResponse;
    console.error('Create engagement error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** GET /api/engagements – list engagements for the authenticated company */
export async function GET() {
  try {
    const { realmId, supabase } = await requireAuthContext();
    const { data, error } = await supabase
      .from('audit_engagements')
      .select('*')
      .eq('realm_id', realmId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error: any) {
    const authResponse = authFailure(error);
    if (authResponse) return authResponse;
    console.error('Fetch engagements error:', error);
    return NextResponse.json({ error: 'Failed to fetch engagements' }, { status: 500 });
  }
}