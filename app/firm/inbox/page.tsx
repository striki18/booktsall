"use client";

import { useEffect, useState } from 'react';
import { WorkspaceHeader, useWordingMode } from '@/app/quickbooks/icons';
import styles from './page.module.css';

interface CollectionRequest {
  id: string;
  realm_id: string;
  transaction_ids: string[];
  status: string;
  created_at: string;
  inbox_documents?: InboxDocument[];
}

interface InboxDocument {
  id: string;
  realm_id: string;
  storage_path: string;
  filename: string;
  content_type: string;
  file_size: number;
  uploaded_at: string;
}

interface CompanyInbox {
  id: string;
  realm_id: string;
  token: string;
  created_at: string;
}

export default function FirmInboxPage() {
  const { wording } = useWordingMode();
  const financeMode = wording === 'finance';
  const [requests, setRequests] = useState<CollectionRequest[]>([]);
  const [inboxes, setInboxes] = useState<CompanyInbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  const [rotatingInbox, setRotatingInbox] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/firm/inbox');
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || 'Failed to load company inbox');
      }
      const result = await response.json();
      const inboxData = result.inbox ? [result.inbox] : [];
      const requestData = result.requests || [];
      const documentData = result.documents || [];
      setInboxes(inboxData);
      setRequests(requestData.map((request: CollectionRequest) => ({
        ...request,
        inbox_documents: documentData.filter((document: InboxDocument) => document.realm_id === request.realm_id),
      })));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    fetchData();
  }, []);

  const handleRotateInboxToken = async () => {
    try {
      setRotatingInbox(true);
      setError(null);
      const response = await fetch('/api/firm/inbox', { method: 'PATCH' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to rotate inbox link');
      await fetchData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRotatingInbox(false);
    }
  };
  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStatusClass = (status: string) => {
    switch (status) {
      case 'requested': return styles.statusRequested;
      case 'files_uploaded': return styles.statusUploaded;
      default: return styles.statusDefault;
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'requested': return 'Requested';
      case 'files_uploaded': return 'Files Uploaded';
      default: return status;
    }
  };

  const handleToggleExpand = (requestId: string) => {
    setExpandedRequestId(prev => prev === requestId ? null : requestId);
  };

  if (loading) {
    return (
      <div className="workspacePage">
        <WorkspaceHeader />
        <main className="workspaceContent"><div className={styles.container}>
          <div className={styles.loading}>Loading...</div>
        </div></main>
      </div>
    );
  }

  return (
    <div className="workspacePage">
      <WorkspaceHeader />
      <main className="workspaceContent"><div className={styles.container}>
      <header className={styles.header}>
        <h1>{financeMode ? 'Collection requests' : 'Client requests'}</h1>
        <p className={styles.subtitle}>{financeMode ? 'Manage evidence requests and documents received for each company.' : 'Share one simple link. Keep incoming documents and requests together.'}</p>
      </header>

      {error && (
        <div className={styles.error}>
          Error loading data: {error}
          <button className={styles.retryBtn} onClick={fetchData}>Retry</button>
        </div>
      )}

      {/* Inboxes Overview */}
      <section className={styles.section}>
        <h2>Company Inboxes</h2>
        {inboxes.length === 0 ? (
          <p className={styles.empty}>No inboxes created yet.</p>
        ) : (
          <div className={styles.inboxList}>
            {inboxes.map(inbox => (
              <div key={inbox.id} className={styles.inboxCard}>
                <div className={styles.inboxInfo}>
                  <div className={styles.inboxRealmId}>
                    <code>{inbox.realm_id}</code>
                  </div>
                  <div className={styles.inboxToken}>
                    <code>{inbox.token}</code>
                  </div>
                  <div className={styles.inboxLink}>
                    <a 
                      href={`/inbox/${inbox.token}`} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className={styles.inboxLinkUrl}
                    >
                      /inbox/{inbox.token}
                    </a>
                  </div>
                  <div className={styles.inboxCreated}>
                    Created: {formatDate(inbox.created_at)}
                  </div>
                  <button className={styles.retryBtn} onClick={handleRotateInboxToken} disabled={rotatingInbox}>
                    {rotatingInbox ? 'Rotating link...' : 'Rotate inbox link'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Collection Requests */}
      <section className={styles.section}>
        <h2>Collection Requests</h2>
        {requests.length === 0 ? (
          <p className={styles.empty}>No collection requests yet.</p>
        ) : (
          <div className={styles.requestList}>
            {requests.map(request => (
              <div key={request.id} className={styles.requestCard}>
                <div 
                  className={styles.requestHeader}
                  onClick={() => handleToggleExpand(request.id)}
                >
                  <div className={styles.requestMain}>
                    <div className={styles.requestRealm}>
                      <strong>Company:</strong> <code>{request.realm_id}</code>
                    </div>
                    <div className={styles.requestMeta}>
                      <span className={`${styles.statusBadge} ${getStatusClass(request.status)}`}>
                        {getStatusLabel(request.status)}
                      </span>
                      <span className={styles.requestDate}>
                        Created: {formatDate(request.created_at)}
                      </span>
                    </div>
                  </div>
                  <div className={styles.requestToggle}>
                    {expandedRequestId === request.id ? '▲' : '▼'}
                  </div>
                </div>

                {expandedRequestId === request.id && (
                  <div className={styles.requestExpanded}>
                    <div className={styles.requestDetails}>
                      <div className={styles.detailRow}>
                        <strong>Request ID:</strong>
                        <code>{request.id}</code>
                      </div>
                      <div className={styles.detailRow}>
                        <strong>Transactions ({request.transaction_ids.length}):</strong>
                        <div className={styles.txnList}>
                          {request.transaction_ids.map((txnId: string) => (
                            <code key={txnId} className={styles.txnId}>{txnId}</code>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Uploaded Documents */}
                    <div className={styles.documentsSection}>
                      <h4>Uploaded Documents</h4>
                      {request.inbox_documents && request.inbox_documents.length > 0 ? (
                        <table className={styles.docTable}>
                          <thead>
                            <tr>
                              <th>Filename</th>
                              <th>Size</th>
                              <th>Type</th>
                              <th>Uploaded</th>
                              <th>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {request.inbox_documents.map((doc: InboxDocument) => (
                              <tr key={doc.id}>
                                <td>{doc.filename}</td>
                                <td>{formatFileSize(doc.file_size)}</td>
                                <td>{doc.content_type}</td>
                                <td>{formatDate(doc.uploaded_at)}</td>
                                <td>
                                  <a 
                                    href={`/api/firm/inbox/documents/${doc.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={styles.downloadLink}
                                  >
                                    Download
                                  </a>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p className={styles.empty}>No documents uploaded yet.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      </div></main>
    </div>
  );
}
