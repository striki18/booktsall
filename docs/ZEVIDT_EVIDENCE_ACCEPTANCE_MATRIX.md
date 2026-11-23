# Zevidt Evidence Acceptance Matrix

Updated: 2026-11-23

This matrix is the release gate for Zevidt's evidence workflow. A local or mocked test does not count as live acceptance. Each row records the strongest verification currently available and remains `BLOCKED` until its required runtime evidence exists.

## Test environment

- Supabase project: `ozruxywdztetkpykmvmh`
- QuickBooks sandbox realm: `9341458707866620`
- Dataset target: 66 selected QBO transactions, approximately 76 evidence documents across 58 transactions, and 8 intentionally missing controls
- Protected AuditReady resources are outside this test boundary.

## Acceptance matrix

| ID | Scenario | Required outcome | Automated verification | Live verification | Status |
| --- | --- | --- | --- | --- | --- |
| E-01 | Sandbox inventory | All 66 selected transactions resolve to the intended QBO entity and amount. | Transaction parsing and canonical-type tests pass. | 66 selected Invoice, Bill, and Purchase entities returned HTTP 200 and were compared with the register. | PASS |
| E-02 | Dataset coverage | About 76 documents cover 58 transactions; 8 controls remain without evidence. | Fixture and bulk-selection tests pass. | 76 inbox documents were submitted and the 8 controls remained without evidence references. | PASS |
| E-03 | First conclusive evidence | Elect one primary item, attach once to the correct QBO transaction, read it back, and preserve exact bytes. | First-evidence, idempotency, attachment-event, and concurrency tests pass. | A scanned PDF became primary on Invoice `10`; QBO attachment `1000000001` was read back with the intended relationship and matching SHA-256. | PASS |
| E-04 | Existing QBO evidence | Treat a later certain document as additional evidence rather than replacing the existing attachment. | Evidence-item and review-gate tests pass. | Existing QBO evidence was retained while later evidence entered review. | PASS |
| E-05 | Additional evidence approval | Require human approval, attach once, read back, and retain the original evidence. | Review and upload-once tests pass. | The owner approved additional evidence; attachment `1000000011` was read back from Invoice `10` with matching SHA-256 while the original remained intact. | PASS |
| E-06 | Additional evidence discard | Preserve stored bytes and immutable decision history; do not upload to QBO. | Discard/package-overlay regression passes. | Trusted review recorded discard, retained the Storage object, and recorded zero QBO attempts. | PASS |
| E-07 | Exact duplicate on same transaction | Require review; Add reuses the existing QBO attachment instead of uploading identical bytes. | Duplicate and upload-once tests pass. | Human duplicate Add reused the original attachment and created no second QBO upload. | PASS |
| E-08 | Duplicate discard | Preserve the file and audit event; exclude it from QBO and package eligibility. | Archive, discard, and package-overlay tests pass. | Human discard retained exact Storage bytes, created no QBO attempt, and excluded the file from a fresh package. | PASS |
| E-09 | Exact bytes already attached to another transaction | Do not upload identical bytes again; require review because the proposed association is ambiguous. | Cross-transaction guard regression passes. | A controlled wrong-link case proved the risk; the fail-closed guard now prevents another upload. A supported QBO relink operation is not assumed. | PASS |
| E-10 | Potential match | Retain the proposed transaction and require human confirmation before approval or upload. | Potential-match and transaction-search tests pass. | A human confirmed the proposed transaction in the review UI; the item remained behind the additional-evidence approval gate. | PASS |
| E-11 | Wrong pre-existing QBO attachment | Show `WRONG_MATCHED` only after proving the existing QBO association is incorrect; preserve correct and actual targets. | Wrong-match identity and package-overlay tests pass. | Controlled sandbox attachment `1000000063` was verified on the wrong target; the register preserved actual target `12`, correct target `9`, and prior evidence. | PASS |
| E-12 | Amount-only mismatch | Search other transactions and require review; never discard or create `WRONG_MATCHED` automatically. | Matching regressions cover amount mismatch and competing candidates. | A live amount-mismatch document was classified as additional evidence for its already-evidenced transaction and was not auto-attached; QBO attachable count stayed unchanged. | PASS |
| E-13 | Vendor or reference uncertainty | Require review and show field-level comparison without inventing values. | Field-comparison and matching tests pass. | Live vendor, reference, and mixed-document fixtures remained review-only with zero QBO attempts. | PASS |
| E-14 | Concurrent first-evidence submissions | Elect at most one primary and create at most one QBO attachment. | Database uniqueness and concurrent workflow tests pass. | The original concurrent case was recovered and independently verified as one primary, one additional, one upload attempt, and one QBO attachment. A fresh post-fix simultaneous browser replay is still required. | BLOCKED |
| E-15 | Missing evidence | Keep the intentionally empty controls `MISSING` with no fabricated document references. | Missing-state and output-split tests pass. | All 8 selected controls remained missing throughout the dataset run. | PASS |
| E-16 | Package generation | Include eligible evidence and decisions, exclude pending/discarded evidence, report failures, and verify every manifest hash. | Package, lifecycle, persistence, and ZIP tests pass. | Latest browser-generated package contained 47/47 expected files, zero failures, verified all SHA-256 values, and produced 76 register rows plus 98 missing rows. | PASS |
| E-17 | Package rerun | Preserve review decisions and earlier package versions; do not mutate register state. | Package rerun and persistence tests pass. | A scoped live rerun preserved primary, duplicate decision, and approved additional evidence with unchanged register/item/event digests. On 2026-11-23 the authenticated Package Library displayed versions 1 and 2 with the previous-version link, and a historical 107 KB ZIP downloaded successfully through the browser. | PASS |
| E-18 | Inbox archive | Remove the item from active inbox without deleting evidence bytes or history. | Archive API and immutable-event tests pass. | Live archive returned HTTP 200; active count returned from 77 to 76 and the archived filename disappeared from active search. Storage/history retention is covered by prior live database verification. | PASS |
| E-19 | Company isolation | Prevent anonymous and cross-company evidence access and direct client mutation. | RLS migration and API authorization tests pass. | Live role tests rejected anonymous/cross-company access and direct item updates while allowing same-company reads. | PASS |
| E-20 | Full authenticated browser journey | Complete upload, inbox explanation, review, QBO verification, register filtering, package generation, version download, and rerun from one signed-in session. | Component/API regressions pass. | The isolated browser session opened on 2026-11-23 but was not authenticated or connected. | BLOCKED |

## Release rule

The evidence acceptance gate is complete only when every row is `PASS`. Rows E-14 and E-20 still require an authenticated browser run. They must not be converted to `PASS` from API calls, database inspection, or mocked tests alone.

## Evidence handling

- Runtime artifacts, screenshots, and sanitized logs must remain outside Git when they can contain user, company, transaction, or document data.
- Never record credentials, OAuth tokens, database passwords, or full private document contents in this matrix.
- When a live result is rerun, update the row with the new date and strongest observed evidence; do not erase earlier failures or compensating actions from the immutable system history.
