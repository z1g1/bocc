/* hero-quote.js — rotating attendee pull-quote (progressive enhancement).
 *
 * The first quote is already visible from the server-rendered HTML, so the
 * hero reads fine with JS disabled. This script cross-fades through the rest
 * every ~5.2s and wires the dot controls. It bails entirely under
 * prefers-reduced-motion (one static quote, no auto-rotate) per WCAG.
 */
(function () {
  'use strict';

  var root = document.querySelector('[data-rquote]');
  if (!root) return;

  var items = Array.prototype.slice.call(root.querySelectorAll('[data-rquote-item]'));
  var dots = Array.prototype.slice.call(root.querySelectorAll('[data-rquote-dot]'));
  if (items.length < 2) return;

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var index = 0;
  var timer = null;
  var INTERVAL = 5200;

  function show(next) {
    if (next === index) return;
    items[index].classList.remove('is-active');
    items[index].setAttribute('aria-hidden', 'true');
    if (dots[index]) dots[index].classList.remove('is-active');

    index = (next + items.length) % items.length;

    items[index].classList.add('is-active');
    items[index].removeAttribute('aria-hidden');
    if (dots[index]) dots[index].classList.add('is-active');
  }

  function advance() { show(index + 1); }

  function start() {
    if (reduce.matches || timer) return;
    timer = window.setInterval(advance, INTERVAL);
  }

  function stop() {
    if (timer) { window.clearInterval(timer); timer = null; }
  }

  // Dot controls: jump to a quote and (re)start the cycle.
  dots.forEach(function (dot, i) {
    dot.addEventListener('click', function () {
      stop();
      show(i);
      start();
    });
  });

  // Pause on hover / focus-within so readers aren't rushed.
  root.addEventListener('mouseenter', stop);
  root.addEventListener('mouseleave', start);
  root.addEventListener('focusin', stop);
  root.addEventListener('focusout', start);

  // React to a live change in the motion preference.
  var onPref = function () { reduce.matches ? stop() : start(); };
  if (reduce.addEventListener) reduce.addEventListener('change', onPref);
  else if (reduce.addListener) reduce.addListener(onPref);

  start();
})();
