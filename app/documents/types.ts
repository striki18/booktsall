export type DocumentStatus = "pending" | "processing" | "processed" | "failed";

export type StoredDocument = {
  id: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: string;
  status: DocumentStatus;
  processingError?: string | null;
};

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
