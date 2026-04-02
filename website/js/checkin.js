// this script is used on any page where you want to capture the checkin form
// the first page it was used with is bocc.html
document.addEventListener('DOMContentLoaded', function() {

  // --- Helper: TTL-based localStorage ---
  var STORAGE_KEY = 'checkinData';
  var STORAGE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

  function setWithExpiry(key, value, ttlMs) {
      var item = {
          value: value,
          expiry: Date.now() + ttlMs
      };
      localStorage.setItem(key, JSON.stringify(item));
  }

  function getWithExpiry(key) {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      try {
          var item = JSON.parse(raw);
          if (!item || typeof item !== 'object' || !item.expiry || !item.value) {
              localStorage.removeItem(key);
              return null;
          }
          if (Date.now() > item.expiry) {
              localStorage.removeItem(key);
              return null;
          }
          return item.value;
      } catch (e) {
          localStorage.removeItem(key);
          return null;
      }
  }

  // --- Helper: Production check ---
  var isProduction = window.location.hostname === '716coffee.club';

  // --- Helper: Debug logger (non-PII, non-production only) ---
  function debugLog(message, metadata) {
      if (isProduction) return;
      var urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('debug') !== '1') return;
      // Only log non-sensitive metadata
      if (metadata) {
          console.log('[checkin debug]', message, metadata);
      } else {
          console.log('[checkin debug]', message);
      }
  }

  // --- Helper: Input validation/sanitization ---
  function sanitizeInput(input, maxLength) {
      if (typeof input !== 'string') return '';
      maxLength = maxLength || 255;
      return input.trim().substring(0, maxLength);
  }

  function isValidEmail(email) {
      if (!email || email.length > 254) return false;
      // Basic email format check
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function isValidPhone(phone) {
      if (!phone) return true; // phone is optional
      if (phone.length > 20) return false;
      return /^[\d\s\-\(\)\+\.]+$/.test(phone);
  }

  function showValidationError(message) {
      var errEl = document.getElementById('validationError');
      if (!errEl) {
          errEl = document.createElement('div');
          errEl.id = 'validationError';
          errEl.setAttribute('role', 'alert');
          errEl.setAttribute('tabindex', '-1');
          var form = document.getElementById('checkinForm');
          form.insertBefore(errEl, form.firstChild);
      }
      errEl.textContent = message;
      errEl.style.display = 'block';
      errEl.focus();
  }

  function clearValidationError() {
      var errEl = document.getElementById('validationError');
      if (errEl) errEl.style.display = 'none';
  }

  // --- Helper: Escape HTML to prevent XSS in name display ---
  function escapeHtml(str) {
      var div = document.createElement('div');
      div.appendChild(document.createTextNode(str));
      return div.innerHTML;
  }

  // --- Helper: Validate token ---
  function sanitizeToken(token) {
      if (!token) return '';
      if (token.length > 64) return '';
      if (!/^[a-zA-Z0-9\-]+$/.test(token)) return '';
      return token;
  }

  // --- Helper: Button states ---
  function setButtonLoading(btn) {
      btn.disabled = true;
      btn.dataset.originalText = btn.textContent;
      btn.textContent = 'Checking in\u2026';
      btn.classList.add('submitting');
  }

  function resetButton(btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalText || 'Check In';
      btn.classList.remove('submitting');
  }

  // --- Helper: Focus management for state changes ---
  function focusElement(el) {
      if (!el.getAttribute('tabindex')) {
          el.setAttribute('tabindex', '-1');
      }
      el.focus();
  }

  // --- URL parameters (gated to non-production) ---
  function getUrlParameter(name) {
      var urlParams = new URLSearchParams(window.location.search);
      return urlParams.get(name) || '';
  }

  var debug = isProduction ? '0' : getUrlParameter('debug');
  var localOnly = isProduction ? '0' : getUrlParameter('local');
  var token = sanitizeToken(getUrlParameter('token'));

  // --- Load stored checkin data (with error handling) ---
  var checkinData = null;
  try {
      var stored = getWithExpiry(STORAGE_KEY);
      if (stored && typeof stored === 'object' && stored.name && stored.email) {
          checkinData = stored;
      } else if (stored) {
          // Stored data is malformed, clear it
          localStorage.removeItem(STORAGE_KEY);
      }
  } catch (e) {
      localStorage.removeItem(STORAGE_KEY);
  }

  // Migrate any old sessionStorage data
  try {
      if (sessionStorage.getItem('checkinData')) {
          sessionStorage.removeItem('checkinData');
      }
  } catch (e) {
      // Ignore sessionStorage errors
  }

  function captureCheckinData() {
      var eventId = document.getElementById('eventId').value; // Only from hidden form field
      var checkinDate = new Date().toISOString();

      var form = document.getElementById('checkinForm');
      var formData = new FormData(form);

      // Check honeypot field
      var honeypot = formData.get('website');
      if (honeypot) {
          // Bot detected, silently abort
          return null;
      }

      // Sanitize and validate inputs
      var name = sanitizeInput(formData.get('name'));
      var email = sanitizeInput(formData.get('email'), 254);
      var phone = sanitizeInput(formData.get('phone'), 20);
      var businessName = sanitizeInput(formData.get('businessName'));

      if (!name) {
          showValidationError('Please enter your name.');
          return null;
      }

      if (!isValidEmail(email)) {
          showValidationError('Please enter a valid email address.');
          return null;
      }

      if (phone && !isValidPhone(phone)) {
          showValidationError('Please enter a valid phone number (digits, spaces, hyphens, parentheses, or dots only).');
          return null;
      }

      clearValidationError();

      var data = {
          checkinDate: checkinDate,
          eventId: sanitizeInput(eventId, 64),
          token: token,
          name: name,
          email: email,
          phone: phone,
          businessName: businessName,
          okToEmail: formData.get('okToEmail') === 'on'
      };

      debugLog('Captured checkin data', { eventId: data.eventId, checkinDate: data.checkinDate });
      return data;
  }

  async function sendCheckinData(data) {
      debugLog('Sending checkin data to API', { eventId: data.eventId });
      try {
          // Do not send debug flag to the backend
          var payload = Object.assign({}, data);
          delete payload.debug;

          var response = await fetch('https://bocc-backend.netlify.app/.netlify/functions/checkin', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify(payload)
          });
          var result = await response.json();
          debugLog('API response received', { status: response.status });
          return true;
      } catch (error) {
          console.error('Checkin submission error');
          return false;
      }
  }

  function showThankYou(apiSuccess) {
      var heading = document.getElementById('checkinHeader');
      var greeting = document.getElementById('greeting');
      heading.innerText = 'Thank you!';

      var message = '<p>Thank you for checking in!</p>';
      if (apiSuccess === false) {
          message += '<p>We saved your info locally. If connectivity issues persist, please let a host know.</p>';
      }

      // Check for sponsor redirect configuration
      var sponsorEl = document.getElementById('sponsorRedirect');
      if (sponsorEl) {
          var sponsorName = sponsorEl.dataset.sponsorName;
          var sponsorUrl = sponsorEl.dataset.sponsorUrl;
          var sponsorDelay = parseInt(sponsorEl.dataset.sponsorDelay, 10) || 5;

          message += '<div id="sponsorCountdown">' +
              '<p>Visiting <strong>' + escapeHtml(sponsorName) + '</strong> in <span id="countdownTimer">' + sponsorDelay + '</span> seconds\u2026</p>' +
              '<p><a href="' + escapeHtml(sponsorUrl) + '">Go now</a> · <button type="button" id="skipRedirect">Stay here</button></p>' +
              '</div>';
      }

      greeting.innerHTML = message;
      document.getElementById('checkinForm').style.display = 'none';
      greeting.style.display = 'block';
      focusElement(heading);

      // Start countdown if sponsor redirect exists
      if (sponsorEl) {
          startSponsorCountdown(
              sponsorEl.dataset.sponsorUrl,
              parseInt(sponsorEl.dataset.sponsorDelay, 10) || 5
          );
      }
  }

  function startSponsorCountdown(url, seconds) {
      var remaining = seconds;
      var timerEl = document.getElementById('countdownTimer');
      var countdownEl = document.getElementById('sponsorCountdown');
      var cancelled = false;

      var skipBtn = document.getElementById('skipRedirect');
      if (skipBtn) {
          skipBtn.addEventListener('click', function() {
              cancelled = true;
              countdownEl.innerHTML = '<p>Redirect cancelled.</p>';
          });
      }

      var interval = setInterval(function() {
          if (cancelled) {
              clearInterval(interval);
              return;
          }
          remaining--;
          if (timerEl) timerEl.textContent = remaining;
          if (remaining <= 0) {
              clearInterval(interval);
              window.location.href = url;
          }
      }, 1000);
  }

  if (checkinData) {
      // Returning visitor: show confirmation step
      var greetingDiv = document.getElementById('greeting');
      var form = document.getElementById('checkinForm');
      form.style.display = 'none';

      document.getElementById('checkinHeader').innerText = 'Welcome back!';
      greetingDiv.innerHTML = '<p>Welcome back, ' + escapeHtml(checkinData.name) + '!</p>' +
          '<button type="button" id="confirmCheckinBtn">Check In</button>' +
          '<button type="button" id="notMeBtn">Not me \u2014 start fresh</button>';
      greetingDiv.style.display = 'block';

      document.getElementById('notMeBtn').addEventListener('click', function() {
          localStorage.removeItem(STORAGE_KEY);
          window.location.reload();
      });

      document.getElementById('confirmCheckinBtn').addEventListener('click', async function() {
          var btn = this;
          setButtonLoading(btn);

          // Update checkin date and event-specific fields
          var eventId = document.getElementById('eventId').value;
          checkinData.checkinDate = new Date().toISOString();
          checkinData.eventId = sanitizeInput(eventId, 64);
          checkinData.token = token;

          setWithExpiry(STORAGE_KEY, checkinData, STORAGE_TTL);

          var apiSuccess = true;
          if (localOnly !== '1') {
              apiSuccess = await sendCheckinData(checkinData);
          }

          showThankYou(apiSuccess);
      });
  } else {
      var checkinForm = document.getElementById('checkinForm');

      var handleSubmit = async function(e) {
          e.preventDefault();

          var checkinButton = document.getElementById('checkinButton');
          checkinData = captureCheckinData();
          if (!checkinData) return; // Validation failed or honeypot triggered

          setButtonLoading(checkinButton);

          setWithExpiry(STORAGE_KEY, checkinData, STORAGE_TTL);

          var apiSuccess = true;
          if (localOnly !== '1') {
              apiSuccess = await sendCheckinData(checkinData);
          }

          showThankYou(apiSuccess);
      };

      checkinForm.addEventListener('submit', handleSubmit);
  }
});
