/**
 * Escapes a string value for safe use in Airtable formula queries.
 * Prevents formula injection attacks by escaping special characters.
 * @param {string} value - The value to escape
 * @returns {string} - The escaped value safe for use in formulas
 */
const escapeAirtableFormula = (value) => {
    if (typeof value !== 'string') {
        return '';
    }
    // Escape backslashes first, then single quotes
    // Airtable formulas use backslash as escape character
    return value
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
};

/**
 * Validates that an email address has a proper format.
 * Uses a more comprehensive regex pattern for RFC 5322 compliance.
 * Rejects emails with potentially dangerous characters as a defense-in-depth measure.
 * @param {string} email - The email to validate
 * @returns {boolean} - True if valid email format, false otherwise
 */
const isValidEmail = (email) => {
    if (typeof email !== 'string') {
        return false;
    }
    // More comprehensive email validation regex
    // - Allows alphanumeric, dots, hyphens, underscores, plus signs in local part
    // - Rejects dangerous characters (single quotes, backslashes)
    // - Requires valid domain format with TLD
    const emailRegex = /^[a-zA-Z0-9.!#$%&*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

    // Additional security check - reject dangerous characters
    if (/['\\]/.test(email)) {
        return false;
    }

    return emailRegex.test(email) && email.length <= 254;
};

/**
 * Validates phone number format.
 * Accepts common formats: (123) 456-7890, 123-456-7890, 1234567890, +1234567890
 * @param {string} phone - The phone number to validate
 * @returns {boolean} - True if valid phone format or empty, false otherwise
 */
const isValidPhone = (phone) => {
    // Phone is optional, so empty/null/undefined is valid
    if (!phone || phone === '') {
        return true;
    }
    if (typeof phone !== 'string') {
        return false;
    }
    // Remove common formatting characters for validation
    const digitsOnly = phone.replace(/[\s\-\(\)\.\+]/g, '');
    // Must be between 7 and 15 digits (international standard)
    if (!/^\d{7,15}$/.test(digitsOnly)) {
        return false;
    }
    // Original must only contain allowed characters
    const allowedChars = /^[\d\s\-\(\)\.\+]+$/;
    return allowedChars.test(phone);
};

/**
 * Sanitizes a text input by removing XSS-prone characters and normalizing whitespace.
 * @param {string} text - The text to sanitize
 * @returns {string} - The sanitized text
 */
const sanitizeText = (text) => {
    if (typeof text !== 'string') {
        return '';
    }
    return text
        // Remove HTML tags
        .replace(/<[^>]*>/g, '')
        // Remove script-related patterns
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '')
        // Remove potentially dangerous characters
        .replace(/[<>]/g, '')
        // Normalize whitespace (collapse multiple spaces, trim)
        .replace(/\s+/g, ' ')
        .trim();
};

/**
 * Validates that eventId is a non-empty string.
 * @param {string} eventId - The event ID to validate
 * @returns {boolean} - True if valid eventId, false otherwise
 */
const isValidEventId = (eventId) => {
    if (typeof eventId !== 'string') {
        return false;
    }
    const trimmed = eventId.trim();
    // Must be non-empty and reasonable length
    return trimmed.length > 0 && trimmed.length <= 255;
};

/**
 * Validates token format when provided.
 * Tokens should be alphanumeric with optional hyphens (UUID-like format).
 * @param {string} token - The token to validate
 * @returns {boolean} - True if valid token or empty, false otherwise
 */
const isValidToken = (token) => {
    // Token is optional, so empty/null/undefined is valid
    if (!token || token === '') {
        return true;
    }
    if (typeof token !== 'string') {
        return false;
    }
    // Allow alphanumeric characters and hyphens (for UUID format)
    // Must be reasonable length (up to 128 chars for GUIDs and similar)
    const tokenRegex = /^[a-zA-Z0-9\-]{1,128}$/;
    return tokenRegex.test(token);
};

/**
 * Validates all input fields and returns validation result with errors.
 * @param {Object} input - The input object to validate
 * @returns {Object} - { isValid: boolean, errors: string[], sanitized: Object }
 */
const validateCheckinInput = (input) => {
    const errors = [];
    const sanitized = {};

    // Email validation (required)
    if (!input.email) {
        errors.push('Email is required');
    } else if (!isValidEmail(input.email)) {
        errors.push('Invalid email format');
    } else {
        sanitized.email = input.email.trim().toLowerCase();
    }

    // EventId validation (required)
    if (!input.eventId) {
        errors.push('Event ID is required');
    } else if (!isValidEventId(input.eventId)) {
        errors.push('Invalid event ID format');
    } else {
        sanitized.eventId = input.eventId.trim();
    }

    // Phone validation (optional)
    if (input.phone && !isValidPhone(input.phone)) {
        errors.push('Invalid phone number format');
    } else {
        sanitized.phone = input.phone ? sanitizeText(input.phone) : '';
    }

    // Name sanitization (optional)
    sanitized.name = sanitizeText(input.name || '');

    // Business name sanitization (optional)
    sanitized.businessName = sanitizeText(input.businessName || '');

    // Token validation (optional)
    if (input.token && !isValidToken(input.token)) {
        errors.push('Invalid token format');
    } else {
        sanitized.token = input.token || '';
    }

    // Boolean fields
    sanitized.okToEmail = Boolean(input.okToEmail);
    sanitized.debug = input.debug === '1';

    return {
        isValid: errors.length === 0,
        errors,
        sanitized
    };
};

module.exports = {
    escapeAirtableFormula,
    isValidEmail,
    isValidPhone,
    sanitizeText,
    isValidEventId,
    isValidToken,
    validateCheckinInput
};
