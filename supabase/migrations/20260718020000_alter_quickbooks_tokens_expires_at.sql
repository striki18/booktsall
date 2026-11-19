-- Migration: alter_quickbooks_tokens_expires_at
-- Convert legacy epoch-second values to timestamptz. The initial schema already
-- declares expires_at as timestamptz, so fresh installations must leave it as-is.
DO $migration$
DECLARE
  expires_at_type text;
BEGIN
  SELECT format_type(attribute.atttypid, attribute.atttypmod)
    INTO expires_at_type
    FROM pg_attribute AS attribute
   WHERE attribute.attrelid = 'quickbooks_tokens'::regclass
     AND attribute.attname = 'expires_at'
     AND NOT attribute.attisdropped;

  IF expires_at_type = 'bigint' THEN
    ALTER TABLE quickbooks_tokens
      ALTER COLUMN expires_at TYPE timestamp with time zone
      USING to_timestamp(expires_at);
  ELSIF expires_at_type = 'timestamp with time zone' THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Unexpected quickbooks_tokens.expires_at type: %', expires_at_type;
  END IF;
END
$migration$;
