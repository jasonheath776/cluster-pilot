import { logger } from './logger';
import { NETWORK } from './constants';

/**
 * Configuration options for retry logic
 */
export interface RetryOptions {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries?: number;
    /** Delay between retries in milliseconds (default: 1000) */
    retryDelay?: number;
    /** Multiplier for exponential backoff (default: 2) */
    backoffMultiplier?: number;
    /** Maximum delay cap for exponential backoff in milliseconds (default: 10000) */
    maxDelay?: number;
    /** Function to determine if error is retryable (default: retries all errors) */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    /** Callback invoked before each retry attempt */
    onRetry?: (error: unknown, attempt: number, delay: number) => void;
}

/**
 * Default function to determine if an error is retryable
 * Retries network errors, timeouts, and 5xx server errors
 */
export function isRetryableError(error: unknown): boolean {
    if (!error) {
        return false;
    }

    // Handle Error objects
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        
        // Network errors
        if (message.includes('econnreset') ||
            message.includes('econnrefused') ||
            message.includes('etimedout') ||
            message.includes('network') ||
            message.includes('socket hang up') ||
            message.includes('getaddrinfo')) {
            return true;
        }
    }

    // Handle HTTP errors with status codes
    if (typeof error === 'object' && error !== null) {
        const statusCode = (error as any).statusCode || (error as any).status || (error as any).response?.statusCode;
        
        if (statusCode) {
            // Retry on 5xx server errors and 429 (rate limit)
            return statusCode >= 500 || statusCode === 429 || statusCode === 408;
        }
    }

    return false;
}

/**
 * Executes an asynchronous operation with automatic retry logic
 * Uses exponential backoff for retry delays
 * 
 * @param operation - The async function to execute with retries
 * @param options - Configuration options for retry behavior
 * @returns Promise resolving to the operation's result
 * @throws The last error if all retry attempts fail
 * 
 * @example
 * ```typescript
 * const result = await withRetry(
 *   async () => await apiClient.fetchData(),
 *   { maxRetries: 3, retryDelay: 1000 }
 * );
 * ```
 */
export async function withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const {
        maxRetries = NETWORK.MAX_RETRIES,
        retryDelay = NETWORK.RETRY_DELAY,
        backoffMultiplier = 2,
        maxDelay = 10000,
        shouldRetry = isRetryableError,
        onRetry
    } = options;

    let lastError: unknown;
    let currentDelay = retryDelay;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: unknown) {
            lastError = error;

            // Check if we should retry
            const isLastAttempt = attempt === maxRetries;
            if (isLastAttempt || !shouldRetry(error, attempt)) {
                throw error;
            }

            // Log retry attempt
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`Operation failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${currentDelay}ms: ${errorMessage}`);

            // Call retry callback if provided
            if (onRetry) {
                try {
                    onRetry(error, attempt + 1, currentDelay);
                } catch (callbackError) {
                    logger.error('Retry callback failed', callbackError);
                }
            }

            // Wait before retrying with exponential backoff
            await sleep(currentDelay);
            currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelay);
        }
    }

    throw lastError;
}

/**
 * Utility function to sleep for a specified duration
 * @param ms - Duration in milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wraps an async function to automatically retry on failure
 * Returns a new function with retry logic built-in
 * 
 * @param fn - The async function to wrap
 * @param options - Retry configuration options
 * @returns A new function with automatic retry logic
 * 
 * @example
 * ```typescript
 * const fetchWithRetry = retryable(
 *   async (id: string) => await api.fetch(id),
 *   { maxRetries: 3 }
 * );
 * 
 * const data = await fetchWithRetry('123');
 * ```
 */
export function retryable<TArgs extends any[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn>,
    options: RetryOptions = {}
): (...args: TArgs) => Promise<TReturn> {
    return (...args: TArgs): Promise<TReturn> => {
        return withRetry(() => fn(...args), options);
    };
}
