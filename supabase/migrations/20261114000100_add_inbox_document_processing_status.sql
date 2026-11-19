-- Persist document processing state so upload success cannot hide extraction/matching failures.
ALTER TABLE public.inbox_documents
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS processing_error TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inbox_documents_processing_status_check'
      AND conrelid = 'public.inbox_documents'::regclass
  ) THEN
    ALTER TABLE public.inbox_documents
      ADD CONSTRAINT inbox_documents_processing_status_check
      CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed'));
  END IF;
END $$;
