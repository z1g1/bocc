/* nav.js — mobile navigation toggle.
 *
 * Progressive enhancement: the markup ships a hamburger button (hidden on
 * desktop via CSS) and a normal <nav>. Without JS the nav simply stays visible.
 * With JS we collapse it into a dropdown panel on small screens and toggle it
 * open/closed, keeping aria-expanded and the button label in sync. Closes on
 * Escape, on outside click, when a link is chosen, and when the viewport grows
 * back to the desktop layout.
 */
(function () {
  'use strict';

  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.querySelector('[data-nav]');
  if (!toggle || !nav) return;

  var desktop = window.matchMedia('(min-width: 821px)');

  function isOpen() { return nav.classList.contains('is-open'); }

  function setOpen(open) {
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    setOpen(false);
    if (returnFocus) toggle.focus();
  }

  toggle.addEventListener('click', function () { setOpen(!isOpen()); });

  // Choosing a destination (or in-page anchor) closes the panel.
  nav.addEventListener('click', function (e) {
    if (e.target.closest('a')) close(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close(true);
  });

  // Tap outside the header dismisses it.
  document.addEventListener('click', function (e) {
    if (isOpen() && !e.target.closest('.site-header')) close(false);
  });

  // Back to the desktop layout: drop any open state so CSS takes over cleanly.
  function onChange() { if (desktop.matches) close(false); }
  if (desktop.addEventListener) desktop.addEventListener('change', onChange);
  else if (desktop.addListener) desktop.addListener(onChange);
})();
