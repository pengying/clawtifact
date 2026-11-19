# Clawtifact

## Live revisions and core artifact types — 0.4

New artifacts support **Markdown, HTML, React/JSX, SVG, Mermaid and code**. Pass
exactly one source field to `artifact_create`; `language` is optional for code.
Code is displayed, never run on the server. SVG is an inert image. React requires
a default-export component and supports only local `react`, `react-dom/client`
and `react/jsx-runtime` imports—no remote packages, network or Node APIs. Mermaid
uses the bundled strict renderer. HTML can express slides, charts and dashboards;
this is core format coverage, not a claim of every Claude cloud feature.

Each new document has one stable link and immutable revisions. Use
`artifact_inspect` to read an exact source revision, then `artifact_update` with
`id`, `expectedRevision`, UUIDv4 `requestId`, optional `summary`, and exactly one
complete source field. Concurrent writers conflict. A retry with the same request
and payload returns its original receipt; after an uncertain response, inspect
that request ID instead of creating another publication.

The trusted viewer receives authenticated SSE snapshots. Read-only documents can
switch automatically when idle; HTML/React require explicit **Apply** because the
iframe restarts application state. A small nonmodal update bar sits above the
bottom-left controls. Active drafts, selections, image processing/uploads,
submissions and Chat composition pin the reviewed revision, including across
browser reload. Old Chat version links open exact revisions. No update submits
feedback, erases drafts, extends access or pretends a browser acknowledgement
means the person read the content. Reconnect reconciles complete state using an
epoch and independent snapshot cursor, not just the content sequence.

`artifact_message({id,messageId,revisionId,text})` posts one idempotent agent note
to the discussion over SSE without another user message. It does not send a
second channel mirror. Owner tools require the captured original agent, session,
session incarnation and route. Enable these new optional tools in the existing
agent tool policy just like the original artifact tools.

`feedbackMode: "discuss"` is the default. Only an owner-authorized creation with
`feedbackMode: "revise"` enables submitted feedback/Chat suggestions to drive
document-only revisions in the original agent workflow. Drafts trigger nothing.
The isolated Chat model remains discussion-only. Link-holder text never grants
commands, external actions, other-document access or private-history disclosure.
The owner-selected mode persists; runtime routing handles do not. After plugin
reload, lost bindings fail closed instead of silently recapturing authority.

Legacy pre-0.4 links remain frozen at their original source. Their tokens,
single-browser claims and deadlines are preserved by the plugin-owned migration.
See [verification and upgrade procedure](docs/verification.md#live-revisions-04)
for backup/rollback and actual qualification limits.

Turn an explicit request for a URL into a private, browser-friendly artifact.
The agent chooses **Markdown** for simple plans and documents, or a
self-contained **HTML/CSS/JavaScript mini page** when layout or interaction
helps. No OpenClaw header, injected title, footer, or surrounding card.

The first browser opens the content directly and claims reading access.
Other browsers receive **404**. No Control UI login is required.

## What it supports

| Markdown | Mini page |
| --- | --- |
| Headings, lists, tables and links | Complete agent-authored HTML and CSS |
| Highlighted code and bundled Mermaid | Inline JavaScript interactions |
| Warm-paper light / slate dark theme | Custom colors, layout, inline SVG and canvas |
| Responsive reading and print styles | Responsive layouts authored for the task |

The agent chooses the format and styling without asking you to configure them.
You can still request a particular format or style. Sharing is explicit: the
plugin does not intercept replies or automatically publish plans.

## Feedback and annotations

A floating pencil animates into an X and reveals two icon actions: **Selector**
and **Chat**, with hover and keyboard-focus hints. Opening and closing animate;
reduced-motion settings are respected. Feedback uses the approved compact bottom-left composer and numbered draft tray,
including on narrow screens with space reserved for the floating action. Chat
keeps its separate responsive panel. Neither adds a permanent header or wrapper. Chat is unavailable when its host capability or
original-session tool permission is unavailable, rather than faking a reply.

- Select text in either Markdown or HTML, then open **Selector** to comment on it.
- Choose **Selector** for diagrams, charts, canvas or other non-text content.
  Hover to highlight an element; click/tap to select it, or drag to draw any
  rectangle without switching modes. Selection blocks the underlying controls.
  The comment composer opens on release with the current outline still visible. The X exits selection.
  Keyboard arrows move; Shift+arrows resize; Enter confirms and Escape cancels.
  Focusable Move/Resize buttons provide a non-drag alternative without a
  persistent mode toolbar. If element hints are unavailable, draw a rectangle;
  unknown scroll position still blocks selection rather than inventing it.
- Inert numbered rectangles live inside the scrolling document, so mobile
  momentum scrolling does not wait for host scroll reports. They hide after a
  width reflow, not merely a browser-chrome/keyboard height change. To change a
  comment, delete it from the trusted list and select again.
- The compact comment card has a text box, **Delete** and **Add**. Adding returns
  to a short numbered list with **Delete** only; **Shift+Enter** is the Add shortcut
  (not Submit). **+** adds another selection without hiding earlier outlines.
  Choose **Submit (N)** once when the batch is ready. There is no **More options**
  menu, edit/adjust controls, metadata labels, or manual capture toolbar. Automatic
  image capture is silent on success; failures and uncertain delivery stay visible.
  There is no redundant “Not sent” banner, and typing has no yellow focus ring.
- The batch is sent for **discussion** in the original conversation's channel
  and thread. It does not request an automatic revision or grant tool authority.
- After Submit, retain and lock the list until the exact original agent reads the
  batch or channel delivery is confirmed. A guarded read shows **Received by the
  agent**, clears the submitted list, and allows another selection; this is not
  a claim that the channel mirror delivered. A confirmed transport receipt shows
  **Submitted. Thank you.** The card stays open in either case.
  Ambiguous outcomes retain the batch ID and comments and are never auto-resent.

### Screenshot references

After selecting, a region automatically requests a **rendered preview**
of the artifact's current page state. It stays local and attaches to the comment;
**no image uploads before Submit feedback**. No preview or image-success label
adds steps to the comment flow. A visible **Image unavailable** state and **Retry image**
offer recovery or geometry-only feedback.

This is best-effort DOM-to-image rendering, not a browser/phone screenshot or a
pixel-perfect promise. Rendering runs inside the existing opaque-origin sandbox:
no phone-screen capture permission, same-origin grant, or new network access.
A changed viewport/DOM, nested scrolled content, or scrolled fixed/sticky layouts
is rejected rather than attaching misleading pixels. Unsupported content/browser
behavior must visibly fall back. Generated images are bounded to1600px per side;
render requests expire after8 seconds. The source script cannot set channel routes.

To change a rectangle or comment, delete it and select again for a fresh crop.
Previously uploaded references remain valid for unmodified restored comments;
missing local images block sending until the affected comment is recreated.
Manual file/tab capture controls are no longer in the feedback card. Actual DOM
rendering and physical browser qualification must be recorded separately;
Node tests and desktop narrow-width checks are not mobile Safari tests.

The server accepts only bounded PNG/JPEG input, probes dimensions and re-encodes
to JPEG (maximum1600px side /1MiB). Up to8 images and4MiB per artifact,32MiB
globally, and4 concurrent normalizations bound memory/work. Originals and EXIF
metadata are not retained. Crops and discussion bindings are ephemeral and are
erased at expiry/revocation/plugin stop. Local binary drafts are not serialized
into sessionStorage: after refresh, a not-yet-uploaded crop must be recreated by selecting again.

The original agent calls **artifact_feedback_read** for the exact submitted
batch when available. A successful, authority-checked read acknowledges receipt
in the viewer independently of channel-delivery bookkeeping. It receives native image tool-result content with matching comment numbers,
not an image URL or base64 pasted into text. Access requires the exact original
agent/session/incarnation and channel/account/thread tuple plus live invocation
authority. Screenshot pixels are untrusted content, never operator instructions.
Commentary is delivered separately to the original thread. The read tool does
not send messages/images, confirm channel delivery, or grant revision authority.
Older hosts may omit message-tool sends from ordinary event settlement: execution
without a transport acknowledgement is unconfirmed, not a definite delivery
failure. Proven agent receipt is not downgraded by a later incomplete receipt.

### In-artifact Chat

Chat messages and replies update without reloading. Each revision stays immutable. New documents keep one stable link and receive complete revisions over SSE; legacy links stay frozen. A queued request wakes only the
captured original session, where **artifact_chat_respond** invokes a fresh
artifact-only direct-provider completion. The anonymous page cannot call a model,
choose credentials/model/destination, or access owner history, memory or tools.

Chat explicitly selects the captured original agent through the host's global
completion API. Enable only the plugin-scoped selection permission:

```sh
openclaw config set plugins.entries.artifacts.llm.allowAgentIdOverride true
```

This does not grant model or credential overrides, or change global permissions.
The plugin still verifies the exact original agent, session incarnation and route
at response time; the reviewer cannot choose another agent. The host's current
Gateway authority and model policy remain required. Direct-provider completion
uses host-managed provider transport, not necessarily the original agent's CLI
or harness.

The exact reviewer/model exchange is mirrored through that newly admitted turn's
host-bound original-route delivery capability when available. Coding sessions instead
use the SDK's captured original-session queue; its settlement receipt confirms
delivery, not queue acceptance. The reply tool's result must not be relayed again.
Ambiguous mirroring is labeled unconfirmed and never blindly retried. Busy original
sessions may delay a reply; queued is not described as model typing.

Chat support is not latched to the creation turn's permissions. Each response
checks current tool policy and the exact original session incarnation/route
before inference. A pre-inference permission
blocker is shown with an explicit **Retry reply** action (same immutable message
ID; at most three queue attempts, at least five seconds apart). It can also be
resumed by the original session's authorized reply tool. Uncertain requests,
inference failures and unconfirmed mirrors are never automatically retried.
`chatAvailable` indicates host/route support, not a promise of current permission.

Context is bounded to an artifact excerpt (24000characters, explicitly marked if
truncated), recent submitted comments and four prior exchanges. A separate scoped
vision description of up to two recent crops may supplement the text completion
when the configured media-understanding capability is available. The text-only
Chat model does not directly receive pixels; unavailable image understanding is
acknowledged rather than guessed. The original agent's native image read remains
separate. Chat only discusses; it does not revise, execute commands or authorize
external actions.

Limits:2000characters/reviewer message,30messages/artifact, one pending turn,
minimum5seconds between new sends, at most4 simultaneous completions globally.
Model and vision calls use the configured agent/provider policies and may incur
normal model usage. No action tools are supplied. Chat, polling, capture and
comments never extend public exposure or revive expired/revoked artifacts.

The content lives in an opaque-origin sandboxed frame. The trusted overlay owns
its credentials, composer and submit button; authored scripts cannot access those.
A child bridge supplies untrusted selection/viewport hints only. Region selection
still works when authored scripts disable the bridge, but unavailable scroll
coordinates are explicitly marked unknown. Interactive rerenders can make text
anchors stale; the quoted text and exact immutable revision ID remain in the feedback.

Drafts are kept in the browser tab's session storage when available. Each batch
allows up to 20 comments, 1,000 characters per comment and 2,000 per quote, within
a 32 KiB request. Up to 10 batches are admitted per artifact. Feedback requires
the claimed browser session and CSRF protection; it never extends tunnel expiry.

**Reload/restart limit:** delivery uses a host-captured opaque conversation
binding. A plugin reload, Gateway restart or missing SDK support can make feedback
unavailable for an older artifact. Reading still follows normal expiry, and drafts
stay in the browser. Request a fresh artifact rather than silently retargeting a
reset/new conversation. Old versions without a captured binding cannot gain one
merely by opening the page. The create tool reports `feedbackAvailable`,
`imagesAvailable`, and `chatAvailable` separately.


**Upgrade dependency:** Feedback needs both documented
`api.runtime.system.captureSessionEventTarget` and `enqueueSessionEvent`, including
an opaque `expectedTarget` and admission/settlement receipts. The package's base
compatibility range alone does not guarantee this optional feature. Missing or
invalid target capture leaves artifact creation and reading available with
`feedbackAvailable: false`. It never switches to `enqueueSystemEvent`, initializes
a replacement conversation, or recaptures authority after reload/revocation.
Run the exact-revision [upgrade checks](docs/verification.md#upgrade-replay) before
changing the Gateway version.

## Access lifecycle

1. Ask OpenClaw for a URL. The plugin stores the artifact and issues a bearer link.
2. Open within **24 hours**. A visible JavaScript-enabled browser automatically
   submits a nonce- and Origin-protected claim; no extra button click is needed.
3. Read, refresh and revisit in that browser for **24 hours after claiming**.
4. Another browser, an expired link, an unknown token or a revoked artifact gets
   the same **404** response.

GET/HEAD alone and ordinary non-JavaScript previews never claim or reveal the
title/body. JavaScript-executing scanners can claim a link. With JavaScript
disabled, the landing page offers a manual button.

In on-demand Cloudflare mode, both windows are capped by the tunnel session
deadline (one hour by default); see configuration below.

Claims are atomic and stored durably in SQLite. Concurrent claimants have one
winner; restarting OpenClaw does not reset the claim. Access uses Secure,
HttpOnly, SameSite=Strict, artifact-path-scoped session cookies. Closing a browser
may discard access early; copying its session cookie deliberately copies access.
Revocation and expiry prevent subsequent reads, not screenshots, saved copies or
content already displayed in an open tab.

## Install

Install the published native plugin from ClawHub:

```sh
openclaw plugins install clawhub:clawtifact
```

The package is named `clawtifact`; its runtime plugin ID remains `artifacts`.
Installation is not tool authorization: complete the explicit opt-in setup below.
Managed Cloudflare mode requires Linux, a working systemd user manager,
cloudflared, and the artifact-only loopback proxy described below.

For a source checkout:

```sh
git clone https://github.com/pengying/clawtifact.git
cd clawtifact
```

## Build

Requires **Node.js 24+**, npm and an OpenClaw release supporting plugin tool
factories, services and plugin-authenticated prefix HTTP routes.

```sh
npm ci
npm run build
npm test
```

Ship the generated `dist/` directory with the plugin, or build on the installing
host. Mermaid and syntax styles are bundled locally; no CDN is needed. Mermaid's
JavaScript bundle is about 5 MB before compression, so enable HTTP compression.

## Configure OpenClaw

Recommended on Linux with a systemd user manager: **on-demand Cloudflare**.
Merge these settings, using the actual checkout and trusted cloudflared binary.
For a managed ClawHub installation, omit `plugins.load.paths`; the installed
package is already discoverable. Use that path only for a source checkout:

```json
{
  "plugins": {
    "load": { "paths": ["/absolute/path/to/clawtifact"] },
    "entries": {
      "artifacts": {
        "enabled": true,
        "config": {
          "cloudflare": {
            "binary": "/absolute/path/to/cloudflared",
            "proxyUrl": "http://127.0.0.1:19447",
            "lifetimeSeconds": 3600
          }
        }
      }
    }
  },
  "tools": { "alsoAllow": ["artifact_create", "artifact_revoke"] }
}
```

This mode starts **closed**. Only a valid explicit `artifact_create` request
starts a tunnel. Startup, reload, visits and revoke do not open it. Concurrent
requests share a tunnel and its original deadline; no traffic or new document
extends the session. The default and maximum exposure is **one hour** (shorter
values are allowed). An independent systemd `RuntimeMaxSec` watchdog bounds
exposure even if the Gateway hangs or crashes. There is no automatic restart.
Plugin stop also stops its managed tunnel. The artifact-only loopback proxy
must already be running; it is not public when the tunnel is stopped.

The create result includes `publicLinkExpiresAt`. Claim and reading deadlines
are capped by it: **the one-hour session supersedes the 24-hour windows**.
New artifacts created near the end get only the remaining time. A later explicit
URL request starts a fresh tunnel/hostname; expired artifact tokens cannot be
revived by rewriting the hostname. Old links are not redirected or regenerated.
The session timer does not detect browser closure or reading activity; the
service may stay exposed until its hard deadline even after you finish reading.

For externally managed ingress, configure `publicBaseUrl` instead of
`cloudflare` (never both): `"publicBaseUrl": "https://review.example.com"`.
That legacy mode does not manage or shut down ingress and keeps the 24-hour
claim/read windows. Use it only if you separately manage the exposure policy.

Preserve existing plugin paths/allowlists. If `plugins.allow` is configured,
add `artifacts`. Validate config and reload using your installed OpenClaw runtime.
Publication tools require a trusted conversation session key. Fixed `publicBaseUrl`
must be an HTTPS origin without credentials, path, query or fragment.

### Grant agent access (explicit opt-in)

Installing or enabling this plugin is separate from allowing agents to use its
tools. All four plugin tools are registered as **optional**;
installation alone does not grant them. These are manual setup instructions,
not an automatic permission-granting installer.

Before granting access, the owner should understand that an explicit request
for an artifact URL can start a publicly reachable Cloudflare tunnel for up to
one hour. Visits and additional artifacts do not extend that deadline. The
plugin exposes bearer links without a Control UI login; the first browser
claims access. Grant access only to the agents intended to publish artifacts.

1. **Enable the plugin.** Configure `plugins.entries.artifacts.enabled` and, if
   `plugins.allow` is present, append `artifacts` without removing other entries.
   Plugin trust/loading and agent tool access are separate settings.
2. **Choose the scope.** For all agents that inherit global tool extras, append
   `artifact_create` and `artifact_revoke` to `tools.alsoAllow`, as above. For a
   selected agent, append them to that agent's own list instead:

   ```json
   {
     "agents": {
       "entries": {
         "main": {
           "tools": {
             "alsoAllow": ["artifact_create", "artifact_revoke"]
           }
         }
       }
     }
   }
   ```

   Replace `main` with the intended agent ID. This is a merge example, not a
   replacement configuration: retain existing agents, tool entries and settings.
3. **Check overrides.** An agent-level `tools.alsoAllow` replaces the inherited
   global list; it does not concatenate with it. If an agent already defines
   that list (even an empty one), the global grant alone is insufficient. Append
   these two tool names to each selected agent's existing list, preserving its
   other entries. Do not copy unrelated global grants into a restricted agent.
4. **Respect other restrictions.** If a scope already uses `tools.allow`, append
   the names there rather than introducing `alsoAllow` alongside it; OpenClaw
   rejects both in the same scope. Explicit denies and additional provider,
   sandbox or session restrictions can still block access. Do not remove those
   restrictions automatically or switch to an unrestricted profile to fix this.
5. **Validate and apply** with the installed OpenClaw release's configuration
   validation/reload commands. A turn already in progress may retain its earlier
   tool surface; retry in a new turn after applying the configuration.

For screenshot discussion and in-artifact Chat, additionally append
`artifact_feedback_read` and `artifact_chat_respond` to the same intended scope's
existing allow/alsoAllow list. Preserve all existing entries and restrictions.
These are separate opt-ins: read admits image context; respond admits bounded
artifact-only inference and current-original-route text delivery. The plugin
does not grant either permission automatically. Feature availability is checked
through the host's public tool-policy explainer at artifact creation; missing
SDK/authority/policy support leaves the respective feature disabled.

#### Verify without accidentally publishing

In a conversation using each selected agent, ask it to check whether
`artifact_create` and `artifact_revoke` are available **without calling create**.
If the runtime uses deferred tool discovery, discover the tools first; absence
from the initially displayed tool list is not by itself proof of a denial.
Confirm the plugin is loaded and the effective tool policy admits both tools.
Merely checking access must not start a tunnel.

For an end-to-end check, explicitly ask: "Create an artifact URL containing
only 'Artifact setup test'." This intentionally opens public access. Confirm
the result includes `publicLinkExpiresAt`, then open the link yourself; the
agent must not fetch or claim your link. Ask the same conversation to revoke
the test artifact using its returned ID. Revocation blocks subsequent reads
but does not itself stop the shared tunnel; the original hard deadline still
applies. Use a separate disposable link for any automated browser QA.

If publishing is blocked, check plugin loading/trust, global and agent-level
lists, explicit denies and narrower runtime policies before changing anything.
Report the exact blocking scope rather than silently widening access. These
permission rules are the same for a local checkout and a distributed package.

## Expose through Cloudflare

Keep the Gateway private. Put a path-filtering proxy in front of it and expose
**only `/artifacts/*`**, never the full Gateway or Control UI.

Example Caddy configuration, replacing `GATEWAY_PORT` with your loopback Gateway
port. This listener is local HTTP because Cloudflare provides public HTTPS:

```caddyfile
{
    admin off
    auto_https off
}
:19447 {
    bind 127.0.0.1
    encode zstd gzip
    @artifacts path /artifacts/*
    handle @artifacts {
        reverse_proxy 127.0.0.1:GATEWAY_PORT
    }
    handle {
        respond "Not found" 404
    }
}
```

Start Caddy with that configuration. In recommended managed mode, the plugin
starts and stops cloudflared itself; do **not** also run a permanent tunnel.
For legacy externally managed mode only:

```sh
cloudflared tunnel --url http://127.0.0.1:19447
```

Set `publicBaseUrl` to the printed HTTPS origin and reload the plugin before
creating links. The plugin supplies its own token/session authentication; the
proxy must not redirect artifact requests into the Control UI login. Preserve
the browser's Origin header. Do not cache responses or log full bearer paths.

### Tunnel lifetime

A Quick Tunnel needs no Cloudflare account or domain, but has **no uptime
guarantee**. Its URL works only while that tunnel process runs. A new Quick
Tunnel gets a new hostname; old artifact URLs then stop working even if their
24-hour access window remains. Updating the configured origin affects new links,
not links already delivered.

The deployment uses an on-demand tunnel with a one-hour watchdog and no
automatic restart; it stays closed after a reboot until a new explicit URL
request. The loopback proxy must be available before a new session can work.
A persistent proxy service alone does not make a Quick Tunnel hostname stable.
For a stable hostname, use a named Cloudflare Tunnel and a domain configured in
your Cloudflare account; that is separate from this on-demand Quick Tunnel mode.

See [Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Tool examples

Supply a title and **exactly one** of `markdown` or `html`:

```js
const document = await artifact_create({
  title: 'Implementation plan',
  markdown: '# Plan\n\n1. Build\n2. Verify\n3. Review',
});

const page = await artifact_create({
  title: 'Interactive explanation',
  html: `<!doctype html><html lang="en"><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Interactive explanation</title>
    <style>body{font:18px system-ui;padding:24px}</style>
    </head><body><button id="next">Click to explore</button>
    <script>document.getElementById('next').onclick = event => {
      event.target.textContent = 'JavaScript is running';
    };</script></body></html>`,
});

// Result: { id, url, claimExpiresAt, readingWindowHours, publicLinkExpiresAt, feedbackAvailable }
await artifact_revoke({ id: page.id }); // { revoked: true }
```

Return the URL only to the intended requester. **Never fetch or claim their link
for testing**; create a separate QA artifact. Revocation is scoped to the
creating conversation. An ID from another conversation cannot revoke a document.

## HTML sandbox and limits

Markdown is sanitized; raw HTML and remote images in Markdown are disabled.
HTML mini pages are intentionally not sanitized: authored scripts execute under
an HTTP CSP `sandbox allow-scripts` **without `allow-same-origin`**, giving the
content frame an opaque origin and blocking access to cookies, storage and Gateway DOM.

Mini pages must be self-contained:

- Inline CSS and JavaScript, inline SVG/canvas, and data-URL images/fonts work.
- Remote libraries/assets, fetch/network APIs, forms, frames, workers, popups
  and eval are blocked by the sandbox/CSP.
- Include a viewport meta tag and a mobile-friendly layout.

This is not a general app host or a complete no-network guarantee: authored code
can alter its own content, consume CPU and attempt to navigate its own frame.
The iframe does not allow top-level navigation or access to the feedback host. Do not embed
credentials. HTTP policy is not replaceable by author-supplied meta tags.
Cloudflare terminates TLS and can see traffic and bearer URLs.

Input limits: title 1–200 characters, content **256 KiB UTF-8**, and **1,000 live
artifacts**. State is local at `<OpenClaw state directory>/artifacts/artifacts.sqlite`
with file mode 0600. Existing Markdown records migrate additively without changing
claims. Cleanup runs at startup, every five minutes and before creation; access
expiry is enforced immediately. Revocation deletes active records, not forensic
filesystem traces or backups. Apply appropriate backup retention.

## Verification

The implementation has **42 automated tests**, covering preview privacy,
Origin/nonce checks, concurrent claims across workers, persistence, expiry,
conversation-scoped revocation, HTML input/policy wrapper-free Markdown, feedback isolation/CSRF/limits, original-route binding,
idempotent batches, delivery outcomes and frontend state/protocol behavior.
Production dependency audit: zero known advisories at the last verification.
An independent static security review reported no actionable P0–P2 findings.
These are point-in-time results, not a security guarantee.

Public Cloudflare HTTP checks passed claim, same-browser reload, outsider 404
and revoked-session 404 for both formats, plus non-artifact route isolation.
Automated Chrome verification of actual Mermaid SVG, JavaScript interaction
and mobile layout was blocked by browser policy and remains unverified.

Before relying on a deployment, use separate QA links to check real browser
opening, diagrams, interaction, refresh, outsider denial and revocation. See
[verification notes](docs/verification.md) for evidence and limitations.

For a local Markdown sample:

```sh
npm run dev
```

The sample listens at `127.0.0.1:18947` and writes its private local URL to
`.local/demo-url`. Secure cookies are disabled only in this loopback development
server. Restarting creates a fresh sample; this is not a public URL.


## Local development

`npm run dev` starts loopback-only Markdown and interactive-HTML fixtures on port
18948 (override with `PORT`). URLs are written to `.local/demo-urls.json`.
Feedback delivery is **simulated**, saved to `.local/dev-feedback.json`, and never
sent to a real channel. This command does not start Cloudflare. Use disposable
fixtures, not a user's unclaimed artifact, for browser acceptance.
