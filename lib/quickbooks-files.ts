import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAttachableBytes } from './quickbooks';

export interface DownloadFileResult {
  success: boolean;
  filePath?: string;
  error?: string;
  attachableId?: string;
  fileName?: string;
  timestamp?: string;
}

export async function downloadFile(attachableId: string, fileName: string, destFolder: string, failed?: DownloadFileResult[], requestedRealmId?: string): Promise<DownloadFileResult> {
  try {
    if (!requestedRealmId) throw new Error('Realm ID is required');
    const { bytes } = await downloadAttachableBytes(attachableId, requestedRealmId);
    if (!bytes.length) throw new Error('Downloaded file is empty');
    if (!fs.existsSync(/* turbopackIgnore: true */ destFolder)) fs.mkdirSync(/* turbopackIgnore: true */ destFolder, { recursive: true });
    const filePath = path.join(/* turbopackIgnore: true */ destFolder, fileName);
    fs.writeFileSync(/* turbopackIgnore: true */ filePath, bytes);
    return { success: true, filePath, timestamp: new Date().toISOString() };
  } catch (error) {
    const failure: DownloadFileResult = { success: false, error: error instanceof Error ? error.message : 'Download failed', attachableId, fileName, timestamp: new Date().toISOString() };
    failed?.push(failure);
    return failure;
  }
}

export interface DownloadProgress {
  totalAttachments: number; completed: number; successful: number; failed: number;
  currentFile?: string; stage: 'started' | 'in_progress' | 'completed' | 'failed';
}

export async function downloadAllAttachments(matched: any[], startDate: string, endDate: string, onProgress?: (progress: DownloadProgress) => void, requestedRealmId?: string) {
  const destFolder = path.join(/* turbopackIgnore: true */ os.tmpdir(), 'zevidt-attachments');
  if (!fs.existsSync(/* turbopackIgnore: true */ destFolder)) fs.mkdirSync(/* turbopackIgnore: true */ destFolder, { recursive: true });
  const sanitize = (value: string) => value.replace(/[\\/:*?"<>|]/g, '_');
  const candidates = matched.filter((item) => item.hasAttachment && item.date && item.date >= startDate && item.date <= endDate);
  const successful: Array<{ attachableId: string; fileName: string; txnType: string; docNumber: string; filePath: string; fileSize: number }> = [];
  const failed: Array<{ attachableId: string | null; fileName: string; error: string; timestamp: string }> = [];
  let completed = 0;
  const progress = (stage: DownloadProgress['stage'], currentFile?: string) => onProgress?.({ totalAttachments: candidates.length, completed, successful: successful.length, failed: failed.length, currentFile, stage });
  progress('started');
  for (const record of candidates) {
    const originalFileName = record.fileName || 'unknown';
    if (!record.attachableId) {
      failed.push({ attachableId: null, fileName: originalFileName, error: 'Missing attachableId', timestamp: new Date().toISOString() });
      completed += 1; progress('in_progress', originalFileName); continue;
    }
    const txnType = record.txnType || (record.orphaned ? 'Orphaned' : 'Unknown');
    const docNumber = record.docNumber || (record.orphaned ? 'N/A' : 'Unknown');
    const fileName = `${sanitize(txnType)}_${sanitize(docNumber)}_${originalFileName}`;
    const result = await downloadFile(record.attachableId, fileName, destFolder, undefined, requestedRealmId);
    completed += 1;
    if (result.success && result.filePath) successful.push({ attachableId: record.attachableId, fileName, txnType, docNumber, filePath: result.filePath, fileSize: fs.statSync(/* turbopackIgnore: true */ result.filePath).size });
    else failed.push({ attachableId: record.attachableId, fileName, error: result.error || 'Unknown error', timestamp: result.timestamp ?? new Date().toISOString() });
    progress('in_progress', fileName);
  }
  progress('completed');
  return { successful, failed, totalAttempted: candidates.length, successfulCount: successful.length, failedCount: failed.length };
}
