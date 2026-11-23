import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { downloadAttachableBytes, getAttachables, normalizeAttachables } from '@/lib/quickbooks';

/**
 * GET /api/quickbooks/attachables/[attachableId]/download
 * Streams a single attachment file from QuickBooks with the naming convention:
 * {txnType}_{docNumber}_{originalFileName}
 * 
 * Phase 5C: Returns structured response with failed[] array instead of throwing 500
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ attachableId: string }> }
) {
  try {
    const { realmId } = await requireAuth();
    const { attachableId } = await params;

    // 1. Get all attachables to find the matching one and its metadata
    const raw = await getAttachables(realmId);
    const normalized = normalizeAttachables(raw?.attachables ?? []);
    
    const attachable = normalized.find(a => a.attachableId === attachableId);
    if (!attachable) {
      // Phase 5C: Log and return structured failure with failed[] array
      console.error(`Download failed for attachableId=${attachableId}: Attachable not found`);
      const failedEntry = {
        success: false,
        error: 'Attachable not found',
        attachableId,
        fileName: 'unknown',
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json({
        success: false,
        error: 'Attachable not found',
        attachableId,
        fileName: 'unknown',
        timestamp: new Date().toISOString(),
        failed: [failedEntry],
      }, { status: 200 }); // Return 200 with failure info instead of 404
    }

    // 2. Get the evidence register to find txnType and docNumber for this attachable
    const url = new URL(request.url);
    const startDate = url.searchParams.get('startDate');
    const endDate = url.searchParams.get('endDate');

    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: 'startDate and endDate query parameters are required' },
        { status: 400 }
      );
    }

    // 3. Build evidence register to get txnType and docNumber
    const { getTransactions, normalizeTransactionList } = await import('@/lib/quickbooks');
    const { buildEvidenceRegister } = await import('@/lib/evidence');
    
    const rawTransactions = await getTransactions(startDate, endDate, realmId);
    const transactions = normalizeTransactionList(rawTransactions);
    const register = buildEvidenceRegister(transactions, normalized);

    // Find the matched record for this attachable
    const matchedRecord = register.find((m: any) => m.attachableId === attachableId);
    
    let txnType = 'Unknown';
    let docNumber = 'Unknown';
    
    if (matchedRecord && matchedRecord.txnType && matchedRecord.docNumber) {
      txnType = matchedRecord.txnType;
      docNumber = matchedRecord.docNumber;
    } else if (attachable.orphaned) {
      // For orphaned attachments, use a default
      txnType = 'Orphaned';
      docNumber = 'N/A';
    }

    // 4. Generate the new filename: {txnType}_{docNumber}_{originalFileName}
    // Sanitize filename components to remove invalid characters (e.g., / in "N/A")
    const sanitize = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_');
    const originalFileName = attachable.fileName || 'unknown';
    const newFileName = `${sanitize(txnType)}_${sanitize(docNumber)}_${originalFileName}`;

    // 5. Stream bytes to the caller. A server-local file path is unusable to a
    // browser and fails on read-only/serverless application filesystems.
    const { bytes } = await downloadAttachableBytes(attachableId, realmId);
    const encodedName = encodeURIComponent(newFileName).replace(/'/g, '%27');
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': attachable.contentType || 'application/octet-stream',
        'content-length': String(bytes.length),
        'content-disposition': `attachment; filename*=UTF-8''${encodedName}`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (e: any) {
    console.error('Download endpoint error');
    const status = e.message === 'UNAUTHORIZED' ? 401 : e.message === 'NO_REALM_ID' || e.message === 'FORBIDDEN' ? 403 : 500;
    if (status !== 500) return NextResponse.json({ error: e.message }, { status });
    const { attachableId } = await params;
    return NextResponse.json({
      success: false,
      error: 'QuickBooks download failed',
      attachableId,
      fileName: 'unknown',
      timestamp: new Date().toISOString(),
      failed: [{
        success: false,
        error: 'QuickBooks download failed',
        attachableId,
        fileName: 'unknown',
        timestamp: new Date().toISOString(),
      }],
    }, { status });
  }
}
