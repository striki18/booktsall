import { NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/auth';
import { ownershipErrorStatus } from '@/lib/resource-access';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  let context: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    context = await requireAuthContext();
  } catch (error) {
    const status = ownershipErrorStatus(error);
    return NextResponse.json({ error: status === 401 ? 'Authentication required' : 'Forbidden' }, { status: status ?? 500 });
  }

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: 'Invalid evidence rule ID' }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Record<string, unknown>).is_active !== 'boolean') {
    return NextResponse.json({ error: 'A boolean is_active value is required' }, { status: 400 });
  }

  const { data, error } = await context.supabase.from('evidence_requirement_rules')
    .update({ is_active: (body as { is_active: boolean }).is_active })
    .eq('realm_id', context.realmId)
    .eq('id', id)
    .select('id, name, transaction_type, amount_min, amount_max, document_type, is_active, created_at, updated_at')
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'Unable to update evidence rule' }, { status: 503 });
  if (!data) return NextResponse.json({ error: 'Evidence rule not found' }, { status: 404 });
  return NextResponse.json(data);
}
