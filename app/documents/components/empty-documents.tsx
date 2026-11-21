type EmptyDocumentsProps = {
  hasDocuments: boolean;
  onUpload: () => void;
};

export function EmptyDocuments({ hasDocuments, onUpload }: EmptyDocumentsProps) {
  return (
    <section className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-[#e4e7ec] bg-white p-8 text-center shadow-[0_1px_3px_rgba(16,24,40,.04)]">
      <div className="mb-5 grid size-12 place-items-center rounded-xl bg-[#eef3ff] text-[#3159c9]" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M7 3.5h7l3 3V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5v4h4M9 13h6M9 16.5h4"/></svg>
      </div>
      <h2 className="text-2xl font-semibold text-[#101828]">
        {hasDocuments ? "No matching documents" : "No documents uploaded yet"}
      </h2>
      <p className="mt-3 max-w-md text-sm leading-6 text-[#667085]">
        {hasDocuments
          ? "Adjust your search or file type filter to see more documents."
          : "Upload source files, supporting schedules, contracts, receipts, and other evidence into this workspace."}
      </p>
      {!hasDocuments ? (
        <button
          type="button"
          onClick={onUpload}
          className="mt-7 h-12 rounded-[9px] bg-[#3e6ae1] px-6 text-base font-semibold text-white shadow-[0_6px_18px_rgba(62,106,225,0.18)] transition hover:-translate-y-px hover:bg-[#2f56c7]"
        >
          Upload Documents
        </button>
      ) : null}
    </section>
  );
}
