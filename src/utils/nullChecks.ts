/**
 * Utility functions for defensive null/undefined checking
 * Used throughout the application for robust error handling
 */

/**
 * Assert that a value is not null or undefined
 * Throws an error with a meaningful message if the check fails
 * 
 * @param value - The value to check
 * @param message - Custom error message (optional)
 * @returns The value if it passes the check
 * @throws Error if value is null or undefined
 * 
 * @example
 * ```typescript
 * const context = assertExists(kc.getCurrentContext(), 'No current context');
 * console.log(context.name); // TypeScript knows context is not null
 * ```
 */
export function assertExists<T>(value: T | null | undefined, message: string = 'Value is null or undefined'): T {
    if (value === null || value === undefined) {
        throw new Error(message);
    }
    return value;
}

/**
 * Optional chaining helper for safe nested property access
 * Returns undefined if any intermediate property is null/undefined
 * 
 * @param obj - The object to access
 * @param path - Dot-separated path (e.g., 'metadata.namespace')
 * @returns The value at the path or undefined
 * 
 * @example
 * ```typescript
 * const namespace = getNestedProperty(resource, 'metadata.namespace');
 * ```
 */
export function getNestedProperty(obj: any, path: string | null | undefined): any {
    if (!path || typeof path !== 'string') {
        return undefined;
    }
    return path.split('.').reduce((current, prop) => {
        if (current === null || current === undefined) {
            return undefined;
        }
        return current[prop];
    }, obj);
}

/**
 * Check if a Kubernetes resource has a required field
 * 
 * @param resource - The K8s resource object
 * @param path - Path to the field (e.g., 'metadata.name')
 * @returns true if field exists and is not empty
 * 
 * @example
 * ```typescript
 * if (!hasRequiredField(pod, 'metadata.name')) {
 *   throw new Error('Pod requires metadata.name');
 * }
 * ```
 */
export function hasRequiredField(resource: any, path: string): boolean {
    const value = getNestedProperty(resource, path);
    return value !== null && value !== undefined && value !== '';
}

/**
 * Safely get namespace from a resource, with fallback
 * 
 * @param resource - The K8s resource
 * @param defaultNamespace - Default namespace if not found (default: 'default')
 * @returns The namespace name
 */
export function getResourceNamespace(resource: any, defaultNamespace: string = 'default'): string {
    const namespace = getNestedProperty(resource, 'metadata.namespace');
    return namespace || defaultNamespace;
}

/**
 * Safely get resource name
 * 
 * @param resource - The K8s resource
 * @returns The resource name or empty string
 */
export function getResourceName(resource: any): string {
    return getNestedProperty(resource, 'metadata.name') || '';
}

/**
 * Type guard to check if object is a valid K8s resource
 * 
 * @param obj - Object to check
 * @returns true if object looks like a K8s resource
 */
export function isK8sResource(obj: any): boolean {
    return (
        obj &&
        typeof obj === 'object' &&
        typeof obj.apiVersion === 'string' &&
        typeof obj.kind === 'string' &&
        obj.metadata &&
        typeof obj.metadata.name === 'string'
    );
}
