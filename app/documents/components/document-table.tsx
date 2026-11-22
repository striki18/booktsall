import { formatBytes, formatUploadDate } from "../document-utils";
import { getDocumentStatusLabel, getFileCategory, StoredDocument } from "../types";

type DocumentTableProps = {
  documents: StoredDocument[];
  onView: (document: StoredDocument) => void;
  onDelete: (id: string) => void;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
};

export function DocumentTable({
  documents,
  onView,
  onDelete,
  selectedIds,
  onToggle,
  onToggleAll,
}: DocumentTableProps) {
  const allSelected = documents.length > 0 && documents.every((document) => selectedIds.has(document.id));
  return (
    <section className="overflow-hidden rounded-2xl border border-[#e4e7ec] bg-white shadow-[0_1px_3px_rgba(16,24,40,.04)]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-left text-sm">
          <thead className="bg-[#f8f9fb] text-xs font-semibold uppercase tracking-[0.1em] text-[#667085]">
            <tr>
              <th className="w-12 px-4 py-3"><input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label={allSelected ? "Clear visible selection" : "Select all visible documents"} className="h-4 w-4 accent-[#3e6ae1]" /></th>
              <th className="px-4 py-3">File Name</th>
              <th className="px-4 py-3">File Type</th>
              <th className="px-4 py-3">Size</th>
              <th className="px-4 py-3">Upload Date</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => {
              const statusLabel = getDocumentStatusLabel(document);
              const statusStyle = statusLabel === "Processing failed"
                ? "bg-[#fff1f1] text-[#8a2d2d]"
                : statusLabel === "Matched"
                  ? "bg-[#eef4f2] text-[#345d57]"
                  : "bg-[#fff7e8] text-[#8a5a13]";
              return (
              <tr
                key={document.id}
                className="border-t border-[#edf0f4] text-[#344054] transition hover:bg-[#f8faff]"
              >
                <td className="px-4 py-4"><input type="checkbox" checked={selectedIds.has(document.id)} onChange={() => onToggle(document.id)} aria-label={`Select ${document.name}`} className="h-4 w-4 accent-[#3e6ae1]" /></td>
                <td className="max-w-[280px] px-4 py-4">
                  <span className="block truncate font-semibold">
                    {document.name}
                  </span>
                </td>
                <td className="px-4 py-4">{getFileCategory(document)}</td>
                <td className="px-4 py-4">{formatBytes(document.size)}</td>
                <td className="px-4 py-4">
                  {formatUploadDate(document.uploadedAt)}
                </td>
                <td className="px-4 py-4">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyle}`} title={document.processingError ?? undefined}>
                    {statusLabel}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onView(document)}
                      className="h-9 rounded-lg border border-[#d0d5dd] bg-white px-3 font-semibold text-[#344054] transition hover:border-[#98a2b3] hover:bg-[#f8f9fb]"
                    >
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(document.id)}
                      className="h-9 rounded-lg border border-[#f0c5c1] bg-white px-3 font-semibold text-[#b42318] transition hover:border-[#d57b73] hover:bg-[#fff6f5]"
                    >
                      Archive
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
