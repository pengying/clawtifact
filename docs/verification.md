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
