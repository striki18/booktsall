import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateZip, verifyZip } from '../lib/zip';
import { getCompanyOutputDir, ensureOutputDir } from '../lib/output';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';

describe('generateZip', () => {
  let tempDir: string;
  let outputDir: string;
  const testCompanyName = 'TestCompany';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditready-zip-test-'));
    outputDir = path.join(tempDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    
    // Create the actual output directory that generateZip uses
    ensureOutputDir(testCompanyName);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    // Clean up the actual output directory
    const actualOutputDir = getCompanyOutputDir(testCompanyName);
    if (fs.existsSync(actualOutputDir)) {
      fs.rmSync(actualOutputDir, { recursive: true, force: true });
    }
  });

  it('should create a valid ZIP with evidence files and CSV files', async () => {
    // Create CSV files in the actual output directory that generateZip uses
    const actualOutputDir = getCompanyOutputDir(testCompanyName);
    fs.writeFileSync(path.join(actualOutputDir, 'evidence_register.csv'), 'id,name\n1,test');
    fs.writeFileSync(path.join(actualOutputDir, 'missing_documents.csv'), 'id,name\n2,missing');

    const evidenceFiles = [
      { fileName: 'test1.txt', matchedDocumentId: 'doc_1', buffer: Buffer.from('Hello World 1') },
      { fileName: 'test2.txt', matchedDocumentId: 'doc_2', buffer: Buffer.from('Hello World 2') }
    ];

    const result = await generateZip(
      'TestCompany',
      '2024-01-01',
      '2024-12-31',
      evidenceFiles
    );

    expect(result).toBeTruthy();
    expect(fs.existsSync(result)).toBe(true);

    // Verify the zip
    const stats = fs.statSync(result);
    expect(stats.size).toBeGreaterThan(0);

    // List contents
    const zip = new AdmZip(result);
    const entries = zip.getEntries().map(e => e.entryName);
    console.log('ZIP contents:', entries);
    
    expect(entries).toContain('evidence_register.csv');
    expect(entries).toContain('missing_documents.csv');
    expect(entries.some(e => e.startsWith('attachments/'))).toBe(true);
    expect(entries).toContain('package_manifest.json');
    expect(JSON.parse(zip.readAsText('package_manifest.json')).status).toBe('complete');
    const verification = await verifyZip(result, testCompanyName, '2024-01-01', '2024-12-31');
    expect(verification).toMatchObject({ validArchive: true, packageManifestPresent: true, manifestReadable: true, manifestFilesPresent: true, manifestHashesValid: true, noUnexpectedFiles: true });
  });

  it('should handle missing CSV files gracefully', async () => {
    const evidenceFiles = [
      { fileName: 'test1.txt', matchedDocumentId: 'doc_1', buffer: Buffer.from('Hello World 1') }
    ];

    const result = await generateZip(
      'TestCompany',
      '2024-01-01',
      '2024-12-31',
      evidenceFiles
    );

    expect(result).toBeTruthy();
    expect(fs.existsSync(result)).toBe(true);

    const zip = new AdmZip(result);
    const entries = zip.getEntries().map(e => e.entryName);
    console.log('ZIP contents (no CSVs):', entries);
    
    expect(entries).not.toContain('evidence_register.csv');
    expect(entries).not.toContain('missing_documents.csv');
    expect(entries.some(e => e.startsWith('attachments/'))).toBe(true);
  });
  it('includes a per-file failure manifest for partial packages', async () => {
    const actualOutputDir = getCompanyOutputDir(testCompanyName);
    fs.writeFileSync(path.join(actualOutputDir, 'evidence_register.csv'), 'id,name\n1,test');
    fs.writeFileSync(path.join(actualOutputDir, 'missing_documents.csv'), 'id,name\n2,missing');

    const result = await generateZip(
      testCompanyName,
      '2024-01-01',
      '2024-12-31',
      [{ fileName: 'receipt.pdf', matchedDocumentId: 'doc-1', buffer: Buffer.from('%PDF') }],
      [{ source: 'quickbooks', referenceId: 'attach-2', fileName: 'invoice.pdf', reason: 'download_failed' }],
    );
    const zip = new AdmZip(result);
    const manifest = JSON.parse(zip.readAsText('package_manifest.json'));

    expect(manifest.status).toBe('partial');
    expect(manifest.expectedAttachmentCount).toBe(2);
    expect(manifest.includedFiles[0]).toMatchObject({ evidenceRef: 'doc-1', path: 'attachments/receipt.pdf', size: 4, sha256: createHash('sha256').update(Buffer.from('%PDF')).digest('hex') });
    expect(manifest.failedFiles).toEqual([{ source: 'quickbooks', referenceId: 'attach-2', fileName: 'invoice.pdf', reason: 'download_failed' }]);
    const verification = await verifyZip(result, testCompanyName, '2024-01-01', '2024-12-31');
    expect(verification.manifestHashesValid).toBe(true);
    expect(verification.manifestReadable).toBe(true);
  });
  it('detects changed evidence bytes through manifest hash verification', async () => {
    const actualOutputDir = getCompanyOutputDir(testCompanyName);
    fs.writeFileSync(path.join(actualOutputDir, 'evidence_register.csv'), 'id,name\n1,test');
    fs.writeFileSync(path.join(actualOutputDir, 'missing_documents.csv'), 'id,name\n2,missing');
    const result = await generateZip(testCompanyName, '2024-01-01', '2024-12-31', [
      { fileName: 'receipt.pdf', matchedDocumentId: 'doc-hash', buffer: Buffer.from('original-bytes') },
    ]);
    const zip = new AdmZip(result);
    zip.updateFile('attachments/receipt.pdf', Buffer.from('changed-bytes'));
    zip.writeZip(result);

    const verification = await verifyZip(result, testCompanyName, '2024-01-01', '2024-12-31');

    expect(verification.manifestHashesValid).toBe(false);
    expect(verification.errors.some(error => error.includes('hash or size mismatch'))).toBe(true);
  });
});