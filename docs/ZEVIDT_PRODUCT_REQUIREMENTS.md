# Zevidt Product Requirements

## Product

Zevidt is a QuickBooks Online-integrated audit-evidence management platform. Its core job is to show which in-scope transactions are missing supporting documents or need review, help collect and match evidence, and produce traceable evidence packages.

## Confirmed product requirements

### Evidence matching and review

1. **First verified evidence:** If there is no existing evidence for the transaction in Zevidt or QuickBooks Online, a verified first evidence item may be automatically attached to the correct QBO transaction. Zevidt must read the attachment back, verify its transaction association, and record the result.
2. **Additional evidence:** When evidence already exists and another document is a certain match, classify it as **ADDITIONAL EVIDENCE — REVIEW REQUIRED**. After reviewer approval and final confirmation, attach it to QBO, read it back, verify the transaction association, and record the outcome.
3. **Uncertain match:** Classify it as **POTENTIAL EVIDENCE — REVIEW REQUIRED**, retaining the proposed transaction for review.
4. **Duplicate:** Classify it as **DUPLICATE FOUND — REVIEW REQUIRED** and provide human **Add** and **Discard** decisions. **Add** approves it as additional evidence and permits attachment to the correct QBO transaction only after final confirmation and verification. **Discard** marks it discarded but preserves the document and immutable audit history in Zevidt; it is not attached to QBO.
5. If a document is an exact byte-for-byte duplicate of evidence already attached to QBO, do not upload identical bytes again. Link the Zevidt evidence item to the existing QBO attachment and record the duplicate relationship.
6. Replace, remove, overwrite, or discard evidence only after human approval. Discard does not delete the stored document or its audit history.
7. Allow at most one primary evidence item per transaction. Preserve additional evidence and review history rather than overwriting the primary item.
8. Make every evidence and review action traceable to an audit event. The event schema and retention requirements remain to be defined; do not treat mutable current-state fields as an audit log.
9. Never modify QBO financial fields.
10. Enforce company isolation, concurrency safety, and idempotency. Retries must not create duplicate evidence items or QBO attachments, and concurrent first-evidence decisions must not create two primary items.

### Document extraction

- Use the local OCR fallback order PaddleOCR → docTR → Tesseract for scanned PDFs and images.
- If an engine fails or returns no readable text, try the next configured engine. If all configured engines fail, route the document to human review; never invent or silently accept extraction results.
- OCR providers process evidence locally. Model downloads require explicit opt-in; cloud OCR is not enabled by this requirement.

### Collection and workflow

- Support bulk document upload so a firm or business can collect documents from its existing channels and submit them together.
- The initial workflow does not read email or WhatsApp automatically. A person downloads documents from those channels and bulk uploads them.
- Provide a unique business upload link that clients can use without creating an account or signing in.
- Surface the four transaction-register states: `MATCHED`, `MISSING`, `REVIEW_REQUIRED`, and `WRONG_MATCHED`, with useful sorting and filtering.
- Make the transaction link in the register open the corresponding QBO transaction page so a user can attach a document there manually when needed. This link is navigation; it does not authorize Zevidt to change financial fields.
- Keep a clear connection action on the homepage. On other pages, explain when connecting QBO is needed to show more data or information.
- Provide an **Audit Packages** tab as a placeholder. Do not invent audit-type requirements; the user will define them later.

### Product language and interface

- Use familiar language first, with finance/accounting terminology available where useful.
- Provide a General / Finance wording toggle. It changes wording only; it does not by itself change layout, typography, visual style, or button placement.
- Design for approachable everyday use as well as bookkeeping, accounting, and audit teams. Do not remove or simplify away the evidence controls above.

## Evidence package requirements

- A package should preserve evidence references and review decisions so a reviewer can understand what was included and why.
- Package generation must not silently replace evidence or erase review history.
- Audit-type-specific package contents and request checklists are not specified yet. The Audit Packages tab remains a placeholder until those requirements are supplied.

## Testing and acceptance

Testing must verify real behavior rather than simulated success. For each test, record expected versus actual behavior and mark it **PASS**, **FAIL**, or **BLOCKED**. A PASS requires captured runtime evidence for the behavior being claimed; mocked or local-only results must be labeled accordingly.

For end-to-end acceptance, preserve screenshots, sanitized logs, request/response evidence, and relevant database/QBO verification results. Record the user journey precisely: pages, buttons, clicks, inputs, API calls, database effects, and QBO attachment outcome. Never include credentials, tokens, or unnecessary customer information in evidence artifacts.

### Sandbox scenario target

- Use 66 QBO sandbox transactions.
- Use approximately 76 realistic documents associated with 58 transactions, leaving 8 transactions intentionally without evidence.
- Include multiple documents for some transactions and exercise correct matches, wrong matches, uncertain matches, duplicates, additional evidence, approval, discard, missing evidence, and attachment verification.
- This is a test-coverage target, not a rule that all customer engagements must have 66 transactions or these document counts.
- Keep the QBO sandbox and Supabase test company isolated from the protected old AuditReady environment.

## Confirmed code/documentation context

These are observations about the repository, not claims that the features have passed live integration testing:

- `lib/qbo-evidence-register.ts` defines the four register states and states that automatic matching must not create `WRONG_MATCHED`; that state is for a proven incorrect pre-existing QBO attachment.
- `lib/output.ts` places `MATCHED`, `REVIEW_REQUIRED`, and `WRONG_MATCHED` in the evidence register output and `MISSING` entries in the missing-documents output.
- `app/api/evidence/register/[id]/decisions/route.ts` and the review interface expose a human review workflow and decision history.
- `lib/qbo-links.ts` builds QBO transaction links.
- The additive `qbo_evidence_items` migration defines one-primary-per-transaction and same-realm foreign keys. Its presence in source does not prove it is applied to a database or that its protections work at runtime.
- The README is still the generic Next.js starter guide. `PRODUCT.md`, `ARCHITECTURE.md`, and `ROADMAP.md` contain no substantive product requirements. `BOOKTSALL_IMPLEMENTATION_PROGRESS.md` tracks implementation findings and verification status; it is not authority to silently change the product requirements here.

## Assumptions and unresolved questions

Do not silently resolve these questions in code or UI. Ask the product owner when the answer is needed:

1. What exact evidence and match signals qualify as “verified” or “certain,” and what confidence threshold, if any, is acceptable for automatic QBO attachment?
2. How must Zevidt establish that no evidence exists both in its own records and in QBO, and what should happen when QBO attachment discovery is incomplete or unavailable?
3. What audit-event fields, immutability mechanism, retention period, and export behavior are required?
4. What should happen after an ambiguous QBO upload response, when retrying could create a duplicate attachment?
5. What are the detailed evidence requirements, client requests, and package contents for each audit type?
6. Are reminders part of the initial release? If so, who triggers them, and may Zevidt send messages or only show reminders to the firm?
7. Which matching rules should be enabled, and what review behavior applies when extraction or matching is inconclusive?

Until answered, preserve evidence, avoid automatic destructive decisions, and mark unverified behavior **BLOCKED** rather than assuming it works.
