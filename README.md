# Clawtifact

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

A floating **Feedback** button expands into a desktop panel or mobile bottom
sheet without adding a permanent header or card around your artifact.

- Select text in either Markdown or HTML and choose **Use selected text**.
- Choose **Select region** for diagrams, charts, canvas or other non-text content.
  Drag a rectangle, or move it with arrow keys, resize with Shift+arrows and
  confirm with Enter. Escape cancels.
- Add, edit or delete draft comments, then choose **Send feedback** once.
- The batch is sent for **discussion** in the original conversation's channel
  and thread. It does not request an automatic revision or grant tool authority.
- Queued means pending; only confirmed channel delivery is labeled delivered.
  Ambiguous outcomes retain the batch ID and comments and are never auto-resent.

The content lives in an opaque-origin sandboxed frame. The trusted overlay owns
its credentials, composer and submit button; authored scripts cannot access those.
A child bridge supplies untrusted selection/viewport hints only. Region selection
still works when authored scripts disable the bridge, but unavailable scroll
coordinates are explicitly marked unknown. Interactive rerenders can make text
anchors stale; the quoted text and immutable artifact ID remain in the feedback.

Drafts are kept in the browser tab's session storage when available. Each batch
allows up to 20 comments, 1,000 characters per comment and 2,000 per quote, within
a 32 KiB request. Up to 10 batches are admitted per artifact. Feedback requires
the claimed browser session and CSRF protection; it never extends tunnel expiry.

**Reload/restart limit:** delivery uses a host-captured opaque conversation
binding. A plugin reload, Gateway restart or missing SDK support can make feedback
unavailable for an older artifact. Reading still follows normal expiry, and drafts
stay in the browser. Request a fresh artifact rather than silently retargeting a
reset/new conversation. Old versions without a captured binding cannot gain one
merely by opening the page. The create tool reports `feedbackAvailable`.

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
Both tools require a trusted conversation session key. Fixed `publicBaseUrl`
must be an HTTPS origin without credentials, path, query or fragment.

### Grant agent access (explicit opt-in)

Installing or enabling this plugin is separate from allowing agents to use its
tools. Both `artifact_create` and `artifact_revoke` are registered as **optional**;
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
