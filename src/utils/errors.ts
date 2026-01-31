/**
 * Error handling utilities for consistent error message extraction and handling
 */

/**
 * Extract a human-readable error message from any error object
 * Handles Error objects, strings, objects with message property, and unknown types
 * 
 * @param error - The error object (can be any type)
 * @returns A string representation of the error message
 * 
 * @example
 * ```typescript
 * try {
 *   await someOperation();
 * } catch (error) {
 *   const message = getErrorMessage(error);
 *   logger.error('Operation failed:', message);
 * }
 * ```
 */
export function getErrorMessage(error: unknown): string {
    // Handle Error objects (most common)
    if (error instanceof Error) {
        return error.message;
    }

    // Handle string errors
    if (typeof error === 'string') {
        return error;
    }

    // Handle objects with a message property
    if (error && typeof error === 'object' && 'message' in error) {
        const message = (error as any).message;
        if (typeof message === 'string') {
            return message;
        }
    }

    // Handle status/statusCode property (HTTP errors)
    if (error && typeof error === 'object' && ('statusCode' in error || 'status' in error)) {
        const code = (error as any).statusCode || (error as any).status;
        const body = (error as any).body?.message || (error as any).message || '';
        if (body) {
            return `HTTP ${code}: ${body}`;
        }
        return `HTTP Error ${code}`;
    }

    // Fallback: convert to string
    return String(error);
}

/**
 * Extract detailed error information including stack trace
 * Useful for logging and debugging
 * 
 * @param error - The error object
 * @returns Object containing message and stack trace
 * 
 * @example
 * ```typescript
 * catch (error) {
 *   const details = getErrorDetails(error);
 *   logger.error(`Operation failed: ${details.message}`, details);
 * }
 * ```
 */
export function getErrorDetails(error: unknown): { message: string; stack?: string } {
    const message = getErrorMessage(error);
    const stack = error instanceof Error ? error.stack : undefined;
    return { message, stack };
}

/**
 * Check if an error is retryable (network/timeout errors)
 * 
 * @param error - The error to check
 * @returns true if the error should be retried
 */
export function isRetryableError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase();

    // Network errors
    if (
        message.includes('econnreset') ||
        message.includes('econnrefused') ||
        message.includes('etimedout') ||
        message.includes('network') ||
        message.includes('socket hang up') ||
        message.includes('getaddrinfo')
    ) {
        return true;
    }

    // HTTP status codes
    if (error && typeof error === 'object') {
        const statusCode = (error as any).statusCode || (error as any).status || (error as any).response?.statusCode;
        if (statusCode) {
            // Retry on 5xx server errors, 429 (rate limit), 408 (timeout)
            return statusCode >= 500 || statusCode === 429 || statusCode === 408;
        }
    }

    return false;
}

/**
 * Type-safe error handler for async operations
 * Returns result or error in a tuple: [error, null] | [null, result]
 * 
 * @param promise - The promise to handle
 * @returns Tuple with either error or result
 * 
 * @example
 * ```typescript
 * const [error, data] = await handle(fetchData());
 * if (error) {
 *   logger.error('Failed:', error.message);
 * } else {
 *   console.log('Success:', data);
 * }
 * ```
 */
export async function handle<T>(
    promise: Promise<T>
): Promise<[Error, null] | [null, T]> {
    try {
        const result = await promise;
        return [null, result];
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(getErrorMessage(error));
        return [err, null];
    }
}
