import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateZip } from '../lib/zip';
import { getCompanyOutputDir, ensureOutputDir } from '../lib/output';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';

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
});