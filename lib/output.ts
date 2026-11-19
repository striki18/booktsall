/**
 * Output storage utilities for Phase 6.
 * Generates and saves CSV files to the company output directory.
 */

import { generateEvidenceRegisterCsv, generateMissingReportCsv } from './csv';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Get the company output directory path.
 * Uses a dedicated output folder in the project root.
 */
export function getCompanyOutputDir(companyName?: string): string {
  const baseDir = process.cwd();
  const safeCompanyName = (companyName || 'company').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(baseDir, 'output', safeCompanyName);
}

/**
 * Ensure the output directory exists.
 */
export function ensureOutputDir(companyName?: string): string {
  const outputDir = getCompanyOutputDir(companyName);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  return outputDir;
}

/**
 * Split evidence register into 4-state categories.
 * The evidence_register.csv contains MATCHED, REVIEW_REQUIRED, WRONG_MATCHED transactions.
 * The missing_documents.csv contains only MISSING state transactions.
 *
 * @param register - Register entries from QBO evidence register
 * @returns Object with allEntries (for evidence_register.csv) and missingEntries (for missing_documents.csv)
 */
export function splitEvidenceRegister(register: any[]): {
  allEntries: any[];
  missingEntries: any[]
} {
  // MATCHED, REVIEW_REQUIRED, WRONG_MATCHED go to evidence_register.csv
  const allEntries = register.filter(entry => (
    entry.registerState === 'MATCHED' ||
    entry.registerState === 'REVIEW_REQUIRED' ||
    entry.registerState === 'WRONG_MATCHED'
  ) && (entry.qboTxnId || (entry.reviewCandidateTxnIds || []).length > 0));

  // Only MISSING state entries go to missing_documents.csv
  const missingEntries = register.filter(entry => entry.registerState === 'MISSING' && entry.qboTxnId);

  return { allEntries, missingEntries };
}

/**
 * Generate and save both CSV files.
 * Returns the file paths of the generated CSVs.
 */
export async function generateAndSaveCsvs(
  register: any[],
  companyName?: string,
  startDate?: string,
  endDate?: string
): Promise<{
  evidenceRegisterPath: string;
  missingDocumentsPath: string;
  matchedCount: number;
  missingCount: number;
}> {
  // Split register into all entries and missing entries
  const { allEntries, missingEntries } = splitEvidenceRegister(register);

  // Generate CSV content
  const evidenceCsv = generateEvidenceRegisterCsv(allEntries);
  const missingCsv = generateMissingReportCsv(missingEntries);

  // Ensure output directory exists
  const outputDir = ensureOutputDir(companyName);

  // Define file paths
  const evidenceRegisterPath = path.join(outputDir, 'evidence_register.csv');
  const missingDocumentsPath = path.join(outputDir, 'missing_documents.csv');

  // Write files
  fs.writeFileSync(evidenceRegisterPath, evidenceCsv, 'utf-8');
  fs.writeFileSync(missingDocumentsPath, missingCsv, 'utf-8');

  return {
    evidenceRegisterPath,
    missingDocumentsPath,
    matchedCount: register.filter(e => e.registerState === 'MATCHED').length,
    missingCount: missingEntries.length,
  };
}

/**
 * Read and parse a CSV file for verification.
 */
export function readCsv(filePath: string): any[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    // Simple CSV parsing - handles quoted fields
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current);
    
    const obj: any = {};
    headers.forEach((header, idx) => {
      obj[header] = values[idx] ?? '';
    });
    return obj;
  });
}
