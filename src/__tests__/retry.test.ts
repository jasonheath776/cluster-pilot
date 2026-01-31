import { withRetry, retryable, isRetryableError } from '../utils/retry';

// Mock logger to avoid actual logging during tests
jest.mock('../utils/logger', () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

describe('retry utilities', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('isRetryableError', () => {
        it('should identify network errors as retryable', () => {
            expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
            expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
            expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
            expect(isRetryableError(new Error('socket hang up'))).toBe(true);
            expect(isRetryableError(new Error('network error'))).toBe(true);
            expect(isRetryableError(new Error('getaddrinfo ENOTFOUND'))).toBe(true);
        });

        it('should identify 5xx errors as retryable', () => {
            expect(isRetryableError({ statusCode: 500 })).toBe(true);
            expect(isRetryableError({ statusCode: 502 })).toBe(true);
            expect(isRetryableError({ statusCode: 503 })).toBe(true);
            expect(isRetryableError({ status: 500 })).toBe(true);
            expect(isRetryableError({ response: { statusCode: 500 } })).toBe(true);
        });

        it('should identify rate limit errors as retryable', () => {
            expect(isRetryableError({ statusCode: 429 })).toBe(true);
            expect(isRetryableError({ statusCode: 408 })).toBe(true);
        });

        it('should not retry 4xx client errors (except 408, 429)', () => {
            expect(isRetryableError({ statusCode: 400 })).toBe(false);
            expect(isRetryableError({ statusCode: 401 })).toBe(false);
            expect(isRetryableError({ statusCode: 403 })).toBe(false);
            expect(isRetryableError({ statusCode: 404 })).toBe(false);
        });

        it('should not retry non-network errors', () => {
            expect(isRetryableError(new Error('Invalid input'))).toBe(false);
            expect(isRetryableError(new Error('Authentication failed'))).toBe(false);
        });

        it('should handle null/undefined errors', () => {
            expect(isRetryableError(null)).toBe(false);
            expect(isRetryableError(undefined)).toBe(false);
        });
    });

    describe('withRetry', () => {
        it('should return result on first success', async () => {
            const operation = jest.fn().mockResolvedValue('success');
            
            const result = await withRetry(operation);
            
            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(1);
        });

        it('should retry on transient failures', async () => {
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockRejectedValueOnce(new Error('ETIMEDOUT'))
                .mockResolvedValue('success');
            
            const result = await withRetry(operation, { 
                maxRetries: 3, 
                retryDelay: 10 
            });
            
            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(3);
        });

        it('should throw error after max retries exceeded', async () => {
            const error = new Error('ECONNRESET');
            const operation = jest.fn().mockRejectedValue(error);
            
            await expect(
                withRetry(operation, { maxRetries: 2, retryDelay: 10 })
            ).rejects.toThrow('ECONNRESET');
            
            expect(operation).toHaveBeenCalledTimes(3); // Initial + 2 retries
        });

        it('should not retry non-retryable errors', async () => {
            const error = new Error('Invalid input');
            const operation = jest.fn().mockRejectedValue(error);
            
            await expect(
                withRetry(operation, { maxRetries: 3, retryDelay: 10 })
            ).rejects.toThrow('Invalid input');
            
            expect(operation).toHaveBeenCalledTimes(1); // Only initial attempt
        });

        it('should respect custom shouldRetry function', async () => {
            const operation = jest.fn().mockRejectedValue(new Error('Custom error'));
            const shouldRetry = jest.fn().mockReturnValue(true);
            
            await expect(
                withRetry(operation, { 
                    maxRetries: 2, 
                    retryDelay: 10,
                    shouldRetry 
                })
            ).rejects.toThrow('Custom error');
            
            expect(operation).toHaveBeenCalledTimes(3);
            expect(shouldRetry).toHaveBeenCalledTimes(2);
        });

        it('should use exponential backoff', async () => {
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockResolvedValue('success');
            
            const startTime = Date.now();
            
            await withRetry(operation, { 
                maxRetries: 3, 
                retryDelay: 100,
                backoffMultiplier: 2
            });
            
            const duration = Date.now() - startTime;
            
            // First retry: 100ms, second retry: 200ms = ~300ms total
            expect(duration).toBeGreaterThanOrEqual(250);
            expect(operation).toHaveBeenCalledTimes(3);
        });

        it('should cap delay at maxDelay', async () => {
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockResolvedValue('success');
            
            const startTime = Date.now();
            
            await withRetry(operation, { 
                maxRetries: 3, 
                retryDelay: 1000,
                backoffMultiplier: 10,
                maxDelay: 100 // Cap at 100ms
            });
            
            const duration = Date.now() - startTime;
            
            // Both retries should use maxDelay (100ms each) = ~200ms total
            // Allow extra time for execution overhead in CI environments
            expect(duration).toBeGreaterThanOrEqual(150);
            expect(duration).toBeLessThan(1500); // Much more lenient upper bound
        });

        it('should invoke onRetry callback', async () => {
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockResolvedValue('success');
            
            const onRetry = jest.fn();
            
            await withRetry(operation, { 
                maxRetries: 2, 
                retryDelay: 10,
                onRetry 
            });
            
            expect(onRetry).toHaveBeenCalledTimes(1);
            expect(onRetry).toHaveBeenCalledWith(
                expect.any(Error),
                1,
                10
            );
        });

        it('should handle callback errors gracefully', async () => {
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockResolvedValue('success');
            
            const onRetry = jest.fn().mockImplementation(() => {
                throw new Error('Callback failed');
            });
            
            // Should not throw despite callback error
            const result = await withRetry(operation, { 
                maxRetries: 2, 
                retryDelay: 10,
                onRetry 
            });
            
            expect(result).toBe('success');
        });
    });

    describe('retryable', () => {
        it('should wrap function with retry logic', async () => {
            const fn = jest.fn()
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockResolvedValue('success');
            
            const wrapped = retryable(fn, { maxRetries: 2, retryDelay: 10 });
            
            const result = await wrapped();
            
            expect(result).toBe('success');
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('should pass arguments to wrapped function', async () => {
            const fn = jest.fn().mockResolvedValue('result');
            
            const wrapped = retryable(fn, { maxRetries: 2 });
            
            await wrapped('arg1', 'arg2', 123);
            
            expect(fn).toHaveBeenCalledWith('arg1', 'arg2', 123);
        });

        it('should preserve function signature', async () => {
            const typedFn = async (id: string, count: number): Promise<string> => {
                return `${id}-${count}`;
            };
            
            const wrapped = retryable(typedFn, { maxRetries: 2 });
            
            const result = await wrapped('test', 42);
            
            expect(result).toBe('test-42');
        });
    });
});
