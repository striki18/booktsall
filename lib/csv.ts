/**
 * CSV generation utilities for Phase 6.
 * Minimal implementation without external dependencies.
 */

/**
 * Escape a value for CSV output.
 * Wraps in double quotes if value contains comma, double quote, or newline.
 * Escapes existing double quotes by doubling them.
 */
export function escapeCsvValue(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }
  const raw = String(value);
  // Prevent spreadsheet applications from evaluating untrusted cell values as formulas.
  const str = /^[\u0000-\u0020]*[=+\-@]/.test(raw) ? "'" + raw : raw;
  // Check if escaping is needed
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    // Escape double quotes by doubling them
    const escaped = str.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return str;
}

/**
 * Generate CSV string from array of objects with specified column order.
 */
export function generateCsv(
  records: any[],
  columns: { key: string; header: string }[]
): string {
  // Build header row
  const headerRow = columns.map((c) => escapeCsvValue(c.header)).join(',');
  
  // Build data rows
  const dataRows = records.map((record) => {
    return columns.map((c) => escapeCsvValue(record[c.key])).join(',');
  });
  
  return [headerRow, ...dataRows].join('\n');
}

/**
 * Generate Evidence Register CSV from register entries.
 * Required columns: Date, Transaction Type, Doc Number, Vendor/Customer, Amount, Attachment Filename, Attachable ID, Status
 * Status uses the 4 canonical states: MATCHED, MISSING, REVIEW_REQUIRED, WRONG_MATCHED
 */
export function generateEvidenceRegisterCsv(registerEntries: any[]): string {
  const columns = [
    { key: 'date', header: 'Date' },
    { key: 'txnType', header: 'Transaction Type' },
    { key: 'docNumber', header: 'Doc Number' },
    { key: 'vendor', header: 'Vendor/Customer' },
    { key: 'amount', header: 'Amount' },
    { key: 'fileName', header: 'Attachment Filename' },
    { key: 'attachableId', header: 'Attachable ID' },
    { key: 'status', header: 'Status' },
    { key: 'humanApproved', header: 'Human Approved' },
    { key: 'reviewAction', header: 'Latest Review Decision' },
    { key: 'selectedQboTxnId', header: 'Reviewed Transaction ID' },
    { key: 'reviewerUserId', header: 'Reviewer User ID' },
    { key: 'reviewedAt', header: 'Decision Timestamp' },
    { key: 'reviewRationale', header: 'Decision Rationale' },
    { key: 'reviewHistory', header: 'Decision History' },
  ];
  
  // Map register entries to CSV row format using registerState as the status
  const csvRecords = registerEntries.map((entry) => ({
    date: entry.qboTxnDate ?? entry.date ?? '',
    txnType: entry.qboTxnType ?? entry.txnType ?? '',
    docNumber: entry.qboTxnDocNumber ?? entry.docNumber ?? '',
    vendor: entry.qboTxnVendor ?? entry.vendor ?? '',
    amount: entry.qboTxnAmount ?? entry.amount ?? '',
    fileName: entry.attachmentFilename ?? entry.fileName ?? '',
    attachableId: entry.attachableId ?? '',
    status: entry.registerState ?? '',
    humanApproved: entry.humanApproved === true ? 'YES' : entry.humanApproved === false ? 'NO' : '',
    reviewAction: entry.reviewDecision?.action ?? '',
    selectedQboTxnId: entry.reviewDecision?.selected_qbo_txn_id ?? '',
    reviewerUserId: entry.reviewDecision?.reviewer_user_id ?? '',
    reviewedAt: entry.reviewDecision?.created_at ?? '',
    reviewRationale: entry.reviewDecision?.rationale ?? '',
    reviewHistory: entry.reviewHistory?.length ? JSON.stringify(entry.reviewHistory) : '',
  }));
  
  return generateCsv(csvRecords, columns);
}

/**
 * Generate Missing Documents CSV from register entries with MISSING state.
 * Required columns: Date, Transaction Type, Doc Number, Vendor/Customer, Amount, Missing Since
 */
export function generateMissingReportCsv(registerEntries: any[]): string {
  const columns = [
    { key: 'date', header: 'Date' },
    { key: 'txnType', header: 'Transaction Type' },
    { key: 'docNumber', header: 'Doc Number' },
    { key: 'vendor', header: 'Vendor/Customer' },
    { key: 'amount', header: 'Amount' },
    { key: 'missingSince', header: 'Missing Since' },
  ];
  
  // Filter to only MISSING entries
  const missingEntries = registerEntries.filter(entry => entry.registerState === 'MISSING');
  
  // Map missing entries to CSV row format
  const csvRecords = missingEntries.map((entry) => ({
    date: entry.qboTxnDate ?? entry.date ?? '',
    txnType: entry.qboTxnType ?? entry.txnType ?? '',
    docNumber: entry.qboTxnDocNumber ?? entry.docNumber ?? '',
    vendor: entry.qboTxnVendor ?? entry.vendor ?? '',
    amount: entry.qboTxnAmount ?? entry.amount ?? '',
    // Missing Since: use the transaction date as the "missing since" date
    missingSince: entry.qboTxnDate ?? entry.date ?? '',
  }));
  
  return generateCsv(csvRecords, columns);
}
