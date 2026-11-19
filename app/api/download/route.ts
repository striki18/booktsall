import { NextResponse, NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { getCompanyOutputDir } from '@/lib/output';
import { sanitizeForFilename } from '@/lib/zip';
import { requireAuth, requireAuthContext } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';

/**
 * GET /api/download
 * 
 * Downloads a generated audit package ZIP file.
 * Query parameters:
 *   companyId - Company identifier (realm ID)
 *   startDate - Start date in YYYY-MM-DD format
 *   endDate - End date in YYYY-MM-DD format
 * 
 * Returns the ZIP file as a download response.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  
  const companyId = searchParams.get('companyId');
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const packageId = searchParams.get('packageId');
  if (packageId) {
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(packageId)) return NextResponse.json({ error: 'Invalid packageId' }, { status: 400 });
    try {
      const { realmId, supabase } = await requireAuthContext();
      const { data: pkg, error } = await supabase
        .from('generated_evidence_packages')
        .select('id, realm_id, status, zip_path, filename')
        .eq('id', packageId)
        .eq('realm_id', realmId)
        .single();
      if (error || !pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 });
      if (pkg.status !== 'complete' && pkg.status !== 'partial') return NextResponse.json({ error: 'Package is not ready for download' }, { status: 409 });
      if (!pkg.zip_path) return NextResponse.json({ error: 'Package file is not available' }, { status: 409 });

      const { data: file, error: downloadError } = await supabaseAdmin.storage.from('evidence').download(pkg.zip_path);
      if (downloadError || !file) return NextResponse.json({ error: 'Package file not found in storage' }, { status: 404 });
      const buffer = Buffer.from(await file.arrayBuffer());
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${pkg.filename}"`,
          'Content-Length': buffer.length.toString(),
        },
      });
    } catch (error) {
      const status = error instanceof Error && error.message === 'UNAUTHORIZED' ? 401 : 403;
      return NextResponse.json({ error: status === 401 ? 'Authentication required' : 'Forbidden' }, { status });
    }
  }

  // Validate required parameters
  if (!companyId || typeof companyId !== 'string' || companyId.trim() === '') {
    return NextResponse.json(
      { error: 'companyId is required and must be a non-empty string' },
      { status: 400 }
    );
  }

  if (!startDate || typeof startDate !== 'string') {
    return NextResponse.json(
      { error: 'startDate is required and must be a string in YYYY-MM-DD format' },
      { status: 400 }
    );
  }

  if (!endDate || typeof endDate !== 'string') {
    return NextResponse.json(
      { error: 'endDate is required and must be a string in YYYY-MM-DD format' },
      { status: 400 }
    );
  }

  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
    return NextResponse.json(
      { error: 'Dates must be in YYYY-MM-DD format' },
      { status: 400 }
    );
  }

  try {
    const { realmId } = await requireAuth();
    if (companyId !== realmId) return NextResponse.json({ error: 'companyId is not authorized for this account' }, { status: 403 });
    // Generate the expected ZIP filename using the same logic as Phase 7/9B
    const safeCompanyId = sanitizeForFilename(companyId.trim());
    const safeStartDate = sanitizeForFilename(startDate);
    const safeEndDate = sanitizeForFilename(endDate);
    const zipFilename = `AuditPackage_${safeCompanyId}_${safeStartDate}_${safeEndDate}.zip`;
    
    // Get the company output directory
    const outputDir = getCompanyOutputDir(companyId.trim());
    const zipPath = path.join(outputDir, zipFilename);

    // Security check: Ensure the resolved path is within the output directory
    const resolvedZipPath = path.resolve(zipPath);
    const resolvedOutputDir = path.resolve(outputDir);
    
    if (!resolvedZipPath.startsWith(resolvedOutputDir)) {
      console.error(`Path traversal attempt detected: ${zipPath}`);
      return NextResponse.json(
        { error: 'Invalid package identifier' },
        { status: 400 }
      );
    }

    // Check if the ZIP file exists
    if (!fs.existsSync(resolvedZipPath)) {
      return NextResponse.json(
        { error: 'Package not found. Generate the package first.' },
        { status: 404 }
      );
    }

    // Read the ZIP file
    const fileBuffer = fs.readFileSync(resolvedZipPath);
    
    // Return the ZIP file as a download
    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFilename}"`,
        'Content-Length': fileBuffer.length.toString(),
      },
    });

  } catch (e: any) {
    const status = e instanceof Error && e.message === 'UNAUTHORIZED' ? 401 : e instanceof Error && (e.message === 'NO_REALM_ID' || e.message === 'FORBIDDEN') ? 403 : 500;
    if (status !== 500) return NextResponse.json({ error: status === 401 ? 'Authentication required' : 'Forbidden' }, { status });
    console.error('Download error');
    return NextResponse.json(
      { error: 'Internal server error during download' },
      { status: 500 }
    );
  }
}

// Explicitly disable other HTTP methods
export async function POST() {
  return NextResponse.json(
    { error: 'Method not allowed. Use GET.' },
    { status: 405 }
  );
}

export async function PUT() {
  return NextResponse.json(
    { error: 'Method not allowed. Use GET.' },
    { status: 405 }
  );
}

export async function DELETE() {
  return NextResponse.json(
    { error: 'Method not allowed. Use GET.' },
    { status: 405 }
  );
}

export async function PATCH() {
  return NextResponse.json(
    { error: 'Method not allowed. Use GET.' },
    { status: 405 }
  );
}