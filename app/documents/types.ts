export type DocumentStatus = "pending" | "processing" | "processed" | "failed";

export type EvidenceMatchStatus = "unreviewed" | "verified" | "potential" | "wrong_match" | "duplicate";
export type EvidenceReviewStatus = "not_required" | "required" | "approved" | "discarded";
export type EvidenceRole = "primary" | "additional" | "unassigned";
export type DocumentStatusFilter = "All statuses" | "Matched" | "Additional evidence" | "Duplicate found" | "Needs review" | "Processing failed";
export type DocumentSort = "Newest" | "Oldest" | "Status A–Z" | "Status Z–A";

export type EvidenceTransaction = {
  id: string;
  qboTxnId: string | null;
  type: string | null;
  date: string | null;
  name: string | null;
  amount: number | null;
  documentNumber: string | null;
};

export type StoredDocument = {
  id: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: string;
  status: DocumentStatus;
  processingError?: string | null;
  matchStatus?: EvidenceMatchStatus | null;
  reviewStatus?: EvidenceReviewStatus | null;
  evidenceRole?: EvidenceRole | null;
  matchConfidence?: number | null;
  matchEvidence?: Record<string, unknown> | null;
  candidateTransactionIds?: string[];
  linkedTransaction?: EvidenceTransaction | null;
  proposedTransaction?: EvidenceTransaction | null;
};

export const documentStatusFilters: DocumentStatusFilter[] = [
  "All statuses", "Matched", "Additional evidence", "Duplicate found", "Needs review", "Processing failed",
];

export const documentSortOptions: DocumentSort[] = ["Newest", "Oldest", "Status A–Z", "Status Z–A"];

export function getDocumentStatusLabel(document: StoredDocument) {
  if (document.status === "failed") return "Processing failed";
  if (document.status === "pending") return "Pending";
  if (document.status === "processing") return "Processing";
  if (document.matchStatus === "duplicate") return "Duplicate found";
  if (document.matchStatus === "verified" && document.evidenceRole === "additional" && document.reviewStatus === "required") {
    return "Additional evidence";
  }
  if (["potential", "wrong_match", "unreviewed"].includes(document.matchStatus ?? "") || document.reviewStatus === "required") {
    return "Needs review";
  }
  if (document.matchStatus === "verified") return "Matched";
  return "Needs review";
}

export function getDocumentStatusReason(document: StoredDocument) {
  const label = getDocumentStatusLabel(document);
  if (label === "Processing failed") return document.processingError || "Zevidt could not finish extracting or matching this document.";
  if (label === "Duplicate found") return "The same document content was already found in Zevidt. A person must decide whether to add or discard it.";
  if (label === "Additional evidence") return "This document matches a transaction that already has primary evidence. Approval is required before attaching it to QuickBooks.";
  if (document.matchStatus === "wrong_match") return "The existing document relationship conflicts with the expected transaction and requires correction.";
  if (label === "Needs review") return "Zevidt found an uncertain or incomplete match. Confirm the proposed transaction before anything is attached to QuickBooks.";
  if (label === "Matched") return "The document had sufficient matching evidence and is associated with the transaction shown below.";
  return "Zevidt is still processing this document.";
}

export function getMatchEvidenceDetails(value: Record<string, unknown> | null | undefined) {
  const details: Array<{ label: string; value: string }> = [];
  const visit = (current: unknown, path: string[]) => {
    if (current == null) return;
    if (Array.isArray(current)) {
      if (current.every((item) => item == null || typeof item !== "object")) {
        details.push({ label: path.join(" "), value: current.map(String).join(", ") || "None" });
      } else {
        current.forEach((item, index) => visit(item, [...path, String(index + 1)]));
      }
      return;
    }
    if (typeof current === "object") {
      Object.entries(current as Record<string, unknown>).forEach(([key, nested]) => visit(nested, [...path, key]));
      return;
    }
    details.push({
      label: path.join(" ").replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(),
      value: typeof current === "boolean" ? (current ? "Yes" : "No") : String(current),
    });
  };
  Object.entries(value ?? {}).forEach(([key, nested]) => visit(nested, [key]));
  return details;
}

export type MatchComparisonRow = {
  field: string;
  documentValue: string;
  transactionValue: string;
  matches: boolean;
};

export function getMatchComparisonRows(value: unknown): MatchComparisonRow[] {
  const root = Array.isArray(value) ? value[0] : value;
  if (!root || typeof root !== "object") return [];
  const comparisons = (root as Record<string, unknown>).fieldComparisons;
  if (!Array.isArray(comparisons)) return [];
  const labels: Record<string, string> = {
    vendorName: "Vendor or customer",
    totalAmount: "Amount",
    documentDate: "Date",
    documentNumber: "Document number",
  };
  return comparisons.flatMap((comparison) => {
    if (!comparison || typeof comparison !== "object") return [];
    const row = comparison as Record<string, unknown>;
    const fieldName = typeof row.fieldName === "string" ? row.fieldName : "Field";
    return [{
      field: labels[fieldName] ?? fieldName.replace(/([a-z])([A-Z])/g, "$1 $2"),
      documentValue: row.documentValue == null || row.documentValue === "" ? "Not found" : String(row.documentValue),
      transactionValue: row.transactionValue == null || row.transactionValue === "" ? "Not available" : String(row.transactionValue),
      matches: row.match === true,
    }];
  });
}

export function getMatchComparisonSummary(rows: MatchComparisonRow[]) {
  if (!rows.length) return "Zevidt could not produce a field-by-field comparison.";
  const different = rows.filter((row) => !row.matches).map((row) => row.field.toLowerCase());
  const matching = rows.filter((row) => row.matches).map((row) => row.field.toLowerCase());
  if (!different.length) return `All compared fields agree: ${matching.join(", ")}.`;
  const differenceText = `${different.join(", ")} ${different.length === 1 ? "differs" : "differ"}`;
  return matching.length ? `${differenceText}; ${matching.join(", ")} ${matching.length === 1 ? "agrees" : "agree"}.` : `${differenceText}.`;
}

export const acceptedFileTypes = [".pdf", ".png", ".jpg", ".jpeg", ".webp"];

export const fileTypeFilters = ["All", "PDF", "Image"] as const;

export type FileTypeFilter = (typeof fileTypeFilters)[number];

export function getFileCategory(file: Pick<StoredDocument, "name" | "type">) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (file.type === "application/pdf" || extension === "pdf") return "PDF";
  if (["png", "jpg", "jpeg", "webp"].includes(extension) || file.type.startsWith("image/")) return "Image";
  return "Other";
}

export function isAcceptedFile(file: File) {
  return acceptedFileTypes.includes(`.${file.name.split(".").pop()?.toLowerCase() ?? ""}`);
}
