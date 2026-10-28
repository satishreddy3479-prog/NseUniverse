---
name: review-code
description: Read-only review of NSE Universe changes for correctness, security, financial-data integrity, and maintainability, reported by severity. Use when asked to review code or a diff.
---
# Review changes
Do **not** modify files unless the user explicitly asks for fixes.

Check:
- Functional bugs and incorrect assumptions
- Security (secrets, validation, auth, logging redaction)
- Financial-data integrity (missing values, timestamps, provenance, mock vs real, formulas)
- Concurrency and WebSocket lifecycle (leaks, reconnects, duplicates, races)
- Missing or weak tests
- Performance and resource use
- UI state consistency (loading/empty/error/stale)
- Documentation gaps and backward compatibility

Report findings grouped by severity (Critical / High / Medium / Low), each with `file:line`, the problem, and a suggested fix. State what you did not review.
