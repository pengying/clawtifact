# Artifact Feedback Implementation Plan

> Execute task-by-task in the current session; use test-driven-development.

**Goal:** Floating, cross-format artifact annotations sent in batches for discussion in the originating channel/thread.
**Architecture:** Trusted overlay host plus opaque sandboxed content frame. Authenticated CSRF-protected feedback endpoint dispatches to an SDK-captured session target, with idempotency and explicit delivery states.
**Tech Stack:** JavaScript, Node 24 SQLite/HTTP, esbuild, browser DOM, OpenClaw session-event SDK.

### 1. Freeze design and baseline
Files: docs/plans/2026-11-02-feedback-design.md. Create worktree, install locked dependencies, build/test baseline (expect 19 passes); commit approved design.
### 2. Implement bounded feedback validation and delivery broker
Create src/feedback.js and test/feedback.test.js. Write failing tests for limits, unsafe anchors, original-route capture, idempotency, dispatch rejection, delivered vs queued vs uncertain, restart fail-closed and cleanup. Run node --test test/feedback.test.js (expect missing-feature failure). Implement broker and rerun until green. Captured handles remain server-only.
### 3. Implement trusted host/frame and HTTP feedback routes
Modify src/http.js, src/render.js, src/store.js, index.js. Add test/feedback-http.test.js first: outsider/expired/cross-Origin/missing-CSRF cannot submit; payload never chooses route; duplicate requests dispatch once; original HTML only lives in sandboxed content endpoint. Run failing tests, implement and rerun. Adapt prior tests to inspect the content endpoint without relaxing protections.
### 4. Build frontend overlay and content bridge
Create web/feedback.js, web/feedback.css, web/bridge.js and test/feedback-ui.test.js. Test frontend state/protocol before implementing; ensure untrusted strings use textContent and child messages cannot send feedback. Parent-only send control, mobile bottom sheet, draft edit/delete, text/region/general anchors and delivery states. Parallel work is limited to these frontend files/tests under the documented contract; backend owned by main agent.
### 5. Integrate assets and browser verification
Modify scripts/build.js to bundle new entries; publish only allowlisted static assets with CORS for opaque-frame module resources. Build/test full suite. Use OpenClaw browser for local QA of both formats, submission, edit/delete, spoofed child messages, queued vs delivered, expiry and mobile sizing. If browser access is blocked, report exact limitation, do not substitute an unapproved browser route.
### 6. Review and completion
Update README.md and security docs with overlay/routing/restart limitation. Run npm audit, local static/secret checks, full tests and independent security autoreview against v0.1.0. Fix verified findings and rerun affected gates. Commit reviewable feature; do not silently deploy or submit a new ClawHub version before checks complete.
