import { transformSync } from 'esbuild';

export const ARTIFACT_FORMATS = Object.freeze(['markdown', 'html', 'code', 'svg', 'mermaid', 'react']);

// Transform syntax only: no bundler, module resolver, filesystem reads, or authored
// execution. All require calls are resolved by the browser runtime's allowlist.
export function compileReact(source) {
  return transformSync(source, {
    loader: 'jsx', format: 'cjs', jsx: 'automatic', target: 'es2022',
    sourcefile: 'artifact.jsx', charset: 'utf8', logLevel: 'silent',
    // Even import() goes through the same browser-only require allowlist.
    // Lower tagged templates before HTML-tokenizer escaping so .raw retains
    // authored values instead of observing the added JavaScript escapes.
    supported: { 'dynamic-import': false, 'template-literal': false },
  }).code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '\\x3c!--');
}
