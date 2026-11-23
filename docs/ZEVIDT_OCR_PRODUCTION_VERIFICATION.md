# Zevidt OCR production verification

Verified locally on 2026-11-23 using the isolated tooling environment under
`C:\Users\veto\.zevidt\tools\ocr`. No customer documents were used.

## Runtime configuration

Zevidt was started with the OCR engine order:

1. PaddleOCR
2. docTR
3. Tesseract

The Python interpreter, OCR worker and Tesseract executable were supplied with
explicit absolute paths. These settings are deployment requirements; merely
installing the engines does not put them on the Next.js server process path.

## Verified fixtures

| Fixture | PaddleOCR | docTR | Tesseract | Zevidt result |
|---|---|---|---|---|
| Clean image | Correct key fields | Non-empty; one character error | Correct key fields | PaddleOCR selected |
| Degraded image | Correct key fields | Correct key fields | Correct key fields | PaddleOCR selected |
| Rotated photo | Correct key fields | Non-empty; key fields incomplete | Non-empty; key fields incomplete | PaddleOCR selected |
| Scanned PDF | Recognized | Available as fallback | Available as fallback | Recognized |
| Blank input | Rejected | Rejected | Rejected | Review required; no invented extraction |

The configured adapter was exercised directly and returned the engine order
`PaddleOCR > docTR > Tesseract`. It selected PaddleOCR for both degraded and
rotated fixtures and returned the expected document number, date and amount.

## Browser and integration verification

The public no-login collection link was opened in a separate unauthenticated
browser session. A degraded JPEG fixture was uploaded to the new Zevidt
development project. The page reported `1 file received` and
`Evidence processing: processed`, proving the upload, private Storage read,
local OCR invocation and processing route operated together.

An initial upload reported `Evidence processing: failed` when the development
server had been started without explicit isolated OCR runtime paths. Restarting
the same server with those paths resolved the failure. No application source
change was required.

## Remaining limit

This verifies local runtime behavior with controlled fixtures. Recognition
quality on varied real customer scans remains a pilot measurement, not a
guaranteed accuracy claim. Every empty or unusable extraction must remain
visible as review required.
