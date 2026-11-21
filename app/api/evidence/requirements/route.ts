import { NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/auth';
import { ownershipErrorStatus } from '@/lib/resource-access';

const RULE_FIELDS = 'id, name, transaction_type, amount_min, amount_max, document_type, is_active, created_at, updated_at';

function authError(error: unknown) {
  const status = ownershipErrorStatus(error);
  if (!status) return null;
  return NextResponse.json({ error: status === 401 ? 'Authentication required' : 'Forbidden' }, { status });
}

function parseAmount(value: unknown): { valid: boolean; value: number | null } {
  if (value === null || value === undefined || value === '') return { valid: true, value: null };
  if (typeof value !== 'number' && typeof value !== 'string') return { valid: false, value: null };
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? { valid: true, value: parsed } : { valid: false, value: null };
}

export async function GET() {
  let context: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    context = await requireAuthContext();
  } catch (error) {
    return authError(error) ?? NextResponse.json({ error: 'Unable to authenticate' }, { status: 500 });
  }

  const { data, error } = await context.supabase.from('evidence_requirement_rules')
    .select(RULE_FIELDS)
    .eq('realm_id', context.realmId)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'Unable to load evidence rules' }, { status: 503 });
  return NextResponse.json(data ?? []);
}

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    context = await requireAuthContext();
  } catch (error) {
    return authError(error) ?? NextResponse.json({ error: 'Unable to authenticate' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid evidence rule' }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const transactionType = typeof payload.transaction_type === 'string' ? payload.transaction_type.trim() : '';
  const rawDocumentType = typeof payload.document_type === 'string' ? payload.document_type.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  const minimum = parseAmount(payload.amount_min);
  const maximum = parseAmount(payload.amount_max);
  if (
    !name || name.length > 120 ||
    !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(transactionType) ||
    !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(rawDocumentType) ||
    !minimum.valid || !maximum.valid ||
    (minimum.value !== null && maximum.value !== null && minimum.value > maximum.value)
  ) {
    return NextResponse.json({ error: 'Provide a rule name, transaction type, valid amount range, and document type' }, { status: 400 });
  }

  const { data, error } = await context.supabase.from('evidence_requirement_rules')
    .insert({
      realm_id: context.realmId,
      created_by: context.user.id,
      name,
      transaction_type: transactionType,
      amount_min: minimum.value,
      amount_max: maximum.value,
      document_type: rawDocumentType,
      is_active: true,
    })
    .select(RULE_FIELDS)
    .single();
  if (error || !data) return NextResponse.json({ error: 'Unable to save evidence rule' }, { status: 503 });
  return NextResponse.json(data, { status: 201 });
}
