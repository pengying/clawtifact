import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import hljs from 'highlight.js';
import { compileReact } from './formats.js';

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

export function reader({ title, markdown, html, code, svg, mermaid, react, language, format }) {
  if (format === 'html') return html;
  if (format === 'code') {
    const highlighted = language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escape(code);
    return shell(title, `<main><pre><code class="hljs">${highlighted}</code></pre></main>`);
  }
  if (format === 'svg') {
    // SVG image mode renders the graphic without giving embedded scripts, foreign
    // HTML, or event handlers an active document. Never inline authored SVG DOM.
    return shell(title, `<main><img alt="${escape(title)}" style="max-width:100%;height:auto" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></main>`);
  }
  if (format === 'mermaid') return shell(title, `<main><pre class="mermaid">${escape(mermaid)}</pre></main>`, true);
  if (format === 'react') {
    try {
      const compiled = compileReact(react);
      return shell(title, `<main id="artifact-react-root"></main><script src="/artifacts/assets/react-runtime.js"></script><script>(()=>{window.ClawtifactReactRuntime.mount(document.getElementById("artifact-react-root"),function(require,module,exports){\n${compiled}\n});})();</script>`);
    } catch (error) {
      const message = error.errors?.map(item => item.text).join('\n') || error.message;
      return shell(title, `<main><pre class="artifact-error" role="alert">Unable to compile React: ${escape(message)}</pre></main>`);
    }
  }
  const content = sanitizeHtml(md.render(markdown), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['span']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, '*': ['class'], a: ['href', 'title', 'rel', 'target'] },
    allowedSchemes: ['https', 'http', 'mailto'], allowProtocolRelative: false,
    transformTags: { a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }) },
  });
  return shell(title, `<main><article>${content}</article></main>`, true);
}


// Authored content is never interpolated into the credential-bearing host.
export function feedbackHost({ path, artifactId, csrf, enabled,revisionId,sequence,format,live=false,feedbackMode='discuss' }) {
  const version=revisionId?`?revision=${escape(revisionId)}`:'';
  const data=revisionId?` data-revision-id="${escape(revisionId)}" data-sequence="${escape(sequence)}" data-format="${escape(format)}" data-live="${live?'true':'false'}" data-feedback-mode="${feedbackMode==='revise'?'revise':'discuss'}"`:'';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Artifact</title><link rel="stylesheet" href="/artifacts/assets/feedback.css"><script type="module" src="/artifacts/assets/feedback.js"></script></head><body><iframe id="artifact-content" title="Artifact content" src="${escape(path)}/content${version}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><div id="artifact-feedback" data-path="${escape(path)}" data-artifact-id="${escape(artifactId)}" data-csrf="${escape(csrf)}" data-enabled="${enabled ? 'true' : 'false'}"${data}></div></body></html>`;
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
