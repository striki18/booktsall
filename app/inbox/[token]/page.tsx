"use client";

import { useEffect, useRef, useState } from 'react';
import { uploadEvidenceFiles, type BulkUploadResult } from '@/lib/evidence-bulk-upload';
import { ZevidtLogo } from '@/app/quickbooks/icons';
import styles from './page.module.css';

interface InboxInfo {
  id: string;
  realm_id: string;
  token: string;
  created_at: string;
}

interface UploadedFile {
  id: string;
  filename: string;
  content_type: string;
  file_size: number;
  uploaded_at: string;
  processing_status?: 'pending' | 'processing' | 'processed' | 'failed';
  processing_error?: string | null;
}

export default function InboxPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const [inbox, setInbox] = useState<InboxInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [uploadResult, setUploadResult] = useState<BulkUploadResult | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const initToken = async () => {
      const { token: resolvedToken } = await params;
      if (mounted) {
        setToken(resolvedToken);
      }
    };
    initToken();
    return () => { mounted = false; };
  }, [params]);

  useEffect(() => {
    if (!token) return;
    const fetchInbox = async () => {
      try {
        const res = await fetch(`/api/inbox/${token}`);
        if (!res.ok) {
          throw new Error('Inbox not found');
        }
        const data = await res.json();
        setInbox(data.inbox);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    fetchInbox();
  }, [token]);



  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await uploadFiles(files);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      await uploadFiles(files);
    }
    e.target.value = '';
  };

  const uploadFiles = async (files: File[]) => {
    if (uploadLock.current) return;
    uploadLock.current = true;
    const { token } = await params;
    setUploading(true);
    setUploadResult(null);

    try {
      const result = await uploadEvidenceFiles<UploadedFile>(files,
        body => fetch(`/api/inbox/${encodeURIComponent(token)}/documents`, { method: 'POST', body }),
        document => setUploadedFiles(previous => [document, ...previous]),
        (current, total) => setUploadProgress({ current, total }));
      setUploadResult(result);
    } finally {
      uploadLock.current = false;
      setUploading(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading...</div>
      </div>
    );
  }

  if (error || !inbox) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          <h1>Inbox Not Found</h1>
          <p>The requested inbox could not be found or has expired.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className="mb-8 flex justify-center"><ZevidtLogo /></div>
        <div className={styles.header}>
          <h1>Send your documents</h1>
          <p className={styles.subtitle}>
            Upload the files requested by your team. No account needed.
          </p>
        </div>

        <div aria-live="polite" className="my-4 text-sm">
          {uploading ? <p>Uploading and checking file {uploadProgress.current} of {uploadProgress.total}. Keep this page open.</p> : null}
          {uploadResult ? <div>
            <p>{uploadResult.uploaded} file{uploadResult.uploaded === 1 ? '' : 's'} received.</p>
            {uploadResult.rejected.map((failure, index) => <p key={index}>{failure.filename}: {failure.message}</p>)}
            {uploadResult.uncertain ? <p role="alert">We could not confirm the result for {uploadResult.uncertain}. Please ask your team to check before sending it again. {uploadResult.notSent} remaining files were not sent.</p> : null}
          </div> : null}
        </div>

        <div
          className={`${styles.dropzone} ${dragActive ? styles.dragActive : ''} ${uploading ? styles.uploading : ''}`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <input
            type="file"
            id="file-upload"
            multiple
            onChange={handleFileSelect}
            disabled={uploading}
            className={styles.fileInput}
            aria-label="Select files to upload"
          />
          <label htmlFor="file-upload" className={styles.dropzoneLabel}>
            <div className={styles.uploadIcon}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <p className={styles.dropzoneText}>
              {uploading ? 'Uploading...' : 'Drag & drop files here, or click to select'}
            </p>
            <p className={styles.dropzoneHint}>
              Multiple files supported. No login required.
            </p>
          </label>
        </div>

        {uploadedFiles.length > 0 && (
          <div className={styles.uploadedFiles}>
            <h2 className={styles.sectionTitle}>Uploaded Files ({uploadedFiles.length})</h2>
            <ul className={styles.fileList}>
              {uploadedFiles.map((file) => (
                <li key={file.id} className={styles.fileItem}>
                  <div className={styles.fileInfo}>
                    <div className={styles.fileIcon}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    </div>
                    <div className={styles.fileDetails}>
                      <span className={styles.fileName}>{file.filename}</span>
                      <span className={styles.fileMeta}>
                        {formatFileSize(file.file_size)} • {file.content_type || 'Unknown type'}
                      </span>
                      <span role={file.processing_status === 'failed' ? 'alert' : undefined} className={styles.fileMeta}>
                        Evidence processing: {file.processing_status || 'pending'}{file.processing_error ? ' — ' + file.processing_error : ''}
                      </span>
                    </div>
                  </div>
                  <span className={styles.fileDate}>
                    {new Date(file.uploaded_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
