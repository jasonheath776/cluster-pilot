/**
 * Input validation utilities to prevent command injection and other security issues
 */
import { PATTERNS, NAME_LIMITS, PORTS } from './constants';

/**
 * Validates and sanitizes a resource name (pod, deployment, etc.)
 * Kubernetes resource names must:
 * - contain only lowercase alphanumeric characters, '-' or '.'
 * - start and end with an alphanumeric character
 */
export function validateResourceName(name: string): string {
    if (!name || typeof name !== 'string') {
        throw new Error('Resource name must be a non-empty string');
    }

    const trimmed = name.trim();
    
    if (trimmed.length === 0) {
        throw new Error('Resource name cannot be empty');
    }

    if (trimmed.length > NAME_LIMITS.MAX_RESOURCE_NAME) {
        throw new Error(`Resource name cannot exceed ${NAME_LIMITS.MAX_RESOURCE_NAME} characters`);
    }

    // Check for valid Kubernetes name pattern
    if (!PATTERNS.RESOURCE_NAME.test(trimmed)) {
        throw new Error('Resource name contains invalid characters. Must contain only lowercase alphanumeric characters, "-" or "."');
    }

    // Check for command injection attempts
    if (PATTERNS.DANGEROUS_CHARS.test(trimmed)) {
        throw new Error('Resource name contains potentially dangerous characters');
    }

    return trimmed;
}

/**
 * Validates a namespace name
 */
export function validateNamespace(namespace: string): string {
    if (!namespace || typeof namespace !== 'string') {
        throw new Error('Namespace must be a non-empty string');
    }

    const trimmed = namespace.trim();
    
    if (trimmed.length === 0) {
        throw new Error('Namespace cannot be empty');
    }

    if (trimmed.length > NAME_LIMITS.MAX_NAMESPACE_NAME) {
        throw new Error(`Namespace cannot exceed ${NAME_LIMITS.MAX_NAMESPACE_NAME} characters`);
    }

    // Check for valid DNS label pattern
    if (!PATTERNS.DNS_LABEL.test(trimmed)) {
        throw new Error('Namespace contains invalid characters. Must be a valid DNS label');
    }

    return trimmed;
}

/**
 * Validates a container name
 */
export function validateContainerName(name: string): string {
    return validateResourceName(name);
}

/**
 * Validates a port number
 */
export function validatePort(port: number | string): number {
    const portNum = typeof port === 'string' ? parseInt(port, 10) : port;
    
    if (isNaN(portNum)) {
        throw new Error('Port must be a valid number');
    }

    if (portNum < PORTS.MIN || portNum > PORTS.MAX) {
        throw new Error(`Port must be between ${PORTS.MIN} and ${PORTS.MAX}`);
    }

    return portNum;
}

/**
 * Validates a file path to prevent directory traversal
 */
export function validateFilePath(filePath: string): string {
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('File path must be a non-empty string');
    }

    const trimmed = filePath.trim();
    
    // Check for directory traversal attempts
    if (trimmed.includes('..') || trimmed.includes('~')) {
        throw new Error('File path contains potentially dangerous patterns');
    }

    // Check for null bytes
    if (trimmed.includes('\0')) {
        throw new Error('File path contains null bytes');
    }

    return trimmed;
}

/**
 * Validates a URL
 */
export function validateURL(url: string): string {
    if (!url || typeof url !== 'string') {
        throw new Error('URL must be a non-empty string');
    }

    const trimmed = url.trim();
    
    try {
        const parsed = new URL(trimmed);
        // Only allow http and https protocols
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('URL must use http or https protocol');
        }
        return trimmed;
    } catch {
        throw new Error('Invalid URL format');
    }
}

/**
 * Sanitizes a string for use in shell commands by escaping special characters
 * Note: Prefer using parameterized APIs over shell commands when possible
 */
export function escapeShellArg(arg: string): string {
    if (!arg || typeof arg !== 'string') {
        return '""';
    }

    // On Windows, use double quotes and escape internal quotes
    if (process.platform === 'win32') {
        return '"' + arg.replace(/"/g, '""') + '"';
    }

    // On Unix-like systems, use single quotes and escape internal single quotes
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Validates a label or annotation key
 */
export function validateLabelKey(key: string): string {
    if (!key || typeof key !== 'string') {
        throw new Error('Label key must be a non-empty string');
    }

    const trimmed = key.trim();
    
    if (trimmed.length > 253) {
        throw new Error('Label key cannot exceed 253 characters');
    }

    // Basic validation - should contain valid characters
    const validPattern = /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*)?(\/[a-z0-9]([-a-z0-9]*[a-z0-9])?)?$/;
    if (!validPattern.test(trimmed)) {
        throw new Error('Label key contains invalid characters');
    }

    return trimmed;
}

/**
 * Validates that a string contains only safe characters (alphanumeric, spaces, and basic punctuation)
 */
export function validateSafeString(value: string, fieldName: string = 'value'): string {
    if (!value || typeof value !== 'string') {
        throw new Error(`${fieldName} must be a non-empty string`);
    }

    const trimmed = value.trim();
    
    // Allow alphanumeric, spaces, and common safe punctuation
    if (!PATTERNS.SAFE_STRING.test(trimmed)) {
        throw new Error(`${fieldName} contains potentially unsafe characters`);
    }

    return trimmed;
}
