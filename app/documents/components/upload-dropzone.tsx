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
      className={`rounded-md border border-dashed p-6 transition sm:p-8 ${
        isDragging
          ? "border-[#3e6ae1] bg-[#eef3ff]"
          : "border-[#bfc7d3] bg-white"
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
          <h2 className="text-lg font-semibold text-[#172033]">
            Drag and drop files here
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#5d6675]">
            Upload PDF files and images (PNG, JPEG, or WebP).
            Multiple files are supported.
          </p>
        </div>
        <button
          type="button"
          onClick={onBrowse}
          className="h-11 rounded-lg border border-[#cfd4dc] bg-white px-5 text-sm font-semibold text-[#171a20] transition hover:border-[#3e6ae1] hover:text-[#3159c9]"
        >
          Upload Documents
        </button>
      </div>
    </section>
  );
}
