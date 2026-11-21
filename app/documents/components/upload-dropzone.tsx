import { ChangeEvent, DragEvent, RefObject } from "react";
import { acceptedFileTypes } from "../types";

type UploadDropzoneProps = {
  inputRef: RefObject<HTMLInputElement | null>;
  isDragging: boolean;
  onBrowse: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

export function UploadDropzone({
  inputRef,
  isDragging,
  onBrowse,
  onDragOver,
  onDragLeave,
  onDrop,
  onFileChange,
}: UploadDropzoneProps) {
  return (
    <section
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`rounded-2xl border border-dashed p-6 shadow-[0_1px_3px_rgba(16,24,40,.03)] transition sm:p-8 ${
        isDragging
          ? "border-[#3e6ae1] bg-[#eef3ff]"
          : "border-[#cbd2dc] bg-white"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={acceptedFileTypes.join(",")}
        onChange={onFileChange}
        className="sr-only"
      />
      <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-lg font-semibold text-[#101828]">
            Drag and drop files here
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#667085]">
            Upload PDF files and images (PNG, JPEG, or WebP).
            Multiple files are supported.
          </p>
        </div>
        <button
          type="button"
          onClick={onBrowse}
          className="h-11 rounded-[9px] border border-[#d0d5dd] bg-white px-5 text-sm font-semibold text-[#344054] transition hover:border-[#3e6ae1] hover:text-[#3159c9]"
        >
          Choose files
        </button>
      </div>
    </section>
  );
}
