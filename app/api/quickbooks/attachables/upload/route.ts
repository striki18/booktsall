import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { QboAttachmentWorkflowError, uploadFirstEvidenceItemToQbo } from '@/lib/qbo-attachment-workflow';

export async function POST(request: Request) {
  let auth: { user: { id: string }; realmId: string };
  try {
    auth = await requireAuth();
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const status = code === 'UNAUTHORIZED' ? 401 : 403;
    return NextResponse.json({ error: status === 401 ? 'Authentication required' : 'No authorized QuickBooks company is connected' }, { status });
  }

  let body: { evidenceItemId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.evidenceItemId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.evidenceItemId)) {
    return NextResponse.json({ error: 'A valid evidenceItemId is required' }, { status: 400 });
  }

  try {
    const result = await uploadFirstEvidenceItemToQbo({
      evidenceItemId: body.evidenceItemId,
      realmId: auth.realmId,
      actorUserId: auth.user.id,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof QboAttachmentWorkflowError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('QuickBooks evidence attachment workflow failed');
    return NextResponse.json({ error: 'Evidence attachment could not be completed' }, { status: 500 });
  }
}
