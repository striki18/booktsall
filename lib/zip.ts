/**
 * ZIP Package Generation for Phase 7.
 *
 * Creates audit package ZIP files containing selected evidence
 * documents and CSV reports.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as archiver from 'archiver';

import { getCompanyOutputDir } from './output';
import { extractZipFile, listZipContents } from './zip-utils';

/**
 * Sanitize a string for use in filesystem paths.
 * Replaces unsafe characters with underscores.
 */
export function sanitizeForFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Generate the ZIP filename following the required convention:
 * AuditPackage_{companyName}_{startDate}_{endDate}.zip
 */
export function generateZipFilename(
  companyName: string,
  startDate: string,
  endDate: string
): string {
  const safeCompanyName = sanitizeForFilename(companyName);
  const safeStartDate = sanitizeForFilename(startDate);
  const safeEndDate = sanitizeForFilename(endDate);

  return `AuditPackage_${safeCompanyName}_${safeStartDate}_${safeEndDate}.zip`;
}

interface ClientEvidenceFile {
  matchedDocumentId: string;
  fileName: string;
  buffer: Buffer;
}

/**
 * Generate a ZIP package containing:
 * - evidence_register.csv
 * - missing_documents.csv
 * - selected evidence files under attachments/
 *
 * Evidence files are supplied as downloaded client-document buffers.
 * No QBO Attachable directory is consulted.
 */
export async function generateZip(
  companyName: string,
  startDate: string,
  endDate: string,
  successfulEvidenceFiles: ClientEvidenceFile[] = []
): Promise<string> {
  const zipFilename = generateZipFilename(
    companyName,
    startDate,
    endDate
  );

  const outputDir = getCompanyOutputDir(companyName);
  const zipPath = path.join(outputDir, zipFilename);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const evidenceRegisterPath = path.join(
    outputDir,
    'evidence_register.csv'
  );

  const missingDocumentsPath = path.join(
    outputDir,
    'missing_documents.csv'
  );

  const output = fs.createWriteStream(zipPath);

  const archive = new archiver.ZipArchive({
    zlib: { level: 9 },
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    output.on('close', () => {
      if (settled) return;

      settled = true;

      console.log(
        `ZIP created: ${zipPath} (${archive.pointer()} bytes)`
      );

      resolve(zipPath);
    });

    output.on('error', fail);

    archive.on('error', fail);

    archive.pipe(output);

    if (fs.existsSync(evidenceRegisterPath)) {
      archive.file(evidenceRegisterPath, {
        name: 'evidence_register.csv',
      });
    }

    if (fs.existsSync(missingDocumentsPath)) {
      archive.file(missingDocumentsPath, {
        name: 'missing_documents.csv',
      });
    }

    /*
     * A document can support multiple transactions. Add each document
     * only once to the ZIP.
     */
    const uniqueDocuments = new Map<
      string,
      ClientEvidenceFile
    >();

    for (const evidence of successfulEvidenceFiles) {
      if (!uniqueDocuments.has(evidence.matchedDocumentId)) {
        uniqueDocuments.set(
          evidence.matchedDocumentId,
          evidence
        );
      }
    }

    const usedNames = new Set<string>();

    for (const evidence of uniqueDocuments.values()) {
      const originalName = path.basename(evidence.fileName);

      if (!originalName) {
        continue;
      }

      let zipName = originalName;

      if (usedNames.has(zipName)) {
        const parsed = path.parse(originalName);
        const safeId = sanitizeForFilename(
          evidence.matchedDocumentId
        );

        zipName = `${parsed.name}_${safeId}${parsed.ext}`;
      }

      let collisionCounter = 2;
      const initialZipName = zipName;

      while (usedNames.has(zipName)) {
        const parsed = path.parse(initialZipName);
        zipName = `${parsed.name}_${collisionCounter}${parsed.ext}`;
        collisionCounter++;
      }

      usedNames.add(zipName);

      archive.append(evidence.buffer, {
        name: `attachments/${zipName}`,
      });
    }

    archive.finalize().catch(fail);
  });
}

/**
 * Verify a generated ZIP package.
 */
export interface ZipVerificationResult {
  zipCreated: boolean;
  filenameValid: boolean;
  validArchive: boolean;
  attachmentsPresent: boolean;
  evidenceRegisterPresent: boolean;
  missingDocumentsPresent: boolean;
  attachmentsNonEmpty: boolean;
  csvReadable: boolean;
  noExpectedFilesMissing: boolean;
  noUnexpectedFiles: boolean;
  contentsMatchSource: boolean;
  errors: string[];
}

export async function verifyZip(
  zipPath: string,
  companyName: string,
  startDate: string,
  endDate: string
): Promise<ZipVerificationResult> {
  const result: ZipVerificationResult = {
    zipCreated: false,
    filenameValid: false,
    validArchive: false,
    attachmentsPresent: false,
    evidenceRegisterPresent: false,
    missingDocumentsPresent: false,
    attachmentsNonEmpty: true,
    csvReadable: true,
    noExpectedFilesMissing: false,
    noUnexpectedFiles: true,
    contentsMatchSource: false,
    errors: [],
  };

  const expectedZipFilename = generateZipFilename(
    companyName,
    startDate,
    endDate
  );

  const actualFilename = path.basename(zipPath);
  const outputDir = getCompanyOutputDir(companyName);

  if (fs.existsSync(zipPath)) {
    result.zipCreated = true;
  } else {
    result.errors.push('ZIP file does not exist');
    return result;
  }

  if (actualFilename === expectedZipFilename) {
    result.filenameValid = true;
  } else {
    result.errors.push(
      `Filename mismatch: expected ${expectedZipFilename}, got ${actualFilename}`
    );
  }

  let contents;

  try {
    contents = await listZipContents(zipPath);
  } catch (e) {
    result.errors.push(`Failed to read ZIP archive: ${e}`);
    return result;
  }

  if (contents.length > 0) {
    result.validArchive = true;
  } else {
    result.errors.push('ZIP appears to be empty or invalid');
    return result;
  }

  const evidenceRegisterFound = contents.some(
    (c) => c.name === 'evidence_register.csv'
  );

  const missingDocumentsFound = contents.some(
    (c) => c.name === 'missing_documents.csv'
  );

  const attachmentFiles = contents.filter(
    (c) =>
      c.name.startsWith('attachments/') &&
      !c.name.endsWith('/')
  );

  result.evidenceRegisterPresent = evidenceRegisterFound;
  result.missingDocumentsPresent = missingDocumentsFound;
  result.attachmentsPresent = attachmentFiles.length > 0;

  if (!evidenceRegisterFound) {
    result.errors.push(
      'evidence_register.csv not found in ZIP'
    );
  }

  if (!missingDocumentsFound) {
    result.errors.push(
      'missing_documents.csv not found in ZIP'
    );
  }

  for (const file of attachmentFiles) {
    if (file.size === 0) {
      result.attachmentsNonEmpty = false;
      result.errors.push(`Empty attachment file: ${file.name}`);
    }
  }

  if (evidenceRegisterFound) {
    try {
      const csvContent = await extractZipFile(
        zipPath,
        'evidence_register.csv'
      );

      const lines = csvContent.trim().split('\n');

      if (lines.length < 1) {
        result.csvReadable = false;
        result.errors.push(
          'evidence_register.csv is empty or unreadable'
        );
      }
    } catch (e) {
      result.csvReadable = false;
      result.errors.push(
        `Failed to read evidence_register.csv: ${e}`
      );
    }
  }

  if (missingDocumentsFound) {
    try {
      const csvContent = await extractZipFile(
        zipPath,
        'missing_documents.csv'
      );

      const lines = csvContent.trim().split('\n');

      if (lines.length < 1) {
        result.csvReadable = false;
        result.errors.push(
          'missing_documents.csv is empty or unreadable'
        );
      }
    } catch (e) {
      result.csvReadable = false;
      result.errors.push(
        `Failed to read missing_documents.csv: ${e}`
      );
    }
  }

  /*
   * The ZIP now contains selected client evidence, not every file
   * from a local/global attachments directory.
   *
   * Therefore the only universally expected files are the two CSVs.
   */
  const expectedFiles = new Set([
    'evidence_register.csv',
    'missing_documents.csv',
  ]);

  const foundFiles = new Set(contents.map((c) => c.name));

  const missingExpected = [...expectedFiles].filter(
    (file) => !foundFiles.has(file)
  );

  if (missingExpected.length === 0) {
    result.noExpectedFilesMissing = true;
  } else {
    result.noExpectedFilesMissing = false;
    result.errors.push(
      `Missing expected files: ${missingExpected.join(', ')}`
    );
  }

  const unexpectedFiles = [...foundFiles].filter(
    (file) =>
      !expectedFiles.has(file) &&
      !file.startsWith('attachments/')
  );

  if (unexpectedFiles.length === 0) {
    result.noUnexpectedFiles = true;
  } else {
    result.noUnexpectedFiles = false;
    result.errors.push(
      `Unexpected files found: ${unexpectedFiles.join(', ')}`
    );
  }

  let contentsMatch = true;

  if (evidenceRegisterFound) {
    try {
      const zipContent = await extractZipFile(
        zipPath,
        'evidence_register.csv'
      );

      const sourcePath = path.join(
        outputDir,
        'evidence_register.csv'
      );

      if (fs.existsSync(sourcePath)) {
        const sourceContent = fs.readFileSync(
          sourcePath,
          'utf-8'
        );

        if (zipContent !== sourceContent) {
          contentsMatch = false;
          result.errors.push(
            'evidence_register.csv content does not match source'
          );
        }
      }
    } catch (e) {
      contentsMatch = false;
      result.errors.push(
        `Failed to compare evidence_register.csv: ${e}`
      );
    }
  }

  if (missingDocumentsFound) {
    try {
      const zipContent = await extractZipFile(
        zipPath,
        'missing_documents.csv'
      );

      const sourcePath = path.join(
        outputDir,
        'missing_documents.csv'
      );

      if (fs.existsSync(sourcePath)) {
        const sourceContent = fs.readFileSync(
          sourcePath,
          'utf-8'
        );

        if (zipContent !== sourceContent) {
          contentsMatch = false;
          result.errors.push(
            'missing_documents.csv content does not match source'
          );
        }
      }
    } catch (e) {
      contentsMatch = false;
      result.errors.push(
        `Failed to compare missing_documents.csv: ${e}`
      );
    }
  }

  result.contentsMatchSource = contentsMatch;

  return result;
}