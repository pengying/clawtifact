import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { reader, framedReader, feedbackHost } from '../src/render.js';

const render = (format, source, extra = {}) => reader({ title: 'Example', format, [format]: source, ...extra });
function executeReact(source, modules = {}) {
  const markup = render('react', source);
  const boot = [...markup.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(Boolean);
  assert.ok(boot, 'compiled JSX runs in the sandbox document');
  let exported;
  const context = { document: { getElementById: () => ({}) }, window: { ClawtifactReactRuntime: { mount(node, factory) {
    const module = { exports: {} };
    factory(name => {
      if (!Object.hasOwn(modules, name)) throw new Error(`Unsupported import: ${name}`);
      return modules[name];
    }, module, module.exports);
    exported = module.exports.default;
  } } } };
  vm.runInNewContext(boot, context);
  return exported;
}

test('dedicated code is highlighted without executing markup or author language names', () => {
  const markup = render('code', 'const value = "<script>alert(1)</script>";', { language: 'javascript' });
  assert.match(markup, /hljs-keyword/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>alert/);
  const plain = render('code', '<img src=x onerror=alert(1)>', { language: '\"><script>bad()</script>' });
  assert.match(plain, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(plain, /<img|bad\(\)/);
});

test('standalone SVG renders as an inert graphic while preserving the authored source', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="20"/><script>bad()</script></svg>';
  const markup = render('svg', svg);
  const encoded = /<img[^>]+src="data:image\/svg\+xml;base64,([^"]+)"/.exec(markup);
  assert.ok(encoded, 'SVG image mode, not active inline DOM');
  assert.equal(Buffer.from(encoded[1], 'base64').toString(), svg);
  assert.doesNotMatch(markup, /<script>bad|<circle/);
});

test('standalone Mermaid uses the existing trusted local renderer and escapes source', () => {
  const markup = render('mermaid', 'graph TD; A["</pre><script>bad()</script>"]-->B');
  assert.match(markup, /<pre class="mermaid">graph TD/);
  assert.match(markup, /&lt;\/pre&gt;&lt;script&gt;/);
  assert.match(markup, /src="\/artifacts\/assets\/reader.js"/);
  assert.doesNotMatch(markup, /<script>bad/);
});

test('React JSX is transformed synchronously and runs only in the browser sandbox', () => {
  globalThis.__clawtifactAuthorEffect = 0;
  const source = 'import {useState} from "react"; globalThis.__clawtifactAuthorEffect++; export default function Counter(){ const [n] = useState(1); return <button>{n}</button>; }';
  const markup = render('react', source);
  assert.equal(globalThis.__clawtifactAuthorEffect, 0);
  delete globalThis.__clawtifactAuthorEffect;
  assert.match(markup, /src="\/artifacts\/assets\/react-runtime.js"/);
  assert.doesNotMatch(markup, /https?:\/\//);
  const Counter = executeReact(source, { react: { useState: () => [7] }, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) } });
  assert.equal(typeof Counter, 'function');
  assert.equal(Counter().props.children, 7);
});

test('compiled React cannot end the enclosing inline script or create extra scripts', () => {
  const markup = render('react', 'export default function App(){ return <p>{"</script><script>globalThis.injected=1</script>"}</p>; }');
  assert.equal((markup.match(/<\/script\s*>/gi) || []).length, 2, 'only the runtime and boot scripts can close');
  assert.doesNotMatch(markup, /<\/script><script>globalThis.injected/i);
  const App = executeReact('export default function App(){ return <p>{"</script>"}</p>; }', { 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) } });
  assert.equal(App().props.children, '</script>');
});

test('unsupported React imports have no Node resolver and fail clearly in the browser', () => {
  assert.throws(() => executeReact('import fs from "node:fs"; export default function App(){return null;}'), /Unsupported import: node:fs/);
  assert.throws(() => executeReact('import x from "https://evil.invalid/x.js"; export default function App(){return null;}'), /Unsupported import: https:/);
  assert.throws(() => executeReact('require("./secret.js"); export default function App(){return null;}'), /Unsupported import: .\/secret.js/);
});

test('dynamic React imports use the same browser-only module allowlist', async () => {
  const App = executeReact('export default function App(){ return import("node:fs"); }');
  await assert.rejects(App(), /Unsupported import: node:fs/);
});

test('the real runtime renders unsupported imports as literal error text', async () => {
  const { mount } = await import('../web/react-runtime.js');
  const savedWindow = globalThis.window, savedDocument = globalThis.document;
  const node = { children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } };
  globalThis.window = { addEventListener() {} };
  globalThis.document = { createElement: () => ({ setAttribute() {} }) };
  try {
    mount(node, require => require('<img src=x onerror=alert(1)>'));
    assert.equal(node.children.length, 1);
    assert.match(node.children[0].textContent, /Unsupported import: <img src=x/);
    assert.equal(node.children[0].innerHTML, undefined, 'errors are never inserted as markup');
  } finally {
    if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
  }
});

test('invalid React JSX is an escaped preview error, not a server-side exception', () => {
  const markup = render('react', 'export default function App(){ return <div><script>');
  assert.match(markup, /role="alert"/);
  assert.match(markup, /Unable to compile React/);
  assert.doesNotMatch(markup, /<div><script>/);
});

test('React runtime bundles only local allowlisted modules and an error boundary', () => {
  const runtime = readFileSync(new URL('../web/react-runtime.js', import.meta.url), 'utf8');
  assert.match(runtime, /react-dom\/client/);
  assert.match(runtime, /react\/jsx-runtime/);
  assert.match(runtime, /Unsupported import/);
  assert.match(runtime, /componentDidCatch|getDerivedStateFromError/);
  assert.doesNotMatch(runtime, /\beval\s*\(|new Function|\bfetch\s*\(/);
});

test('all artifact types keep authored content outside the credential-bearing opaque host', () => {
  const host = feedbackHost({ path: '/artifacts/private', artifactId: 'id', csrf: 'secret', enabled: true });
  assert.match(host, /sandbox="allow-scripts"/);
  assert.doesNotMatch(host, /allow-same-origin|allow-forms|allow-top-navigation/);
  for (const format of ['code', 'svg', 'mermaid', 'react']) {
    const source = format === 'react' ? 'export default function App(){return <p>PRIVATE_SOURCE</p>}' : 'PRIVATE_SOURCE';
    const frame = framedReader({ title: 'Example', format, [format]: source }, 'https://review.example');
    assert.match(frame, /https:\/\/review.example\/artifacts\/assets\/bridge.js/);
    assert.doesNotMatch(frame, /data-csrf|oc_art_session|secret/);
    assert.doesNotMatch(host, /PRIVATE_SOURCE/);
  }
});

test('React strings cannot switch the HTML tokenizer into double-escaped script state', () => {
  const source = 'export default function App(){return <p>{"<!--<script>still text</script>"}</p>}';
  const markup = render('react', source);
  assert.doesNotMatch(markup, /<!--/, 'HTML comment opener must be escaped inside script source');
  const App = executeReact(source, { 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) } });
  assert.equal(App().props.children, '<!--<script>still text</script>');
});

test('React tagged templates preserve raw text while escaping HTML script tokenizer sequences', () => {
  const source = 'export default function App(){return String.raw`<!-- generated -->`;}';
  const markup = render('react', source);
  assert.doesNotMatch(markup, /<!--/);
  assert.equal((markup.match(/<\/script\s*>/gi) || []).length, 2);
  const App = executeReact(source);
  assert.equal(App(), '<!-- generated -->');
});
