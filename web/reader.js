import mermaid from 'mermaid';
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: 30000, suppressErrorRendering: true, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral' });
for (const node of document.querySelectorAll('pre.mermaid')) {
  const original = node.textContent;
  try { await mermaid.run({ nodes: [node] }); }
  catch { node.textContent = original; node.removeAttribute('data-processed'); node.classList.add('diagram-error'); }
}
