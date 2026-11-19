import { NextResponse, NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { persistPipelinePackage } from '@/lib/package-persistence';
import { generatePackage } from '@/lib/pipeline';
import { getStoredToken } from '@/lib/quickbooks';
import { requireAuth } from '@/lib/auth';

/**
 * POST /api/generate
 *
 * Generates an audit package by invoking the existing Phase 8 pipeline.
 * Request body must contain:
 *   { "companyId": "string", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" }
 *
 * A signed-in user may generate a package only for their authorized QuickBooks realm.
 *
 * Returns structured JSON with package information on success,
 * or structured error responses for validation/pipeline failures.
 */
export async function POST(request: NextRequest) {
  // 1. Validate HTTP method (Next.js handles this, but explicit check for safety)
  if (request.method !== 'POST') {
    return NextResponse.json(
      { error: 'Method not allowed. Use POST.' },
      { status: 405 }
    );
  }

  // 2. Parse and validate request body (authentication made optional)
  let payload: any;
  try {
    payload = await request.json();
  } catch (e) {
    return NextResponse.json(
      { error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  const { companyId, startDate, endDate } = payload ?? {};

  // 3. Validate companyId
  if (!companyId || typeof companyId !== 'string' || companyId.trim() === '') {
    return NextResponse.json(
      { error: 'companyId is required and must be a non-empty string' },
      { status: 400 }
    );
  }

  // 4. Validate startDate
  if (!startDate || typeof startDate !== 'string') {
    return NextResponse.json(
      { error: 'startDate is required and must be a string in YYYY-MM-DD format' },
      { status: 400 }
    );
  }

  // 5. Validate endDate
  if (!endDate || typeof endDate !== 'string') {
    return NextResponse.json(
      { error: 'endDate is required and must be a string in YYYY-MM-DD format' },
      { status: 400 }
    );
  }

  // 6. Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate)) {
    return NextResponse.json(
      { error: 'startDate must be in YYYY-MM-DD format' },
      { status: 400 }
    );
  }
  if (!dateRegex.test(endDate)) {
    return NextResponse.json(
      { error: 'endDate must be in YYYY-MM-DD format' },
      { status: 400 }
    );
  }

  // 7. Validate date values (basic date validity)
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  if (isNaN(start.getTime())) {
    return NextResponse.json(
      { error: 'startDate is not a valid date' },
      { status: 400 }
    );
  }
  if (isNaN(end.getTime())) {
    return NextResponse.json(
      { error: 'endDate is not a valid date' },
      { status: 400 }
    );
  }

  // 8. Validate startDate <= endDate
  if (start > end) {
    return NextResponse.json(
      { error: 'startDate must be less than or equal to endDate' },
      { status: 400 }
    );
  }

  // 9. Require an authenticated session and scope the request to its realm.
  let authenticatedRealmId: string;
  let authenticatedUserId: string;
  try {
    const auth = await requireAuth();
    authenticatedRealmId = auth.realmId;
    authenticatedUserId = auth.user.id;
  } catch (error) {
    const authError = error instanceof Error ? error.message : '';
    const status = authError === 'UNAUTHORIZED' ? 401 : 403;
    const message = authError === 'UNAUTHORIZED'
      ? 'Authentication required'
      : 'No authorized QuickBooks company is connected';
    return NextResponse.json({ error: message }, { status });
  }

  if (companyId.trim() !== authenticatedRealmId) {
    return NextResponse.json(
      { error: 'companyId does not match connected QuickBooks realm' },
      { status: 403 }
    );
  }

  // Never select a different company's token through the unscoped fallback.
  const storedToken = await getStoredToken(authenticatedRealmId);
  if (storedToken?.realm_id !== authenticatedRealmId) {
    return NextResponse.json(
      { error: 'No QuickBooks connection found for this backend' },
      { status: 403 }
    );
  }
  // All validation passed - invoke the existing Phase 8 generatePackage()
  try {
    const result = await generatePackage(companyId.trim(), startDate, endDate);

    if (!result.success) {
      // Pipeline failure - return structured 5xx response
      console.error('Pipeline failure:', result.error);
      return NextResponse.json(
        {
          success: false,
          error: {
            stage: result.error?.stage || 'Pipeline',
            reason: result.error?.reason || 'Pipeline execution failed',
            // Sanitize details to avoid exposing secrets
            details: result.error?.details ? '[redacted]' : undefined,
          },
          stats: result.stats,
        },
        { status: 500 }
      );
    }

    let persistedPackage;
    try {
      persistedPackage = await persistPipelinePackage({
        realmId: authenticatedRealmId,
        createdBy: authenticatedUserId,
        startDate,
        endDate,
        filename: basename(result.zipPath || 'AuditPackage.zip'),
        zipBuffer: await readFile(result.zipPath!),
        status: result.completionStatus ?? (result.stats.failedDownloadCount > 0 ? 'partial' : 'complete'),
        stats: result.stats,
      });
    } catch (error) {
      console.error('Generated package persistence failed:', error instanceof Error ? error.message : 'Unknown error');
      return NextResponse.json({ success: false, error: { stage: 'Package Persistence', reason: 'Generated package could not be stored' }, stats: result.stats }, { status: 500 });
    }
    // Success - return structured response with package information
    return NextResponse.json({
      success: true,
      completionStatus: result.completionStatus ?? (result.stats.failedDownloadCount > 0 ? 'partial' : 'complete'),
      packageId: persistedPackage.id,
      packagePath: persistedPackage.zip_path,
      packageName: persistedPackage.filename,
      stats: result.stats,
    });

  } catch (e: any) {
    // Catch any unexpected errors at the API boundary
    console.error('Unexpected error in /api/generate:', e);
    return NextResponse.json(
      {
        success: false,
        error: {
          stage: 'API',
          reason: 'Internal server error during package generation',
          details: '[redacted]',
        },
        stats: {
          transactionCount: 0,
          attachableCount: 0,
          matchedCount: 0,
          missingCount: 0,
          successfulDownloadCount: 0,
          failedDownloadCount: 0,
          zipSizeBytes: 0,
          elapsedTimeMs: 0,
        },
      },
      { status: 500 }
    );
  }
}

// Explicitly disable other HTTP methods
export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405 }
  );
}

export async function PUT() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405 }
  );
}

export async function DELETE() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405 }
  );
}

export async function PATCH() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405 }
  );
}