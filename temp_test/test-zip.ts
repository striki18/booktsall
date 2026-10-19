import { generateZip } from '../lib/zip';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create test files
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditready-zip-test-'));
console.log('Temp dir:', tempDir);

// Create test files with buffers
const buffer1 = Buffer.from('Hello World 1');
const buffer2 = Buffer.from('Hello World 2');

// Create CSV files in the expected output directory
const outputDir = path.join(tempDir, 'output');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'evidence_register.csv'), 'id,name\n1,test');
fs.writeFileSync(path.join(outputDir, 'missing_documents.csv'), 'id,name\n2,missing');

const evidenceFiles = [
  { fileName: 'test1.txt', matchedDocumentId: 'doc_1', buffer: buffer1 },
  { fileName: 'test2.txt', matchedDocumentId: 'doc_2', buffer: buffer2 }
];

try {
  const result = await generateZip(
    'TestCompany',
    '2024-01-01',
    '2024-12-31',
    evidenceFiles
  );
  console.log('SUCCESS:', result);
  
  // Verify the zip
  const stats = fs.statSync(result);
  console.log('ZIP size:', stats.size);
  
  // List contents
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(result);
  console.log('ZIP contents:', zip.getEntries().map(e => e.entryName));
} catch (error) {
  console.error('ERROR:', error);
} finally {
  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
}