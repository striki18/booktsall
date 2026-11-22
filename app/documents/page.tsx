"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceHeader, useWordingMode } from "@/app/quickbooks/icons";
import { buildQboTransactionUrl } from "@/lib/qbo-links";
import { DocumentTable } from "./components/document-table";
import { DocumentToolbar } from "./components/document-toolbar";
import { EmptyDocuments } from "./components/empty-documents";
import { UploadDropzone } from "./components/upload-dropzone";
import {
  DocumentSort,
  DocumentStatusFilter,
  FileTypeFilter,
  getDocumentStatusLabel,
  getDocumentStatusReason,
  getMatchComparisonRows,
  getMatchComparisonSummary,
  getFileCategory,
  isAcceptedFile,
  StoredDocument,
} from "./types";

type InboxDocumentResponse = {
  id: string;
  filename: string;
  content_type: string;
  file_size: number;
  uploaded_at: string;
  processing_status?: StoredDocument["status"];
  processing_error?: string | null;
  evidence_match_status?: StoredDocument["matchStatus"];
  evidence_review_status?: StoredDocument["reviewStatus"];
  evidence_role?: StoredDocument["evidenceRole"];
  evidence_match_confidence?: number | null;
  evidence_match_evidence?: Record<string, unknown> | null;
  candidate_qbo_txn_ids?: string[];
  linked_transaction?: StoredDocument["linkedTransaction"];
  proposed_transaction?: StoredDocument["proposedTransaction"];
};

function mapDocument(document: InboxDocumentResponse): StoredDocument {
  return {
    id: document.id,
    name: document.filename,
    type: document.content_type,
    size: Number(document.file_size),
    uploadedAt: document.uploaded_at,
    status: document.processing_status ?? "pending",
    processingError: document.processing_error ?? null,
    matchStatus: document.evidence_match_status ?? null,
    reviewStatus: document.evidence_review_status ?? null,
    evidenceRole: document.evidence_role ?? null,
    matchConfidence: document.evidence_match_confidence ?? null,
    matchEvidence: document.evidence_match_evidence ?? null,
    candidateTransactionIds: document.candidate_qbo_txn_ids ?? [],
    linkedTransaction: document.linked_transaction ?? null,
    proposedTransaction: document.proposed_transaction ?? null,
  };
}

export default function DocumentsPage() {
  const { wording } = useWordingMode();
  const financeMode = wording === "finance";
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FileTypeFilter>("All");
  const [statusFilter, setStatusFilter] = useState<DocumentStatusFilter>("All statuses");
  const [sort, setSort] = useState<DocumentSort>("Newest");
  const [selectedDocument, setSelectedDocument] = useState<StoredDocument | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDownloading, setIsBulkDownloading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState("");

  const loadDocuments = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/firm/inbox", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load documents");
      setDocuments((body.documents ?? []).map(mapDocument));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load documents");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadDocuments(); }, [loadDocuments]);

  const visibleDocuments = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return documents
      .filter((document) =>
        document.name.toLowerCase().includes(normalizedSearch) &&
        (filter === "All" || getFileCategory(document) === filter) &&
        (statusFilter === "All statuses" || getDocumentStatusLabel(document) === statusFilter),
      )
      .sort((left, right) => {
        if (sort === "Newest") return Date.parse(right.uploadedAt) - Date.parse(left.uploadedAt);
        if (sort === "Oldest") return Date.parse(left.uploadedAt) - Date.parse(right.uploadedAt);
        const comparison = getDocumentStatusLabel(left).localeCompare(getDocumentStatusLabel(right));
        return sort === "Status A–Z" ? comparison : -comparison;
      });
  }, [documents, filter, search, sort, statusFilter]);

  useEffect(() => {
    const availableIds = new Set(documents.map((document) => document.id));
    setSelectedIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
  }, [documents]);

  function browseFiles() { inputRef.current?.click(); }

  async function uploadFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    const acceptedFiles = files.filter(isAcceptedFile);
    const rejectedCount = files.length - acceptedFiles.length;
    if (acceptedFiles.length === 0) {
      setMessage(rejectedCount > 0 ? "Choose PDF or image files to upload." : "Choose at least one document to upload.");
      return;
    }

    const formData = new FormData();
    acceptedFiles.forEach((file) => formData.append("files", file));
    setIsUploading(true);
    setMessage("");
    try {
      const response = await fetch("/api/firm/inbox/documents", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Upload failed");
      await loadDocuments();
      const uploaded = body.documents?.length ?? 0;
      setMessage(`${uploaded} document${uploaded === 1 ? "" : "s"} uploaded${rejectedCount ? `; ${rejectedCount} unsupported file${rejectedCount === 1 ? "" : "s"} skipped` : ""}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed. Try again.");
      await loadDocuments();
    } finally {
      setIsUploading(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void uploadFiles(event.target.files);
    event.target.value = "";
  }
  function handleDragOver(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setIsDragging(true); }
  function handleDragLeave() { setIsDragging(false); }
  function handleDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setIsDragging(false); void uploadFiles(event.dataTransfer.files); }

  function openDocumentFile(document: StoredDocument) {
    window.open(`/api/firm/inbox/documents/${encodeURIComponent(document.id)}`, "_blank", "noopener,noreferrer");
  }

  function toggleDocument(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      const allVisibleSelected = visibleDocuments.every((document) => next.has(document.id));
      visibleDocuments.forEach((document) => allVisibleSelected ? next.delete(document.id) : next.add(document.id));
      return next;
    });
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.URL.revokeObjectURL(url);
  }

  async function downloadSelectedDocuments() {
    if (selectedIds.size === 0) return;
    setIsBulkDownloading(true);
    setMessage("");
    try {
      const response = await fetch("/api/firm/inbox/documents/bulk-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: [...selectedIds] }),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || "Unable to download selected documents");
      }
      downloadBlob(await response.blob(), `Zevidt-selected-documents-${new Date().toISOString().slice(0, 10)}.zip`);
      setMessage(`${selectedIds.size} selected document${selectedIds.size === 1 ? "" : "s"} downloaded.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to download selected documents");
    } finally {
      setIsBulkDownloading(false);
    }
  }

  function exportSelectedDocuments() {
    const selected = documents.filter((document) => selectedIds.has(document.id));
    if (selected.length === 0) return;
    const escapeCsv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = [
      ["File name", "File type", "Size bytes", "Uploaded at", "Status", "Transaction type", "Transaction number", "Transaction name", "Transaction amount", "QBO ID"],
      ...selected.map((document) => {
        const transaction = document.linkedTransaction ?? document.proposedTransaction;
        return [document.name, getFileCategory(document), document.size, document.uploadedAt, getDocumentStatusLabel(document), transaction?.type, transaction?.documentNumber, transaction?.name, transaction?.amount, transaction?.qboTxnId];
      }),
    ];
    downloadBlob(new Blob([rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }), `Zevidt-selected-documents-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  async function deleteDocument(id: string) {
    const document = documents.find((item) => item.id === id);
    if (!window.confirm(`Archive ${document?.name ?? 'this document'}? The stored evidence file and audit record will be retained.`)) return;
    try {
      const response = await fetch(`/api/firm/inbox/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to delete document");
      setDocuments((current) => current.filter((document) => document.id !== id));
      setMessage("Archived. The evidence file and audit record remain stored in Zevidt.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete document");
    }
  }

  return (
    <div className="workspacePage">
      <WorkspaceHeader />
      <main className="workspaceContent">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <header className="flex flex-col justify-between gap-6 border-b border-[#e4e7ec] pb-7 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[#3159c9]">Unified inbox</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-normal text-[#101828] sm:text-4xl">{financeMode ? "Documents" : "Bring everything together."}</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-[#667085]">{financeMode ? "Collect and manage the receipts and supporting evidence for your transactions." : "Drop in documents from email, messages, or folders. We’ll organize them for review."}</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={browseFiles} disabled={isUploading} className="h-11 rounded-[9px] bg-[#3e6ae1] px-5 text-sm font-semibold text-white shadow-[0_4px_12px_rgba(62,106,225,0.18)] transition hover:-translate-y-px hover:bg-[#2f56c7] disabled:opacity-60">{isUploading ? "Uploading…" : "Upload documents"}</button>
          </div>
        </header>

        <UploadDropzone inputRef={inputRef} isDragging={isDragging} onBrowse={browseFiles} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} onFileChange={handleFileChange} />
        {message ? <div role="status" className="rounded-xl border border-[#c8e8dc] bg-[#f0fbf6] px-4 py-3 text-sm font-medium text-[#087a55]">{message}</div> : null}
        <DocumentToolbar search={search} filter={filter} statusFilter={statusFilter} sort={sort} totalCount={documents.length} visibleCount={visibleDocuments.length} onSearchChange={setSearch} onFilterChange={setFilter} onStatusFilterChange={setStatusFilter} onSortChange={setSort} />
        {selectedIds.size > 0 ? <div className="sticky top-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#cbd7f7] bg-[#f4f7ff] px-4 py-3 shadow-[0_8px_24px_rgba(49,89,201,.12)]"><p className="text-sm font-semibold text-[#23439a]">{selectedIds.size} selected</p><div className="flex flex-wrap gap-2"><button type="button" onClick={exportSelectedDocuments} className="h-10 rounded-[9px] border border-[#b8c6ea] bg-white px-4 text-sm font-semibold text-[#3159c9] hover:border-[#3e6ae1]">Export CSV</button><button type="button" onClick={() => void downloadSelectedDocuments()} disabled={isBulkDownloading} className="h-10 rounded-[9px] bg-[#3e6ae1] px-4 text-sm font-semibold text-white hover:bg-[#2f56c7] disabled:opacity-60">{isBulkDownloading ? "Preparing…" : "Download ZIP"}</button><button type="button" onClick={() => setSelectedIds(new Set())} className="h-10 px-3 text-sm font-semibold text-[#667085] hover:text-[#101828]">Clear</button></div></div> : null}
        {isLoading ? <p className="rounded-2xl border border-[#e4e7ec] bg-white p-6 text-sm text-[#667085] shadow-[0_1px_3px_rgba(16,24,40,.04)]">Loading documents…</p> : visibleDocuments.length > 0 ? <DocumentTable documents={visibleDocuments} selectedIds={selectedIds} onToggle={toggleDocument} onToggleAll={toggleAllVisible} onView={setSelectedDocument} onDelete={(id) => { void deleteDocument(id); }} /> : <EmptyDocuments hasDocuments={documents.length > 0} onUpload={browseFiles} />}
      </section>
      </main>
      {selectedDocument ? (
        <div className="fixed inset-0 z-50 flex items-end justify-end bg-[#101828]/35 p-4 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="document-details-title" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedDocument(null); }}>
          <section className="max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-[#e4e7ec] bg-white p-5 shadow-[0_24px_64px_rgba(16,24,40,.2)] sm:p-6">
            <div className="flex items-start justify-between gap-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#3159c9]">Document details</p>
                <h2 id="document-details-title" className="mt-2 break-all text-2xl font-semibold text-[#101828]">{selectedDocument.name}</h2>
              </div>
              <button type="button" onClick={() => setSelectedDocument(null)} className="h-10 rounded-[9px] border border-[#d0d5dd] px-4 text-sm font-semibold text-[#344054] hover:bg-[#f8f9fb]">Close</button>
            </div>

            <div className="mt-4 rounded-2xl bg-[#f7f9fc] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#667085]">Status</p>
              <p className="mt-2 text-lg font-semibold text-[#101828]">{getDocumentStatusLabel(selectedDocument)}</p>
              <p className="mt-2 text-sm leading-6 text-[#667085]">{getDocumentStatusReason(selectedDocument)}</p>
            </div>

            {selectedDocument.linkedTransaction || selectedDocument.proposedTransaction ? (() => {
              const transaction = selectedDocument.linkedTransaction ?? selectedDocument.proposedTransaction!;
              const qboUrl = buildQboTransactionUrl(transaction.type, transaction.qboTxnId);
              return <div className="mt-4 rounded-2xl border border-[#dce3f3] bg-[#fbfcff] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#667085]">{selectedDocument.linkedTransaction ? "Linked transaction" : "Proposed transaction"}</p><p className="mt-1 text-base font-semibold text-[#101828]">{transaction.type ?? "Transaction"}{transaction.documentNumber ? ` · ${transaction.documentNumber}` : ""}</p></div>{qboUrl ? <a href={qboUrl} target="_blank" rel="noopener noreferrer" className="rounded-[9px] border border-[#b8c6ea] bg-white px-3 py-2 text-sm font-semibold text-[#3159c9] hover:border-[#3e6ae1]">QBO transaction {transaction.qboTxnId} ↗</a> : <span className="text-sm text-[#667085]">QBO ID unavailable</span>}</div>
                <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
                  <div><dt className="text-[#667085]">Name</dt><dd className="mt-0.5 font-semibold text-[#344054]">{transaction.name ?? "Not available"}</dd></div>
                  <div><dt className="text-[#667085]">Amount</dt><dd className="mt-0.5 font-semibold text-[#344054]">{transaction.amount ?? "Not available"}</dd></div>
                  <div><dt className="text-[#667085]">Date</dt><dd className="mt-0.5 font-semibold text-[#344054]">{transaction.date ?? "Not available"}</dd></div>
                </dl>
              </div>;
            })() : null}

            {(() => {
              const comparisons = getMatchComparisonRows(selectedDocument.matchEvidence);
              if (!comparisons.length) return null;
              return <div className="mt-4 overflow-hidden rounded-2xl border border-[#e4e7ec]">
                <div className="border-b border-[#e4e7ec] bg-[#f8f9fb] px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#667085]">Document compared with QuickBooks</p>
                  <p className="mt-2 text-sm font-medium text-[#344054]">{getMatchComparisonSummary(comparisons)}</p>
                </div>
                <div className="grid grid-cols-[1fr_1.2fr_1.2fr_auto] gap-3 border-b border-[#e4e7ec] px-4 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-[#667085]">
                  <span>Field</span><span>Uploaded document</span><span>QuickBooks</span><span>Result</span>
                </div>
                {comparisons.map((comparison) => <div key={comparison.field} className={`grid grid-cols-[1fr_1.2fr_1.2fr_auto] items-center gap-3 border-b border-[#edf0f4] px-4 py-3 text-sm last:border-0 ${comparison.matches ? "bg-white" : "bg-[#fff7f6]"}`}>
                  <strong className="text-[#344054]">{comparison.field}</strong>
                  <span className={comparison.matches ? "text-[#475467]" : "font-semibold text-[#b42318]"}>{comparison.documentValue}</span>
                  <span className={comparison.matches ? "text-[#475467]" : "font-semibold text-[#b42318]"}>{comparison.transactionValue}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${comparison.matches ? "bg-[#eef8f3] text-[#087a55]" : "bg-[#feeceb] text-[#b42318]"}`}>{comparison.matches ? "Match" : "Different"}</span>
                </div>)}
              </div>;
            })()}

            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => openDocumentFile(selectedDocument)} className="h-11 rounded-[9px] bg-[#3e6ae1] px-5 text-sm font-semibold text-white shadow-[0_4px_12px_rgba(62,106,225,.18)] transition hover:-translate-y-px hover:bg-[#2f56c7]">Open document</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
