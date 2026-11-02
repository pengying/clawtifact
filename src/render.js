import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import hljs from 'highlight.js';

export const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = new MarkdownIt({
  html: false, linkify: false, typographer: true,
  highlight(code, lang) {
    if (lang === 'mermaid') return `<pre class="mermaid">${escape(code)}</pre>`;
    if (hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    return '';
  },
});
md.renderer.rules.image = tokens => escape(tokens[0]?.content || '[image omitted]');
const shell = (title, body, scripts = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title><link rel="stylesheet" href="/artifacts/assets/style.css">${scripts ? `<script type="module" src="/artifacts/assets/${scripts === true ? 'reader' : scripts}.js"></script>` : ''}</head><body>${body}</body></html>`;

export const landing = (path, nonce) => shell('Opening artifact…', `<main class="claim"><h1>Opening your document…</h1><p>This browser will claim reading access automatically.</p><form method="post" action="${path}/claim"><input type="hidden" name="nonce" value="${nonce}"><noscript><p>JavaScript is disabled. Continue to open this artifact.</p><button type="submit">Open artifact</button></noscript></form></main>`, 'claim');

export function reader({ title, markdown, html, format }) {
  if (format === 'html') return html;
  const content = sanitizeHtml(md.render(markdown), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['span']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, '*': ['class'], a: ['href', 'title', 'rel', 'target'] },
    allowedSchemes: ['https', 'http', 'mailto'], allowProtocolRelative: false,
    transformTags: { a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }) },
  });
  return shell(title, `<main><article>${content}</article></main>`, true);
}


// Authored content is never interpolated into the credential-bearing host.
export function feedbackHost({ path, artifactId, csrf, enabled }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Artifact</title><link rel="stylesheet" href="/artifacts/assets/feedback.css"><script type="module" src="/artifacts/assets/feedback.js"></script></head><body><iframe id="artifact-content" title="Artifact content" src="${escape(path)}/content" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><div id="artifact-feedback" data-path="${escape(path)}" data-artifact-id="${escape(artifactId)}" data-csrf="${escape(csrf)}" data-enabled="${enabled ? 'true' : 'false'}"></div></body></html>`;
}

export function framedReader(document, origin) {
  const markup = reader(document);
  const bridge = `<script defer src="${escape(origin)}/artifacts/assets/bridge.js"></script>`;
  // The helper has no credentials; authored scripts can interfere with selection.
  // The trusted parent region selector remains available if that happens.
  // Browsers merge the following authored html/head/body into the same document.
  if (document.format === 'html') return '<!doctype html>' + bridge + markup;
  return markup.replace('</head>', bridge + '</head>');
}
