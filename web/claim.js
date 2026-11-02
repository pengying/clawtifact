// GET/HEAD stay content-free. Only a visible JavaScript browser submits the
// same-origin, nonce-protected POST; ordinary chat previews cannot consume it.
const form = document.querySelector('form');
let submitted = false;
function open() {
  if (submitted || document.prerendering || document.visibilityState !== 'visible') return;
  submitted = true;
  form.requestSubmit();
}
document.addEventListener('visibilitychange', open);
document.addEventListener('prerenderingchange', open);
open();
