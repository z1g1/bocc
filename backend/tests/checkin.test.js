// Mock the airtable module before requiring checkin
jest.mock('../netlify/functions/utils/airtable', () => ({
    fetchAttendeeByEmail: jest.fn(),
    createAttendee: jest.fn(),
    createCheckinEntry: jest.fn(),
    findExistingCheckin: jest.fn()
}));

// Mock the circle module
jest.mock('../netlify/functions/utils/circle', () => ({
    ensureMember: jest.fn().mockResolvedValue({ id: 'circle123' })
}));

const { handler } = require('../netlify/functions/checkin');
const { fetchAttendeeByEmail, createAttendee, createCheckinEntry, findExistingCheckin } = require('../netlify/functions/utils/airtable');

describe('checkin handler', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: no duplicate check-in
        findExistingCheckin.mockResolvedValue(null);
    });

    const createEvent = (body, method = 'POST') => ({
        httpMethod: method,
        body: JSON.stringify(body)
    });

    describe('CORS preflight', () => {
        it('should handle OPTIONS request', async () => {
            const event = { httpMethod: 'OPTIONS' };
            const response = await handler(event);

            expect(response.statusCode).toBe(200);
            expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
            expect(response.headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
        });
    });

    describe('request body parsing', () => {
        it('should reject invalid JSON', async () => {
            const event = { httpMethod: 'POST', body: 'not valid json' };
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            expect(JSON.parse(response.body).message).toBe('Invalid request body');
        });

        it('should handle empty body', async () => {
            const event = { httpMethod: 'POST', body: null };
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            // Should fail validation for missing required fields
        });
    });

    describe('email validation', () => {
        it('should reject request without email', async () => {
            const event = createEvent({ eventId: 'event123' });
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            expect(JSON.parse(response.body).message).toBe('Email is required');
        });

        it('should reject request with invalid email format', async () => {
            const event = createEvent({ email: 'not-an-email', eventId: 'event123' });
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            expect(JSON.parse(response.body).message).toBe('Invalid email format');
        });

        it('should reject SQL injection attempt in email', async () => {
            const event = createEvent({ email: "' OR '1'='1", eventId: 'event123' });
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            expect(JSON.parse(response.body).message).toBe('Invalid email format');
        });

        it('should reject formula injection attempt in email', async () => {
            const event = createEvent({ email: "test@example.com' OR TRUE() OR '", eventId: 'event123' });
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            expect(JSON.parse(response.body).message).toBe('Invalid email format');
        });
    });

    describe('eventId validation', () => {
        it('should reject request without eventId', async () => {
            const event = createEvent({ email: 'user@example.com' });
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            expect(JSON.parse(response.body).message).toBe('Event ID is required');
        });

        it('should reject request with empty eventId', async () => {
            const event = createEvent({ email: 'user@example.com', eventId: '   ' });
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            expect(JSON.parse(response.body).message).toBe('Invalid event ID format');
        });
    });

    describe('phone validation', () => {
        it('should reject invalid phone format', async () => {
            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123',
                phone: 'invalid-phone!'
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            expect(JSON.parse(response.body).message).toBe('Invalid phone number format');
        });

        it('should accept valid phone format', async () => {
            fetchAttendeeByEmail.mockResolvedValue({ id: 'rec123' });
            createCheckinEntry.mockResolvedValue({ id: 'checkin123' });

            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123',
                phone: '123-456-7890'
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(200);
        });

        it('should accept empty phone (optional)', async () => {
            fetchAttendeeByEmail.mockResolvedValue({ id: 'rec123' });
            createCheckinEntry.mockResolvedValue({ id: 'checkin123' });

            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123',
                phone: ''
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(200);
        });
    });

    describe('token validation', () => {
        it('should reject invalid token format', async () => {
            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123',
                token: 'invalid@token!'
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            expect(JSON.parse(response.body).message).toBe('Invalid token format');
        });

        it('should accept valid UUID token', async () => {
            fetchAttendeeByEmail.mockResolvedValue({ id: 'rec123' });
            createCheckinEntry.mockResolvedValue({ id: 'checkin123' });

            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123',
                token: '550e8400-e29b-41d4-a716-446655440000'
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(200);
        });
    });

    describe('existing attendee checkin', () => {
        it('should create checkin for existing attendee', async () => {
            const existingAttendee = { id: 'rec123' };
            fetchAttendeeByEmail.mockResolvedValue(existingAttendee);
            findExistingCheckin.mockResolvedValue(null); // No duplicate
            createCheckinEntry.mockResolvedValue({ id: 'checkin123' });

            const event = createEvent({
                email: 'existing@example.com',
                eventId: 'event123',
                debug: '1',
                token: 'abc123'
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body).message).toBe('Check-in successful');
            expect(createCheckinEntry).toHaveBeenCalledWith('rec123', 'event123', true, 'abc123');
            expect(createAttendee).not.toHaveBeenCalled();
        });
    });

    describe('new attendee checkin', () => {
        it('should create new attendee and checkin when attendee does not exist', async () => {
            fetchAttendeeByEmail.mockResolvedValue(null);
            createAttendee.mockResolvedValue({ id: 'newrec123' });
            findExistingCheckin.mockResolvedValue(null); // No duplicate
            createCheckinEntry.mockResolvedValue({ id: 'checkin123' });

            const event = createEvent({
                email: 'NEW@EXAMPLE.COM',
                name: '  John   Doe  ',
                phone: '123-456-7890',
                businessName: 'Test Business',
                okToEmail: true,
                eventId: 'event123',
                debug: '0',
                token: ''
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(200);
            // Email should be lowercased, name should be sanitized
            expect(createAttendee).toHaveBeenCalledWith(
                'new@example.com',
                'John Doe',
                '123-456-7890',
                'Test Business',
                true,
                false
            );
            expect(createCheckinEntry).toHaveBeenCalledWith('newrec123', 'event123', false, '');
        });
    });

    describe('input sanitization', () => {
        it('should sanitize XSS attempt in name', async () => {
            fetchAttendeeByEmail.mockResolvedValue(null);
            createAttendee.mockResolvedValue({ id: 'newrec123' });
            createCheckinEntry.mockResolvedValue({ id: 'checkin123' });

            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123',
                name: '<script>alert("xss")</script>John'
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(200);
            expect(createAttendee).toHaveBeenCalledWith(
                'user@example.com',
                'alert("xss")John',
                '',
                '',
                false,
                false
            );
        });

        it('should sanitize business name', async () => {
            fetchAttendeeByEmail.mockResolvedValue(null);
            createAttendee.mockResolvedValue({ id: 'newrec123' });
            createCheckinEntry.mockResolvedValue({ id: 'checkin123' });

            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123',
                businessName: '  <div>Acme</div>   Corp  '
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(200);
            expect(createAttendee).toHaveBeenCalledWith(
                'user@example.com',
                '',
                '',
                'Acme Corp',
                false,
                false
            );
        });
    });

    describe('error handling', () => {
        it('should return 500 with generic message on database error', async () => {
            fetchAttendeeByEmail.mockRejectedValue(new Error('Database connection failed'));

            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123'
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(500);
            // Should NOT expose internal error message (Issue #7)
            const body = JSON.parse(response.body);
            expect(body.message).toBe('An error occurred while processing your request');
            expect(body.error).toBeUndefined();
        });
    });

    describe('debug flag handling', () => {
        it('should set debug flag to true when debug is "1"', async () => {
            fetchAttendeeByEmail.mockResolvedValue({ id: 'rec123' });
            createCheckinEntry.mockResolvedValue({ id: 'checkin123' });

            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123',
                debug: '1'
            });
            await handler(event);

            expect(createCheckinEntry).toHaveBeenCalledWith('rec123', 'event123', true, '');
        });

        it('should set debug flag to false when debug is "0"', async () => {
            fetchAttendeeByEmail.mockResolvedValue({ id: 'rec123' });
            createCheckinEntry.mockResolvedValue({ id: 'checkin123' });

            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123',
                debug: '0'
            });
            await handler(event);

            expect(createCheckinEntry).toHaveBeenCalledWith('rec123', 'event123', false, '');
        });

        it('should set debug flag to false when debug is not provided', async () => {
            fetchAttendeeByEmail.mockResolvedValue({ id: 'rec123' });
            createCheckinEntry.mockResolvedValue({ id: 'checkin123' });

            const event = createEvent({
                email: 'user@example.com',
                eventId: 'event123'
            });
            await handler(event);

            expect(createCheckinEntry).toHaveBeenCalledWith('rec123', 'event123', false, '');
        });
    });

    describe('validation error responses', () => {
        it('should return all validation errors', async () => {
            const event = createEvent({
                email: 'invalid',
                phone: 'invalid!',
                token: 'invalid@token'
            });
            const response = await handler(event);

            expect(response.statusCode).toBe(400);
            const body = JSON.parse(response.body);
            expect(body.errors).toBeDefined();
            expect(body.errors.length).toBeGreaterThan(1);
        });
    });
});
