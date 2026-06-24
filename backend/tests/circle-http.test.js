// Tests for the shared Circle transport (utils/circle-http.js).

const mockAxiosCreate = jest.fn(() => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('axios', () => ({ create: mockAxiosCreate }));

const { createCircleClient, logCircleError } = require('../netlify/functions/utils/circle-http');

describe('circle-http transport', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('createCircleClient', () => {
        test('passes baseURL through and builds a Bearer auth header', () => {
            createCircleClient({ baseURL: 'https://app.circle.so/api/admin/v2', token: 'tok_123' });

            expect(mockAxiosCreate).toHaveBeenCalledWith({
                baseURL: 'https://app.circle.so/api/admin/v2',
                headers: {
                    'Authorization': 'Bearer tok_123',
                    'Content-Type': 'application/json'
                }
            });
        });
    });

    describe('logCircleError', () => {
        let consoleErrorSpy;
        beforeEach(() => { consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
        afterEach(() => { consoleErrorSpy.mockRestore(); });

        test('logs the context message and message', () => {
            logCircleError('Error doing thing', new Error('boom'));

            expect(consoleErrorSpy).toHaveBeenCalledWith('Error doing thing:', 'boom');
        });

        test('logs response status and JSON-stringified data when present', () => {
            const error = new Error('API Error');
            error.response = { status: 404, data: { message: 'not found' } };

            logCircleError('Error doing thing', error);

            expect(consoleErrorSpy).toHaveBeenCalledWith('Circle API response status:', 404);
            expect(consoleErrorSpy).toHaveBeenCalledWith('Circle API response data:', JSON.stringify({ message: 'not found' }));
        });

        test('omits response lines when there is no response', () => {
            logCircleError('Error doing thing', new Error('network down'));

            expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        });
    });
});
