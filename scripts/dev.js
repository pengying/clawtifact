import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ArtifactStore } from '../src/store.js';
import { createHandler } from '../src/http.js';
const origin = 'http://127.0.0.1:18947';
const store = new ArtifactStore({ file: '.local/dev.sqlite' });
const item = store.create({ title: 'A better way to review plans', owner: 'demo', markdown: `# Review artifacts

A quiet, readable place for plans, proposals, and technical notes. **You ask for a URL**, and OpenClaw prepares a document for this browser.

## The experience

1. Ask for a review link in Telegram.
2. Open the link to claim it automatically.
3. Read, refresh, and reply in your conversation.

> The first browser owns access. Other browsers receive a 404.

## Access policy

| Stage | Window | Behavior |
| --- | --- | --- |
| Waiting to open | 24 hours | Previews reveal no content |
| Claimed | 24 hours | Only the claiming browser can read |
| Expired or revoked | None | Returns 404 |

## Architecture

\`\`\`mermaid
flowchart LR
  A[Ask for a URL] --> B[Create artifact]
  B --> C[Open in browser]
  C --> D[Atomic claim]
  D --> E[Read and review]
\`\`\`

## Integration example

\`\`\`javascript
const artifact = await artifact_create({
  title: 'Implementation plan',
  markdown: '# Plan\\n\\nA clear set of next steps.',
});
\`\`\`

### What comes next

Keep the first version focused on sharing and reading. Conversations stay in Telegram; comments, editing, and approval workflows are outside v1.
` });
mkdirSync('.local', { recursive: true });
writeFileSync('.local/demo-url', `${origin}/artifacts/${item.token}`, { mode: 0o600 });
const server = createServer(createHandler({ store, origin, secure: false, onError: console.error }));
server.listen(18947, '127.0.0.1', () => console.log('Local sample ready; URL saved in .local/demo-url (not public)'));
function stop() { server.close(() => { store.close(); process.exit(); }); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
