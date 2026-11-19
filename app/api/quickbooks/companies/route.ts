import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';

export async function GET() {
  try {
    const user = await requireUser();
    const { data, error } = await supabaseAdmin
      .from('qbo_company_memberships')
      .select('realm_id, company_name, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    if (error) return NextResponse.json({ error: 'Unable to load connected companies' }, { status: 500 });
    return NextResponse.json({ companies: data ?? [], activeRealmId: user.app_metadata?.realm_id ?? null });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'UNAUTHORIZED') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    console.error('QuickBooks company list failed');
    return NextResponse.json({ error: 'Unable to load connected companies' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    let body: { realmId?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (typeof body.realmId !== 'string' || body.realmId.trim() === '') {
      return NextResponse.json({ error: 'realmId is required' }, { status: 400 });
    }
    const realmId = body.realmId.trim();
    const { data: membership, error: membershipError } = await supabaseAdmin
      .from('qbo_company_memberships')
      .select('realm_id')
      .eq('user_id', user.id)
      .eq('realm_id', realmId)
      .maybeSingle();
    if (membershipError) return NextResponse.json({ error: 'Unable to verify company access' }, { status: 500 });
    if (!membership) return NextResponse.json({ error: 'Company is not connected to this account' }, { status: 403 });

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...user.app_metadata, realm_id: realmId },
    });
    if (updateError) return NextResponse.json({ error: 'Unable to switch company' }, { status: 500 });
    return NextResponse.json({ activeRealmId: realmId }, { status: 200 });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'UNAUTHORIZED') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    console.error('QuickBooks company switch failed');
    return NextResponse.json({ error: 'Unable to switch company' }, { status: 500 });
  }
}
