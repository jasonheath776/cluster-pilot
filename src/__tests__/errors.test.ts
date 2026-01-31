import { getErrorMessage, getErrorDetails, isRetryableError, handle } from '../utils/errors';

describe('error utilities', () => {
    describe('getErrorMessage', () => {
        it('should extract message from Error object', () => {
            const error = new Error('Test error message');
            expect(getErrorMessage(error)).toBe('Test error message');
        });

        it('should handle string errors', () => {
            expect(getErrorMessage('String error')).toBe('String error');
        });

        it('should handle null and undefined', () => {
            const nullResult = getErrorMessage(null);
            const undefinedResult = getErrorMessage(undefined);
            expect(typeof nullResult).toBe('string');
            expect(typeof undefinedResult).toBe('string');
        });

        it('should handle empty Error', () => {
            const error = new Error();
            expect(getErrorMessage(error)).toBe('');
        });

        it('should handle objects with message property', () => {
            const obj = { message: 'Object message' };
            expect(getErrorMessage(obj)).toBe('Object message');
        });
    });

    describe('getErrorDetails', () => {
        it('should return message and stack from Error', () => {
            const error = new Error('Test error');
            const details = getErrorDetails(error);
            
            expect(details.message).toBe('Test error');
            expect(details.stack).toBeDefined();
            expect(details.stack).toContain('Error: Test error');
        });

        it('should handle errors without stack', () => {
            const error = { message: 'No stack error' };
            const details = getErrorDetails(error);
            
            expect(details.message).toBeDefined();
            expect(details.stack).toBeUndefined();
        });

        it('should extract details from HTTP errors', () => {
            const httpError = {
                message: 'Network error',
                response: {
                    status: 500,
                    data: { message: 'Server error' }
                }
            };
            const details = getErrorDetails(httpError);
            
            expect(details.message).toBeDefined();
        });
    });

    describe('isRetryableError', () => {
        it('should identify network errors as retryable', () => {
            expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
            expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
            expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
            expect(isRetryableError(new Error('socket hang up'))).toBe(true);
        });

        it('should not identify non-network errors as retryable', () => {
            expect(isRetryableError(new Error('Unknown error'))).toBe(false);
            expect(isRetryableError('String error')).toBe(false);
        });

        it('should handle null and undefined', () => {
            expect(isRetryableError(null)).toBe(false);
            expect(isRetryableError(undefined)).toBe(false);
        });
    });

    describe('handle (Go-style error handling)', () => {
        it('should return [null, result] on success', async () => {
            const promise = Promise.resolve('success');
            const [error, result] = await handle(promise);
            
            expect(error).toBeNull();
            expect(result).toBe('success');
        });

        it('should return [error, null] on failure', async () => {
            const testError = new Error('Test failure');
            const promise = Promise.reject(testError);
            const [error, result] = await handle(promise);
            
            expect(error).toEqual(testError);
            expect(result).toBeNull();
        });

        it('should work with async functions', async () => {
            const asyncFunc = async () => 'value';
            const [error, result] = await handle(asyncFunc());
            
            expect(error).toBeNull();
            expect(result).toBe('value');
        });
    });
});
