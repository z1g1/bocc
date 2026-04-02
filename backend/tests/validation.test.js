const {
    escapeAirtableFormula,
    isValidEmail,
    isValidPhone,
    sanitizeText,
    isValidEventId,
    isValidToken,
    validateCheckinInput
} = require('../netlify/functions/utils/validation');

describe('escapeAirtableFormula', () => {
    describe('handles valid inputs', () => {
        it('should return unchanged string for normal email', () => {
            expect(escapeAirtableFormula('user@example.com')).toBe('user@example.com');
        });

        it('should return unchanged string for alphanumeric input', () => {
            expect(escapeAirtableFormula('test123')).toBe('test123');
        });

        it('should handle empty string', () => {
            expect(escapeAirtableFormula('')).toBe('');
        });
    });

    describe('escapes dangerous characters', () => {
        it('should escape single quotes', () => {
            expect(escapeAirtableFormula("o'brien@example.com")).toBe("o\\'brien@example.com");
        });

        it('should escape multiple single quotes', () => {
            expect(escapeAirtableFormula("it's o'brien's")).toBe("it\\'s o\\'brien\\'s");
        });

        it('should escape backslashes', () => {
            expect(escapeAirtableFormula('test\\value')).toBe('test\\\\value');
        });

        it('should escape backslashes before single quotes', () => {
            expect(escapeAirtableFormula("test\\'value")).toBe("test\\\\\\'value");
        });
    });

    describe('prevents formula injection attacks', () => {
        it('should escape SQL-style injection attempt', () => {
            const malicious = "' OR TRUE() OR '1'='1";
            const escaped = escapeAirtableFormula(malicious);
            expect(escaped).toBe("\\' OR TRUE() OR \\'1\\'=\\'1");
            // All single quotes should be escaped with backslash
            expect(escaped.match(/(?<!\\)'/g)).toBeNull();
        });

        it('should escape formula breakout attempt', () => {
            const malicious = "test@example.com' OR 1=1 OR '";
            const escaped = escapeAirtableFormula(malicious);
            expect(escaped).toBe("test@example.com\\' OR 1=1 OR \\'");
        });

        it('should escape nested quote injection', () => {
            const malicious = "admin'--";
            const escaped = escapeAirtableFormula(malicious);
            expect(escaped).toBe("admin\\'--");
        });

        it('should handle complex injection payload', () => {
            const malicious = "'), {secret}) OR ({email} = '";
            const escaped = escapeAirtableFormula(malicious);
            expect(escaped).toBe("\\'), {secret}) OR ({email} = \\'");
        });
    });

    describe('handles edge cases', () => {
        it('should return empty string for null', () => {
            expect(escapeAirtableFormula(null)).toBe('');
        });

        it('should return empty string for undefined', () => {
            expect(escapeAirtableFormula(undefined)).toBe('');
        });

        it('should return empty string for number', () => {
            expect(escapeAirtableFormula(123)).toBe('');
        });

        it('should return empty string for object', () => {
            expect(escapeAirtableFormula({})).toBe('');
        });

        it('should return empty string for array', () => {
            expect(escapeAirtableFormula([])).toBe('');
        });
    });
});

describe('isValidEmail', () => {
    describe('accepts valid emails', () => {
        it('should accept standard email format', () => {
            expect(isValidEmail('user@example.com')).toBe(true);
        });

        it('should accept email with subdomain', () => {
            expect(isValidEmail('user@mail.example.com')).toBe(true);
        });

        it('should accept email with plus sign', () => {
            expect(isValidEmail('user+tag@example.com')).toBe(true);
        });

        it('should accept email with dots in local part', () => {
            expect(isValidEmail('first.last@example.com')).toBe(true);
        });

        it('should accept email with numbers', () => {
            expect(isValidEmail('user123@example123.com')).toBe(true);
        });

        it('should accept email with hyphen in domain', () => {
            expect(isValidEmail('user@my-domain.com')).toBe(true);
        });

        it('should accept email with underscore', () => {
            expect(isValidEmail('user_name@example.com')).toBe(true);
        });
    });

    describe('rejects invalid emails', () => {
        it('should reject email without @', () => {
            expect(isValidEmail('userexample.com')).toBe(false);
        });

        it('should reject email without domain', () => {
            expect(isValidEmail('user@')).toBe(false);
        });

        it('should reject email without local part', () => {
            expect(isValidEmail('@example.com')).toBe(false);
        });

        it('should reject email with spaces', () => {
            expect(isValidEmail('user @example.com')).toBe(false);
        });

        it('should reject email without TLD', () => {
            expect(isValidEmail('user@example')).toBe(false);
        });

        it('should reject empty string', () => {
            expect(isValidEmail('')).toBe(false);
        });

        it('should reject plain text', () => {
            expect(isValidEmail('not an email')).toBe(false);
        });

        it('should reject overly long emails', () => {
            const longEmail = 'a'.repeat(250) + '@example.com';
            expect(isValidEmail(longEmail)).toBe(false);
        });
    });

    describe('rejects injection attempts', () => {
        it('should reject email with single quotes', () => {
            expect(isValidEmail("user'@example.com")).toBe(false);
        });

        it('should reject SQL injection pattern', () => {
            expect(isValidEmail("' OR '1'='1")).toBe(false);
        });

        it('should reject formula injection pattern', () => {
            expect(isValidEmail("test@example.com' OR TRUE()")).toBe(false);
        });

        it('should reject email with backslash', () => {
            expect(isValidEmail("user\\@example.com")).toBe(false);
        });
    });

    describe('handles edge cases', () => {
        it('should return false for null', () => {
            expect(isValidEmail(null)).toBe(false);
        });

        it('should return false for undefined', () => {
            expect(isValidEmail(undefined)).toBe(false);
        });

        it('should return false for number', () => {
            expect(isValidEmail(123)).toBe(false);
        });

        it('should return false for object', () => {
            expect(isValidEmail({})).toBe(false);
        });

        it('should return false for array', () => {
            expect(isValidEmail([])).toBe(false);
        });
    });
});

describe('isValidPhone', () => {
    describe('accepts valid phone numbers', () => {
        it('should accept standard 10-digit format', () => {
            expect(isValidPhone('1234567890')).toBe(true);
        });

        it('should accept formatted phone number', () => {
            expect(isValidPhone('123-456-7890')).toBe(true);
        });

        it('should accept phone with parentheses', () => {
            expect(isValidPhone('(123) 456-7890')).toBe(true);
        });

        it('should accept international format with plus', () => {
            expect(isValidPhone('+1234567890')).toBe(true);
        });

        it('should accept phone with dots', () => {
            expect(isValidPhone('123.456.7890')).toBe(true);
        });

        it('should accept 7-digit phone number', () => {
            expect(isValidPhone('4567890')).toBe(true);
        });

        it('should accept international long format', () => {
            expect(isValidPhone('+44 20 7946 0958')).toBe(true);
        });
    });

    describe('accepts empty/optional values', () => {
        it('should accept empty string', () => {
            expect(isValidPhone('')).toBe(true);
        });

        it('should accept null', () => {
            expect(isValidPhone(null)).toBe(true);
        });

        it('should accept undefined', () => {
            expect(isValidPhone(undefined)).toBe(true);
        });
    });

    describe('rejects invalid phone numbers', () => {
        it('should reject too short numbers', () => {
            expect(isValidPhone('123456')).toBe(false);
        });

        it('should reject too long numbers', () => {
            expect(isValidPhone('1234567890123456')).toBe(false);
        });

        it('should reject letters', () => {
            expect(isValidPhone('123-ABC-7890')).toBe(false);
        });

        it('should reject special characters', () => {
            expect(isValidPhone('123@456#7890')).toBe(false);
        });

        it('should reject non-string types', () => {
            expect(isValidPhone(1234567890)).toBe(false);
        });
    });
});

describe('sanitizeText', () => {
    describe('removes dangerous content', () => {
        it('should remove HTML tags', () => {
            expect(sanitizeText('<script>alert("xss")</script>')).toBe('alert("xss")');
        });

        it('should remove javascript: protocol', () => {
            expect(sanitizeText('javascript:alert(1)')).toBe('alert(1)');
        });

        it('should remove event handlers', () => {
            expect(sanitizeText('onclick=alert(1)')).toBe('alert(1)');
        });

        it('should remove angle brackets', () => {
            expect(sanitizeText('test<>value')).toBe('testvalue');
        });

        it('should handle nested tags', () => {
            expect(sanitizeText('<div><script>bad</script></div>')).toBe('bad');
        });
    });

    describe('normalizes whitespace', () => {
        it('should trim leading and trailing whitespace', () => {
            expect(sanitizeText('  hello world  ')).toBe('hello world');
        });

        it('should collapse multiple spaces', () => {
            expect(sanitizeText('hello    world')).toBe('hello world');
        });

        it('should normalize newlines and tabs', () => {
            expect(sanitizeText('hello\n\t\tworld')).toBe('hello world');
        });
    });

    describe('preserves valid content', () => {
        it('should preserve normal text', () => {
            expect(sanitizeText('John Doe')).toBe('John Doe');
        });

        it('should preserve business names', () => {
            expect(sanitizeText("Acme Corp & Sons")).toBe("Acme Corp & Sons");
        });

        it('should preserve unicode characters', () => {
            expect(sanitizeText('José García')).toBe('José García');
        });
    });

    describe('handles edge cases', () => {
        it('should return empty string for null', () => {
            expect(sanitizeText(null)).toBe('');
        });

        it('should return empty string for undefined', () => {
            expect(sanitizeText(undefined)).toBe('');
        });

        it('should return empty string for number', () => {
            expect(sanitizeText(123)).toBe('');
        });

        it('should handle empty string', () => {
            expect(sanitizeText('')).toBe('');
        });
    });
});

describe('isValidEventId', () => {
    describe('accepts valid event IDs', () => {
        it('should accept alphanumeric event ID', () => {
            expect(isValidEventId('event123')).toBe(true);
        });

        it('should accept UUID format', () => {
            expect(isValidEventId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
        });

        it('should accept single character', () => {
            expect(isValidEventId('a')).toBe(true);
        });
    });

    describe('rejects invalid event IDs', () => {
        it('should reject empty string', () => {
            expect(isValidEventId('')).toBe(false);
        });

        it('should reject whitespace only', () => {
            expect(isValidEventId('   ')).toBe(false);
        });

        it('should reject null', () => {
            expect(isValidEventId(null)).toBe(false);
        });

        it('should reject undefined', () => {
            expect(isValidEventId(undefined)).toBe(false);
        });

        it('should reject number', () => {
            expect(isValidEventId(123)).toBe(false);
        });

        it('should reject overly long event ID', () => {
            expect(isValidEventId('a'.repeat(256))).toBe(false);
        });
    });
});

describe('isValidToken', () => {
    describe('accepts valid tokens', () => {
        it('should accept alphanumeric token', () => {
            expect(isValidToken('abc123')).toBe(true);
        });

        it('should accept UUID format', () => {
            expect(isValidToken('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
        });

        it('should accept uppercase', () => {
            expect(isValidToken('ABC123')).toBe(true);
        });
    });

    describe('accepts empty/optional values', () => {
        it('should accept empty string', () => {
            expect(isValidToken('')).toBe(true);
        });

        it('should accept null', () => {
            expect(isValidToken(null)).toBe(true);
        });

        it('should accept undefined', () => {
            expect(isValidToken(undefined)).toBe(true);
        });
    });

    describe('rejects invalid tokens', () => {
        it('should reject special characters', () => {
            expect(isValidToken('token@123')).toBe(false);
        });

        it('should reject spaces', () => {
            expect(isValidToken('token 123')).toBe(false);
        });

        it('should reject overly long tokens', () => {
            expect(isValidToken('a'.repeat(129))).toBe(false);
        });

        it('should reject non-string types', () => {
            expect(isValidToken(123)).toBe(false);
        });
    });
});

describe('validateCheckinInput', () => {
    describe('validates complete valid input', () => {
        it('should accept valid complete input', () => {
            const input = {
                email: 'user@example.com',
                eventId: 'event123',
                name: 'John Doe',
                phone: '123-456-7890',
                businessName: 'Acme Corp',
                token: 'abc-123',
                okToEmail: true,
                debug: '1'
            };
            const result = validateCheckinInput(input);
            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.sanitized.email).toBe('user@example.com');
            expect(result.sanitized.debug).toBe(true);
        });

        it('should accept minimal valid input', () => {
            const input = {
                email: 'user@example.com',
                eventId: 'event123'
            };
            const result = validateCheckinInput(input);
            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });
    });

    describe('validates required fields', () => {
        it('should reject missing email', () => {
            const input = { eventId: 'event123' };
            const result = validateCheckinInput(input);
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Email is required');
        });

        it('should reject missing eventId', () => {
            const input = { email: 'user@example.com' };
            const result = validateCheckinInput(input);
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Event ID is required');
        });

        it('should reject invalid email', () => {
            const input = { email: 'invalid', eventId: 'event123' };
            const result = validateCheckinInput(input);
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Invalid email format');
        });
    });

    describe('validates optional fields', () => {
        it('should reject invalid phone', () => {
            const input = {
                email: 'user@example.com',
                eventId: 'event123',
                phone: 'invalid-phone!'
            };
            const result = validateCheckinInput(input);
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Invalid phone number format');
        });

        it('should reject invalid token', () => {
            const input = {
                email: 'user@example.com',
                eventId: 'event123',
                token: 'invalid@token!'
            };
            const result = validateCheckinInput(input);
            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Invalid token format');
        });
    });

    describe('sanitizes inputs', () => {
        it('should lowercase email', () => {
            const input = {
                email: 'USER@EXAMPLE.COM',
                eventId: 'event123'
            };
            const result = validateCheckinInput(input);
            expect(result.sanitized.email).toBe('user@example.com');
        });

        it('should sanitize name with XSS attempt', () => {
            const input = {
                email: 'user@example.com',
                eventId: 'event123',
                name: '<script>alert("xss")</script>John'
            };
            const result = validateCheckinInput(input);
            expect(result.sanitized.name).toBe('alert("xss")John');
        });

        it('should sanitize business name', () => {
            const input = {
                email: 'user@example.com',
                eventId: 'event123',
                businessName: '  Acme   Corp  '
            };
            const result = validateCheckinInput(input);
            expect(result.sanitized.businessName).toBe('Acme Corp');
        });

        it('should handle debug flag correctly', () => {
            const input1 = { email: 'user@example.com', eventId: 'event123', debug: '1' };
            const input2 = { email: 'user@example.com', eventId: 'event123', debug: '0' };
            const input3 = { email: 'user@example.com', eventId: 'event123' };

            expect(validateCheckinInput(input1).sanitized.debug).toBe(true);
            expect(validateCheckinInput(input2).sanitized.debug).toBe(false);
            expect(validateCheckinInput(input3).sanitized.debug).toBe(false);
        });
    });

    describe('collects multiple errors', () => {
        it('should report all validation errors', () => {
            const input = {
                email: 'invalid',
                phone: 'invalid!',
                token: 'invalid@token'
            };
            const result = validateCheckinInput(input);
            expect(result.isValid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(1);
        });
    });
});
