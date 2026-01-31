/**
 * Debounce function - delays execution until after wait time has elapsed since last call
 * @param func Function to debounce
 * @param waitMs Wait time in milliseconds
 * @returns Debounced function
 */
export function debounce<T extends (...args: any[]) => any>(
    func: T,
    waitMs: number
): (...args: Parameters<T>) => void {
    let timeoutId: NodeJS.Timeout | null = null;

    return function (this: any, ...args: Parameters<T>) {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }

        timeoutId = setTimeout(() => {
            func.apply(this, args);
            timeoutId = null;
        }, waitMs);
    };
}

/**
 * Throttle function - ensures function is called at most once per wait period
 * @param func Function to throttle
 * @param waitMs Wait time in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (...args: any[]) => any>(
    func: T,
    waitMs: number
): (...args: Parameters<T>) => void {
    let lastCall = 0;
    let timeoutId: NodeJS.Timeout | null = null;

    return function (this: any, ...args: Parameters<T>) {
        const now = Date.now();
        const timeSinceLastCall = now - lastCall;

        if (timeSinceLastCall >= waitMs) {
            // Execute immediately
            lastCall = now;
            func.apply(this, args);
        } else {
            // Schedule for later
            if (timeoutId) {
                clearTimeout(timeoutId);
            }

            timeoutId = setTimeout(() => {
                lastCall = Date.now();
                func.apply(this, args);
                timeoutId = null;
            }, waitMs - timeSinceLastCall);
        }
    };
}

/**
 * Debounce async function with promise tracking
 * @param func Async function to debounce
 * @param waitMs Wait time in milliseconds
 * @returns Debounced async function
 */
export function debounceAsync<T extends (...args: any[]) => Promise<any>>(
    func: T,
    waitMs: number
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
    let timeoutId: NodeJS.Timeout | null = null;
    let pendingPromise: Promise<ReturnType<T>> | null = null;

    return function (this: any, ...args: Parameters<T>): Promise<ReturnType<T>> {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }

        if (!pendingPromise) {
            pendingPromise = new Promise((resolve, reject) => {
                timeoutId = setTimeout(async () => {
                    try {
                        const result = await func.apply(this, args);
                        resolve(result);
                    } catch (error) {
                        reject(error);
                    } finally {
                        timeoutId = null;
                        pendingPromise = null;
                    }
                }, waitMs);
            });
        }

        return pendingPromise;
    };
}

/**
 * Create a debounced version of a function that can be cancelled
 */
export interface DebouncedFunction<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): void;
    cancel(): void;
    flush(): void;
}

export function debounceCancellable<T extends (...args: any[]) => any>(
    func: T,
    waitMs: number
): DebouncedFunction<T> {
    let timeoutId: NodeJS.Timeout | null = null;
    let lastArgs: Parameters<T> | null = null;
    let lastThis: any = null;

    const debounced = function (this: any, ...args: Parameters<T>) {
        lastArgs = args;
        lastThis = this;

        if (timeoutId) {
            clearTimeout(timeoutId);
        }

        timeoutId = setTimeout(() => {
            if (lastArgs) {
                func.apply(lastThis, lastArgs);
            }
            timeoutId = null;
            lastArgs = null;
            lastThis = null;
        }, waitMs);
    };

    debounced.cancel = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        lastArgs = null;
        lastThis = null;
    };

    debounced.flush = () => {
        if (timeoutId && lastArgs) {
            clearTimeout(timeoutId);
            func.apply(lastThis, lastArgs);
            timeoutId = null;
            lastArgs = null;
            lastThis = null;
        }
    };

    return debounced as DebouncedFunction<T>;
}
