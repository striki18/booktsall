import * as archiver from 'archiver';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import * as yauzl from 'yauzl';

export interface EvidencePackageFile {
  documentId: string;
  folderName: string;
  fileName: string;
  buffer: Buffer;
}

export interface EvidencePackageFailure {
  documentId: string;
  fileName: string;
  reason: string;
}

function safeSegment(value: string, fallback: string): string {
  const result = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.{2,}/g, '_').replace(/^\.+$/, '_').trim();
  return result || fallback;
}

export async function buildEvidencePackageZip(
  packageId: string,
  files: EvidencePackageFile[],
  failedFiles: EvidencePackageFailure[] = [],
): Promise<Buffer> {
  const archive = new archiver.ZipArchive({ zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));

  const zipResult = new Promise<Buffer>((resolve, reject) => {
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
    archive.on('error', reject);
  });

  archive.pipe(output);
  const names = new Set<string>();
  const manifestFiles: Array<{ documentId: string; path: string; size: number; sha256: string }> = [];

  for (const file of files) {
    const baseName = safeSegment(file.fileName.split(/[\\/]/).pop() ?? '', 'document');
    const folderName = safeSegment(file.folderName, 'Evidence');
    let archivePath = `attachments/${folderName}/${baseName}`;
    if (names.has(archivePath)) {
      const dot = baseName.lastIndexOf('.');
      const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
      const extension = dot > 0 ? baseName.slice(dot) : '';
      archivePath = `attachments/${folderName}/${stem}_${safeSegment(file.documentId, 'document')}${extension}`;
    }
    let suffix = 2;
    const initialPath = archivePath;
    while (names.has(archivePath)) {
      const dot = initialPath.lastIndexOf('.');
      const stem = dot > initialPath.lastIndexOf('/') ? initialPath.slice(0, dot) : initialPath;
      const extension = dot > initialPath.lastIndexOf('/') ? initialPath.slice(dot) : '';
      archivePath = `${stem}_${suffix++}${extension}`;
    }
    names.add(archivePath);
    archive.append(file.buffer, { name: archivePath });
    manifestFiles.push({ documentId: file.documentId, path: archivePath, size: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex') });
  }

  archive.append(JSON.stringify({
    schemaVersion: 1,
    packageId,
    status: failedFiles.length > 0 ? 'partial' : 'complete',
    expectedAttachmentCount: manifestFiles.length + failedFiles.length,
    files: manifestFiles,
    failedFiles,
  }, null, 2), { name: 'evidence_package_manifest.json' });
  await archive.finalize();
  return zipResult;
}

/** Read and parse the embedded package manifest using the runtime yauzl dependency. */
export async function readEvidencePackageZipManifest(zipBuffer: Buffer): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Unable to open evidence package ZIP'));
        return;
      }
      zipFile.on('error', reject);
      zipFile.on('entry', (entry) => {
        if (entry.fileName !== 'evidence_package_manifest.json') {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('Unable to read package manifest'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              zipFile.close();
            } catch (error) {
              reject(error);
            }
          });
        });
      });
      zipFile.on('end', () => reject(new Error('Package manifest is missing')));
      zipFile.readEntry();
    });
  });
}
/** Verify archive structure, manifest consistency, and every included byte hash. */
export async function verifyEvidencePackageZip(zipBuffer: Buffer): Promise<{ valid: boolean; errors: string[] }> {
  const entries = new Map<string, Buffer>();
  const duplicateEntries: string[] = [];
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Unable to open evidence package ZIP'));
        return;
      }
      zipFile.on('error', reject);
      zipFile.on('end', resolve);
      zipFile.on('entry', (entry) => {
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Unable to read ZIP entry ${entry.fileName}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            if (entries.has(entry.fileName)) duplicateEntries.push(entry.fileName);
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipFile.readEntry();
          });
        });
      });
      zipFile.readEntry();
    });
  });

  const errors: string[] = duplicateEntries.map((name) => `Duplicate ZIP entry: ${name}`);
  const manifestBytes = entries.get('evidence_package_manifest.json');
  if (!manifestBytes) return { valid: false, errors: [...errors, 'Manifest missing'] };
  let manifest: any;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return { valid: false, errors: [...errors, 'Manifest is not valid JSON'] };
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.failedFiles)) {
    errors.push('Manifest schema is invalid');
  }
  if (manifest.status !== (manifest.failedFiles?.length > 0 ? 'partial' : 'complete')) {
    errors.push('Manifest status is inconsistent');
  }
  if (manifest.expectedAttachmentCount !== (manifest.files?.length ?? 0) + (manifest.failedFiles?.length ?? 0)) {
    errors.push('Manifest attachment count is inconsistent');
  }
  for (const file of manifest.files ?? []) {
    const bytes = entries.get(file.path);
    if (!bytes) {
      errors.push(`Included file missing from ZIP: ${file.path}`);
      continue;
    }
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      errors.push(`Included file hash or size mismatch: ${file.path}`);
    }
  }
  const listed = new Set((manifest.files ?? []).map((file: { path: string }) => file.path));
  for (const path of entries.keys()) {
    if (path === 'evidence_package_manifest.json') continue;
    if (path.startsWith('attachments/') && !listed.has(path)) errors.push(`Unexpected ZIP attachment: ${path}`);
    else if (!path.startsWith('attachments/')) errors.push(`Unexpected ZIP entry: ${path}`);
  }
  return { valid: errors.length === 0, errors };
}