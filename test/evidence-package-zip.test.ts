import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildEvidencePackageZip, verifyEvidencePackageZip } from '../lib/evidence-package-zip';

describe('evidence package ZIP assembly', () => {
  it('contains the real document bytes and a traceable manifest', async () => {
    const bytes = await buildEvidencePackageZip('pkg-1', [{
      documentId: 'doc-1', folderName: 'Invoices', fileName: 'invoice.pdf', buffer: Buffer.from('%PDF-TEST'),
    }]);
    const zip = new AdmZip(bytes);
    const file = zip.getEntry('attachments/Invoices/invoice.pdf');
    const manifest = zip.readAsText('evidence_package_manifest.json');

    expect(file?.getData().toString()).toBe('%PDF-TEST');
    expect(JSON.parse(manifest)).toMatchObject({ packageId: 'pkg-1', files: [{ documentId: 'doc-1', path: 'attachments/Invoices/invoice.pdf', size: 9, sha256: createHash('sha256').update('%PDF-TEST').digest('hex') }] });
  });

  it('prevents path traversal and resolves duplicate attachment names', async () => {
    const bytes = await buildEvidencePackageZip('pkg-1', [
      { documentId: 'doc-1', folderName: '../A', fileName: '..\\same.pdf', buffer: Buffer.from('one') },
      { documentId: 'doc-2', folderName: '../A', fileName: 'same.pdf', buffer: Buffer.from('two') },
    ]);
    const zip = new AdmZip(bytes);
    const names = zip.getEntries().map(entry => entry.entryName);

    expect(names).toContain('attachments/__A/same.pdf');
    expect(names).toContain('attachments/__A/same_doc-2.pdf');
    expect(names.some(name => name.includes('..'))).toBe(false);
  });

  it('builds a valid traceable ZIP for an empty package', async () => {
    const bytes = await buildEvidencePackageZip('empty-package', []);
    const zip = new AdmZip(bytes);

    expect(zip.getEntries().map(entry => entry.entryName)).toEqual(['evidence_package_manifest.json']);
    expect(JSON.parse(zip.readAsText('evidence_package_manifest.json'))).toMatchObject({ packageId: 'empty-package', status: 'complete', expectedAttachmentCount: 0, files: [], failedFiles: [] });
    await expect(verifyEvidencePackageZip(bytes)).resolves.toEqual({ valid: true, errors: [] });
  });

  it('records per-file failures as partial and verifies exact included ZIP bytes', async () => {
    const fileBytes = Buffer.from('%PDF-VERIFIED');
    const bytes = await buildEvidencePackageZip('partial-package', [{
      documentId: 'doc-ok', folderName: 'Receipts', fileName: 'receipt.pdf', buffer: fileBytes,
    }], [{ documentId: 'doc-fail', fileName: 'missing.pdf', reason: 'Storage download failed' }]);
    const zip = new AdmZip(bytes);
    const manifest = JSON.parse(zip.readAsText('evidence_package_manifest.json'));

    expect(manifest).toMatchObject({
      status: 'partial',
      expectedAttachmentCount: 2,
      files: [{ documentId: 'doc-ok', size: fileBytes.length, sha256: createHash('sha256').update(fileBytes).digest('hex') }],
      failedFiles: [{ documentId: 'doc-fail', fileName: 'missing.pdf' }],
    });
    await expect(verifyEvidencePackageZip(bytes)).resolves.toEqual({ valid: true, errors: [] });
  });

  it('rejects tampered evidence bytes and unexpected ZIP entries', async () => {
    const source = await buildEvidencePackageZip('verify-package', [{
      documentId: 'doc-1', folderName: 'Invoices', fileName: 'invoice.pdf', buffer: Buffer.from('original-bytes'),
    }]);
    const tampered = new AdmZip(source);
    tampered.updateFile('attachments/Invoices/invoice.pdf', Buffer.from('changed-bytes'));
    await expect(verifyEvidencePackageZip(tampered.toBuffer())).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('hash or size mismatch')],
    });

    const unexpected = new AdmZip(source);
    unexpected.addFile('unexpected.txt', Buffer.from('unexpected'));
    await expect(verifyEvidencePackageZip(unexpected.toBuffer())).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('Unexpected ZIP entry')],
    });
  });
});