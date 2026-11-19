import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';

const modules = Object.freeze({
  react: React,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JSXRuntime,
});
function requireLocal(name) {
  if (!Object.hasOwn(modules, name)) throw new Error(`Unsupported import: ${String(name)}. Only react, react-dom/client, and react/jsx-runtime are available; external packages, files, and network modules are not supported.`);
  return modules[name];
}
function errorText(error) {
  return `Unable to render React: ${error instanceof Error ? error.message : String(error)}`;
}
class PreviewBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    return this.state.error
      ? React.createElement('pre', { role: 'alert', className: 'artifact-error' }, errorText(this.state.error))
      : this.props.children;
  }
}
export function mount(node, factory) {
  function showError(error) {
    node.replaceChildren();
    const message = document.createElement('pre');
    message.setAttribute('role', 'alert');
    message.className = 'artifact-error';
    message.textContent = errorText(error);
    node.append(message);
  }
  // Event-handler and dynamic-import errors do not reach React error boundaries.
  window.addEventListener('error', event => showError(event.error || event.message));
  window.addEventListener('unhandledrejection', event => showError(event.reason));
  try {
    const module = { exports: {} };
    factory(requireLocal, module, module.exports);
    const Component = module.exports.default;
    if (typeof Component !== 'function' && !(typeof Component === 'object' && Component !== null)) {
      throw new Error('Export a React component as default, e.g. export default function App() { return <p>Hello</p>; }');
    }
    ReactDOMClient.createRoot(node).render(
      React.createElement(PreviewBoundary, null, React.createElement(Component)),
    );
  } catch (error) { showError(error); }
}
