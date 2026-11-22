import {
  DocumentSort,
  DocumentStatusFilter,
  FileTypeFilter,
  documentSortOptions,
  documentStatusFilters,
  fileTypeFilters,
} from "../types";

type DocumentToolbarProps = {
  search: string;
  filter: FileTypeFilter;
  statusFilter: DocumentStatusFilter;
  sort: DocumentSort;
  totalCount: number;
  visibleCount: number;
  onSearchChange: (value: string) => void;
  onFilterChange: (value: FileTypeFilter) => void;
  onStatusFilterChange: (value: DocumentStatusFilter) => void;
  onSortChange: (value: DocumentSort) => void;
};

export function DocumentToolbar({
  search,
  filter,
  statusFilter,
  sort,
  totalCount,
  visibleCount,
  onSearchChange,
  onFilterChange,
  onStatusFilterChange,
  onSortChange,
}: DocumentToolbarProps) {
  return (
    <section className="grid gap-4 rounded-2xl border border-[#e4e7ec] bg-white p-4 shadow-[0_1px_3px_rgba(16,24,40,.04)] sm:grid-cols-2 xl:grid-cols-[minmax(260px,1fr)_170px_190px_160px_auto] xl:items-end">
      <label className="block">
        <span className="text-sm font-semibold text-[#344054]">Search</span>
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search by file name"
          className="mt-2 h-11 w-full rounded-[9px] border border-[#d0d5dd] bg-white px-3 text-sm outline-none transition placeholder:text-[#98a2b3] focus:border-[#3e6ae1] focus:ring-4 focus:ring-[#eef3ff]"
        />
      </label>

      <label className="block">
        <span className="text-sm font-semibold text-[#344054]">Status</span>
        <select value={statusFilter} onChange={(event) => onStatusFilterChange(event.target.value as DocumentStatusFilter)} className="mt-2 h-11 w-full rounded-[9px] border border-[#d0d5dd] bg-white px-3 text-sm outline-none transition focus:border-[#3e6ae1] focus:ring-4 focus:ring-[#eef3ff]">
          {documentStatusFilters.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-semibold text-[#344054]">Sort by</span>
        <select value={sort} onChange={(event) => onSortChange(event.target.value as DocumentSort)} className="mt-2 h-11 w-full rounded-[9px] border border-[#d0d5dd] bg-white px-3 text-sm outline-none transition focus:border-[#3e6ae1] focus:ring-4 focus:ring-[#eef3ff]">
          {documentSortOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-semibold text-[#344054]">
          File type
        </span>
        <select
          value={filter}
          onChange={(event) =>
            onFilterChange(event.target.value as FileTypeFilter)
          }
          className="mt-2 h-11 w-full rounded-[9px] border border-[#d0d5dd] bg-white px-3 text-sm outline-none transition focus:border-[#3e6ae1] focus:ring-4 focus:ring-[#eef3ff]"
        >
          {fileTypeFilters.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <div className="rounded-[9px] border border-[#e4e7ec] bg-[#f8f9fb] px-4 py-3 text-sm text-[#667085]">
        <span className="font-semibold text-[#101828]">{visibleCount}</span> of{" "}
        <span className="font-semibold text-[#101828]">{totalCount}</span>{" "}
        documents
      </div>
    </section>
  );
}
