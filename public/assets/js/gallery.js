/* gallery.js — responsive carousel for the "Don't take our word for it" wall.
 *
 * Progressive enhancement over a native scroll-snap track: without JS the track
 * is still a swipeable / scrollable list of screenshots. This script adds
 * prev/next buttons + dot controls, keeps the active dot and button states in
 * sync with the scroll position, and supports left/right arrow keys. Smooth
 * scrolling is skipped under prefers-reduced-motion.
 */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  function initGallery(root) {
    var viewport = root.querySelector('.gallery__viewport');
    var track = root.querySelector('[data-gallery-track]');
    var slides = Array.prototype.slice.call(root.querySelectorAll('[data-gallery-slide]'));
    var prev = root.querySelector('[data-gallery-prev]');
    var next = root.querySelector('[data-gallery-next]');
    var dots = Array.prototype.slice.call(root.querySelectorAll('[data-gallery-dot]'));
    if (!track || slides.length < 2) {
      // Nothing to navigate — hide controls.
      [prev, next].forEach(function (b) { if (b) b.style.display = 'none'; });
      var dotWrap = root.querySelector('[data-gallery-dots]');
      if (dotWrap) dotWrap.style.display = 'none';
      return;
    }

    var index = 0;

    function scrollToIndex(i) {
      index = Math.max(0, Math.min(slides.length - 1, i));
      var left = slides[index].offsetLeft - track.offsetLeft;
      track.scrollTo({ left: left, behavior: reduce.matches ? 'auto' : 'smooth' });
    }

    function nearestIndex() {
      // The slide whose centre is closest to the viewport centre.
      var mid = track.scrollLeft + track.clientWidth / 2;
      var best = 0, bestDist = Infinity;
      slides.forEach(function (s, i) {
        var c = s.offsetLeft - track.offsetLeft + s.clientWidth / 2;
        var d = Math.abs(c - mid);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      return best;
    }

    // Match the viewport height to the active slide so wide posts don't float
    // inside a tall frame. Slides are top-aligned in CSS; we just clip to height.
    function fitHeight() {
      if (!viewport) return;
      viewport.style.height = slides[index].offsetHeight + 'px';
    }

    function sync() {
      index = nearestIndex();
      fitHeight();
      dots.forEach(function (d, i) {
        var on = i === index;
        d.classList.toggle('is-active', on);
        d.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (prev) prev.disabled = index === 0;
      if (next) next.disabled = index === slides.length - 1;
    }

    if (prev) prev.addEventListener('click', function () { scrollToIndex(index - 1); });
    if (next) next.addEventListener('click', function () { scrollToIndex(index + 1); });
    dots.forEach(function (d, i) {
      d.addEventListener('click', function () { scrollToIndex(i); });
    });

    // Keep state in sync as the user scrolls/swipes (rAF-throttled).
    var ticking = false;
    track.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () { sync(); ticking = false; });
    }, { passive: true });

    // Arrow-key navigation when the carousel has focus.
    root.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); scrollToIndex(index - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); scrollToIndex(index + 1); }
    });

    window.addEventListener('resize', sync);

    // Lazy-loaded images change a slide's height once they arrive — refit then.
    root.querySelectorAll('.gallery__img').forEach(function (img) {
      if (img.complete) return;
      img.addEventListener('load', fitHeight, { once: true });
    });

    sync();
  }

  var galleries = document.querySelectorAll('[data-gallery]');
  Array.prototype.forEach.call(galleries, initGallery);
})();
