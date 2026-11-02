# Security review — 2026-10-31

An independent read-only Codex review of the mixed-format candidate and complete
service source reported **no actionable P0–P2 findings**. Scope: public route
isolation, token/session access, atomic claims, Origin/nonce checks, conversation
ownership, expiry/revocation, input/resource limits, additive migration and
HTML/CSS/JS sandbox isolation. This was static analysis, not a penetration test
or an independent live proxy/browser verification.

Production `npm audit --omit=dev` reported zero known advisories at review time.
Automated tests cover the access lifecycle and response policies. Separate
public HTTP QA verified both formats and artifact-only routing. Actual browser
execution, mobile layout and Mermaid SVG checks remain unverified in the
automated acceptance environment; HTTP/source tests are not pixel verification.

Known boundaries:

- HTTP CSP gives HTML an opaque-origin sandbox, with no same-origin permission,
  cookie/storage access, remote resource loading, fetch, forms, frames or workers.
  It is not complete network isolation: authored pages may navigate their own tab.
- Malicious authored JavaScript can alter its page and consume CPU. Do not embed
  credentials or treat this as a trusted general app-hosting environment.
- Revocation/expiry prevent future reads, not copies or already displayed content.
- Bearer-session access is not device identity: deliberately copying a session
  cookie copies its access. JavaScript-executing link scanners can claim a link.
- Cloudflare terminates TLS and sees content and bearer paths. Avoid URL logging,
  caching and analytics; keep the Gateway private behind an artifact-only proxy.
- A Quick Tunnel is temporary and has no uptime guarantee. The current deployment
  has no automatic service restart/reboot persistence.

Re-run dependency checks and review after changes. These results do not certify
all future deployments or dependencies.

## On-demand exposure follow-up

A second independent static review of the tunnel manager, process/unit lifecycle,
watchdog, startup handling, origin switching and persisted artifact deadline
reported no actionable P0–P2 defects. The reviewer did not execute deployment
services. Separately, a real 20-second cloudflared session registered successfully
and systemd terminated it at RuntimeMaxSec with the JS timer deliberately disabled.
The unit had Restart=no and KillMode=control-group. This tests the independent
watchdog rather than relying only on fake clocks. Managed mode stays closed on
startup, visits cannot open/extend it, and artifact tokens are capped by the
session deadline. The OS stop grace is at most five seconds; HTTP admission and
record expiry enforce the application deadline independently.


## Annotation feature boundaries

The feedback host never embeds authored HTML or Markdown. A same-origin URL
loads the content in an `allow-scripts`-only, opaque-origin iframe. Only public
allowlisted code assets have wildcard CORS for module loading; document and
feedback responses do not. The content endpoint allows same-origin framing,
while the credential-bearing host remains unframeable. Child postMessage data
is untrusted selection/viewport context, never a send instruction or route.

Submission requires a valid claimed session, exact Origin, JSON content type,
and separate artifact-path-scoped HttpOnly double-submit CSRF cookie. The server
validates anchors, text/body sizes, batch count and immutable ID/content pairs.
Original destination and SDK opaque session-generation target are captured only
from trusted tool context. No browser-supplied route or model setting is accepted.
Opaque handles are intentionally not reconstructed after reload; old feedback
fails closed. Submission and confirmed delivery are distinct states; uncertain
outcomes must not be automatically replayed.

Comments and quoted content are explicitly labeled untrusted discussion data
when passed to the originating session. Sending feedback is not authorization
to modify artifacts, execute commands or perform other external actions. Only
the user-controlled host composer can initiate a feedback submission; scripts
inside the content can spoof selection hints but cannot submit a batch.

Browser-loopback navigation was blocked by the current browser policy during
local acceptance. HTTP integration and DOM-harness tests do not establish actual
browser sandbox enforcement, mobile visuals or real-channel end-to-end delivery.
