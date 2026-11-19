# Verification and limitations

## Live revisions 0.4

The release adds six source formats, plugin-owned immutable revisions, CAS and
idempotent publication, SSE full-state reconciliation, canonical agent notes and
revision-pinned feedback/images/Chat. Test coverage includes prior delivery guards,
legacy migration, concurrency, restore/reopen, stale frames and interrupted replies.
Check the release evidence for the final count; earlier counts are not a new run.

### Migration, backup and rollback

- Durable state remains `artifacts/artifacts.sqlite` beneath the host state root.
  Manifest `backupResources` declares the complete `artifacts` directory, including
  verified pre-migration checkpoints. There are no core schema changes.
- Use a **serial** supported plugin reload. The old service must stop, drain and
  close its SQLite connection before the new service starts. This plugin declares
  no generation overlap. Never run a candidate process against the live state file.
- Before changing the selected runtime, retain the exact old payload, dependency
  lock and configured load paths. Rehearse against a consistent database copy.
- At new store startup, an existing old schema is checkpointed **before journal or
  schema writes** with native SQLite `VACUUM INTO`, incorporating any committed WAL
  data. The checkpoint is exclusively created at mode0600 alongside the database:
  `artifacts.sqlite.pre-migration-v<version>-<timestamp>-<random>.sqlite`.
- Verification reopens the checkpoint read-only, checks integrity, schema, table
  counts, source bytes and streamed content/claim digests. A failure aborts schema
  mutation. The checkpoint is diagnostic state, not an automatically applied
  rollback. New/current-schema databases do not create a checkpoint every open.
- Record and verify the checkpoint path from store diagnostics and compare the
  activated source/assets. Restore a test copy with the old runtime to qualify it.
- Rollback stops new writers, closes SQLite and restores the matched **old runtime
  plus old database snapshot together**. Do not run old code against the migrated
  live database. Preserve later state separately for reconciliation. Keep backup
  retention bounded operationally: backups can retain content after revocation.

### Qualification boundaries

Unit/HTTP tests are not real browser proof. The browser tool rejected the initial
loopback QA navigation; no raw Playwright/CDP bypass was used. Real desktop/mobile
and production SSE acceptance must be recorded separately after supported access.
Physical Android Chrome and Safari are not inferred from desktop or fake-DOM tests.
WhatsApp/Google Chat delivery is channel-generic in the design but not newly
live-qualified by this release.

## Automatic rendered region previews (2026-11-08)

The optional-preview flow generates a local JPEG after selecting a region. No pixels upload until explicit batch Send. Tests cover source/request IDs, image format/size, timeout/navigation, current-state geometry, image cancellation, repeated rectangle adjustment, stale editor state, upload-on-Send and safe unsupported-layout fallback.

Actual Chrome QA produced JPEGs from a disposable HTML artifact using the current sandbox/CSP. Empty image elements initially caused a library image-load failure; excluding empty sources fixed that case. Snapshotting while render is still running can itself mutate the document and correctly reject a capture. Wait for completion before inspecting the result. Full parent integration, original-session image ingestion and physical mobile/Safari acceptance must be recorded separately, not inferred from this smoke check.


## Selector / screenshot / Chat development qualification (2026-11-07)

The implementation branch adds editable parent-owned rectangles, batch comments,
cross-browser screenshot upload/crop preview, verified-own-tab optional capture,
native original-session screenshot reads, and scoped Chat with canonical source
mirroring. Tests cover HTTP claim/CSRF/expiry, original route+incarnation identity,
image limits and normalization reservations, no upload before explicit Send,
stale crop handling, no duplicate Chat inference/mirroring, and private-history
exclusion from the artifact-only prompt.

Actual installed runtime media helpers were exercised independently: generated
PNG16x16 decoded, resized to JPEG8x8, and a synthetic EXIF privacy marker was
absent after re-encoding. Image unit fixtures otherwise use injected codecs;
this smoke check is not a malicious-image fuzzing campaign.

The native browser tool refused loopback QA navigation with `browser navigation
blocked by policy`; no raw browser/CDP workaround was used. Physical Android/iOS
Chrome, macOS/iOS Safari, own-tab permission-picker behavior, and live configured
model/original-channel delivery require separate recorded integration results.
Do not describe those as verified from Node tests or mocked provider callbacks.

Public runtime integration must retain these boundaries: no LLM dispatch in
anonymous HTTP handlers; no retained old delivery capability; exact agent,
session, session incarnation, channel/account/target/thread plus current invocation
checks on native tools; no bundled-only attachment API or raw channel fallback.
Native image output to the original model is distinct from binary image mirroring
to a channel. Screenshot tool reads do not silently perform the latter.

Historical verification below describes earlier release/deployment work.

The pre-release implementation passed 19 automated tests covering storage,
atomic claims, access/expiry/revocation, both content formats, HTTP policy,
closed-idle behavior, and bounded tunnel lifecycle.

Separate deployment QA verified preview/claim/reload/outsider-404/revocation
for both formats over Cloudflare, an immutable shared one-hour deadline,
artifact-only routing, and closed idle state after tunnel shutdown.
A real 20-second systemd watchdog test terminated cloudflared with the
JavaScript timer disabled. This is not a full-hour soak test.

Independent static security reviews reported no actionable P0–P2 findings.
These were not penetration tests and do not certify arbitrary deployments.
Automated browser checks of Mermaid SVG, interactive JavaScript execution,
and mobile visual layout remain unverified in that acceptance environment.

Run fresh local checks for your checkout:

```sh
npm ci
npm run build
npm test
npm audit --omit=dev
```

For public acceptance, follow the README and use separate disposable QA links.
Never fetch or claim the intended user's link. Keep the Gateway private and
proxy logs free of bearer URLs. Granting tool access is not itself permission
to create a public artifact: sharing must remain an explicit user request.


## Upgrade replay

Keep Clawtifact fixes in this plugin repository. A core upgrade should select a
reviewed plugin revision or immutable package and repeat these checks; it should
not copy plugin implementation into the core patch stack. Keep the previous
plugin payload with the runtime/state rollback set.

Feedback uses the documented `api.runtime.system.captureSessionEventTarget` and
`enqueueSessionEvent` methods. Retain the opaque handle by identity and pass it as
`expectedTarget`; it carries the original session generation and source authority.
A missing SDK method, failed capture or absent/invalid handle disables feedback.
Reloads drop bindings, owner revocation is refused by the host, and neither case
recaptures or selects a fallback destination. Queued is distinct from delivered.

From a plugin source checkout (Node 24 or later):

```sh
npm ci
npm run build
node --test --test-concurrency=1 test/*.test.js
npm run check:openclaw -- /path/to/openclaw <exact-40-character-core-commit>
npm pack --dry-run --json
```

The checker reads Git objects only. It records the exact core commit and checks
its public runtime API declarations, opaque target option and receipt fields.
Exit 0 means these source declarations are present; exit 1 means the feature gate
failed; exit 2 means a repository or exact pin was omitted. It executes no core
code and performs no state migration, channel delivery, model call or tunnel work.
It is an early declaration gate, not runtime/build qualification. If upstream
moves a declaration owner, review the new public contract and update this checker
alongside the tests; do not bypass it with a broader event API.

Run the selected core's owner tests for `src/plugins/runtime/runtime-session-events.test.ts`
and `src/auto-reply/reply/session-event-handoff.test.ts` as part of core qualification.
Those cover actual host admission, authority and target identity; the plugin suite
covers retained handles, missing-target refusal, reloads, owner refusals, browser
authentication/CSRF, idempotency, and delivered/uncertain UI status. Use a host
executor that allows loopback and child processes. Sandbox EPERM errors can prevent
Node's test children from running; a file-level summary alone is insufficient.
These checks must show individual test assertions and zero failures.

Qualified declaration examples on 2026-11-05:

- deployed core `70eb6b45188862c49c61a4c2c31f11ec3f2b5088`: present;
- upstream main `26e1040641f40709f5ccf35431d7e033b39828aa`: present;
- stable `4ffdd2047d192dd65554de3c8c46c0e0197c6e2a`: absent; artifact reading
  remains usable but original-channel feedback cannot be qualified on that API.

These are feature-specific source checks, not a claim that every future core
inside the package's base compatibility range supports feedback.
