// assets/js/analytics.js — loads Google Analytics 4 on the production site only.
// The measurement ID comes from this script tag's data-ga-id attribute, set from
// _config.yml by _includes/analytics.html. Local and preview builds send nothing.
(function () {
  var id = document.currentScript && document.currentScript.getAttribute('data-ga-id');
  if (!id || window.location.hostname !== '716coffee.club') return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', id);

  var tag = document.createElement('script');
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
  document.head.appendChild(tag);
})();
