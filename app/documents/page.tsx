"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceHeader, useWordingMode } from "@/app/quickbooks/icons";
import { DocumentTable } from "./components/document-table";
import { DocumentToolbar } from "./components/document-toolbar";
import { EmptyDocuments } from "./components/empty-documents";
import { UploadDropzone } from "./components/upload-dropzone";
import { FileTypeFilter, getFileCategory, isAcceptedFile, StoredDocument } from "./types";

type InboxDocumentResponse = {
  id: string;
  filename: string;
  content_type: string;
  file_size: number;
  uploaded_at: string;
  processing_status?: StoredDocument["status"];
  processing_error?: string | null;
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
  };
}

export default function DocumentsPage() {
  const { wording } = useWordingMode();
  const financeMode = wording === "finance";
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FileTypeFilter>("All");
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
    return documents.filter((document) =>
      document.name.toLowerCase().includes(normalizedSearch) &&
      (filter === "All" || getFileCategory(document) === filter),
    );
  }, [documents, filter, search]);

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

  function viewDocument(document: StoredDocument) {
    window.open(`/api/firm/inbox/documents/${encodeURIComponent(document.id)}`, "_blank", "noopener,noreferrer");
  }

  async function deleteDocument(id: string) {
    const document = documents.find((item) => item.id === id);
    if (!window.confirm(`Remove ${document?.name ?? 'this document'} from the inbox? The stored evidence file and audit record will be retained.`)) return;
    try {
      const response = await fetch(`/api/firm/inbox/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to delete document");
      setDocuments((current) => current.filter((document) => document.id !== id));
      setMessage("Removed from the inbox. The evidence file and audit record remain stored in Zevidt.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete document");
    }
  }

  return (
    <div className="workspacePage">
      <WorkspaceHeader />
      <main className="workspaceContent">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="flex flex-col justify-between gap-5 border-b border-[#d9dde5] pb-6 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#55706d]">Zevidt inbox</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-normal text-[#172033] sm:text-4xl">{financeMode ? "Documents" : "Bring everything together."}</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-[#5d6675]">{financeMode ? "Collect and manage the receipts and supporting evidence for your transactions." : "Drop in documents from email, messages, or folders. We’ll organize them for review."}</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={browseFiles} disabled={isUploading} className="h-11 rounded-lg bg-[#3e6ae1] px-5 text-sm font-semibold text-white shadow-[0_4px_12px_rgba(62,106,225,0.22)] transition hover:bg-[#3159c9] disabled:opacity-60">{isUploading ? "Uploading…" : "Upload documents"}</button>
          </div>
        </header>

        <UploadDropzone inputRef={inputRef} isDragging={isDragging} onBrowse={browseFiles} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} onFileChange={handleFileChange} />
        {message ? <div role="status" className="rounded-md border border-[#d7e2df] bg-[#eef4f2] px-4 py-3 text-sm font-medium text-[#345d57]">{message}</div> : null}
        <DocumentToolbar search={search} filter={filter} totalCount={documents.length} visibleCount={visibleDocuments.length} onSearchChange={setSearch} onFilterChange={setFilter} />
        {isLoading ? <p className="rounded-md border border-[#d9dde5] bg-white p-6 text-sm text-[#5d6675]">Loading documents…</p> : visibleDocuments.length > 0 ? <DocumentTable documents={visibleDocuments} onView={viewDocument} onDelete={(id) => { void deleteDocument(id); }} /> : <EmptyDocuments hasDocuments={documents.length > 0} onUpload={browseFiles} />}
      </section>
      </main>
    </div>
  );
}
