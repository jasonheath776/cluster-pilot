import { logger } from './logger';

/**
 * Cache entry with value and expiration time
 */
interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
    hits: number;
    misses: number;
    size: number;
    hitRate: number;
}

/**
 * Generic cache with TTL (Time To Live) support
 * Thread-safe and memory-efficient with automatic cleanup
 */
export class Cache<T> {
    private cache = new Map<string, CacheEntry<T>>();
    private cleanupInterval: NodeJS.Timeout | null = null;
    private stats = {
        hits: 0,
        misses: 0
    };

    /**
     * @param ttlMs Time to live in milliseconds (default: 30 seconds)
     * @param maxSize Maximum cache size (default: 1000 entries)
     * @param cleanupIntervalMs Cleanup interval in milliseconds (default: 60 seconds)
     */
    constructor(
        private ttlMs: number = 30000,
        private maxSize: number = 1000,
        cleanupIntervalMs: number = 60000
    ) {
        // Start automatic cleanup
        this.startCleanup(cleanupIntervalMs);
        logger.debug(`Cache initialized with TTL: ${ttlMs}ms, maxSize: ${maxSize}`);
    }

    /**
     * Get value from cache
     * @param key Cache key
     * @returns Cached value or undefined if not found or expired
     */
    public get(key: string): T | undefined {
        const entry = this.cache.get(key);
        
        if (!entry) {
            this.stats.misses++;
            return undefined;
        }

        // Check if expired
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            this.stats.misses++;
            return undefined;
        }

        this.stats.hits++;
        return entry.value;
    }

    /**
     * Set value in cache
     * @param key Cache key
     * @param value Value to cache
     * @param customTtlMs Optional custom TTL for this entry
     */
    public set(key: string, value: T, customTtlMs?: number): void {
        // Enforce max size by removing oldest entries
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) {
                this.cache.delete(firstKey);
            }
        }

        const ttl = customTtlMs ?? this.ttlMs;
        const expiresAt = Date.now() + ttl;

        this.cache.set(key, { value, expiresAt });
    }

    /**
     * Check if key exists and is not expired
     */
    public has(key: string): boolean {
        const entry = this.cache.get(key);
        if (!entry) {
            return false;
        }

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return false;
        }

        return true;
    }

    /**
     * Delete specific key from cache
     */
    public delete(key: string): boolean {
        return this.cache.delete(key);
    }

    /**
     * Clear all cache entries
     */
    public clear(): void {
        this.cache.clear();
        this.stats.hits = 0;
        this.stats.misses = 0;
        logger.debug('Cache cleared');
    }

    /**
     * Invalidate cache entries matching a pattern
     * @param pattern String to match in keys (supports wildcards with *)
     */
    public invalidatePattern(pattern: string): number {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        let count = 0;

        for (const key of this.cache.keys()) {
            if (regex.test(key)) {
                this.cache.delete(key);
                count++;
            }
        }

        if (count > 0) {
            logger.debug(`Invalidated ${count} cache entries matching pattern: ${pattern}`);
        }

        return count;
    }

    /**
     * Get cache statistics
     */
    public getStats(): CacheStats {
        const total = this.stats.hits + this.stats.misses;
        const hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;

        return {
            hits: this.stats.hits,
            misses: this.stats.misses,
            size: this.cache.size,
            hitRate: parseFloat(hitRate.toFixed(2))
        };
    }

    /**
     * Reset statistics
     */
    public resetStats(): void {
        this.stats.hits = 0;
        this.stats.misses = 0;
    }

    /**
     * Get or compute value if not in cache
     * @param key Cache key
     * @param factory Function to compute value if not cached
     * @param customTtlMs Optional custom TTL
     */
    public async getOrCompute(
        key: string,
        factory: () => Promise<T>,
        customTtlMs?: number
    ): Promise<T> {
        const cached = this.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const value = await factory();
        this.set(key, value, customTtlMs);
        return value;
    }

    /**
     * Start automatic cleanup of expired entries
     */
    private startCleanup(intervalMs: number): void {
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, intervalMs);
    }

    /**
     * Remove expired entries
     */
    private cleanup(): void {
        const now = Date.now();
        let removed = 0;

        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
                removed++;
            }
        }

        if (removed > 0) {
            logger.debug(`Cache cleanup: removed ${removed} expired entries`);
        }
    }

    /**
     * Stop automatic cleanup and clear cache
     */
    public dispose(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.clear();
        logger.debug('Cache disposed');
    }
}

/**
 * Create a cache key from namespace and optional resource name
 */
export function createCacheKey(resource: string, namespace?: string, name?: string): string {
    const parts = [resource];
    if (namespace) {
        parts.push(namespace);
    }
    if (name) {
        parts.push(name);
    }
    return parts.join(':');
}
