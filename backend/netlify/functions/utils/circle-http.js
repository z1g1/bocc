/**
 * Circle.so shared HTTP transport.
 *
 * One place that builds authed axios clients and logs Circle API errors, so the
 * two Circle domain modules — circle.js (Admin API v2) and circle-member-api.js
 * (Headless) — stop each hand-rolling their own transport and repeating the same
 * error-logging block. See CONTEXT.md → "Circle transport" seam.
 *
 * Scope (per grilling): centralize transport + error logging only. Callers keep
 * throwing the same errors; no domain error classes are introduced, because the
 * only caller that branches on an error is getAllMembers' 401 check.
 */

const axios = require('axios');

/**
 * Build an axios client with Bearer auth for a Circle API.
 * The baseURL is passed straight through to axios.create so callers (and the
 * test mocks that branch on baseURL) see the same shape as before.
 *
 * @param {object} opts
 * @param {string} opts.baseURL - API base URL
 * @param {string} opts.token   - Bearer token (admin token, headless token, or bot JWT)
 * @returns {import('axios').AxiosInstance}
 */
const createCircleClient = ({ baseURL, token }) =>
    axios.create({
        baseURL,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

/**
 * Log a Circle API error consistently: a contextual message plus the response
 * status/data when the failure came back from the API.
 *
 * @param {string} context - leading message, e.g. 'Error creating Circle member'
 * @param {Error}  error   - the caught error (may carry an axios `response`)
 */
const logCircleError = (context, error) => {
    console.error(`${context}:`, error.message);
    if (error.response) {
        console.error('Circle API response status:', error.response.status);
        console.error('Circle API response data:', JSON.stringify(error.response.data));
    }
};

module.exports = {
    createCircleClient,
    logCircleError
};
