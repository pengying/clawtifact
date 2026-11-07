# Verification and limitations

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
