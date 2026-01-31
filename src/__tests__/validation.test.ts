import {
    validateResourceName,
    validateNamespace,
    validatePort,
    validateLabelKey,
    validateContainerName,
    escapeShellArg
} from '../utils/validation';

describe('validation utilities', () => {
    describe('validateResourceName', () => {
        it('should accept valid resource names', () => {
            expect(validateResourceName('my-app')).toBe('my-app');
            expect(validateResourceName('app123')).toBe('app123');
            expect(validateResourceName('my-app-v2')).toBe('my-app-v2');
        });

        it('should reject names with invalid characters', () => {
            expect(() => validateResourceName('my_app')).toThrow('contains invalid characters');
            expect(() => validateResourceName('My-App')).toThrow('contains invalid characters');
            expect(() => validateResourceName('app@123')).toThrow('contains invalid characters');
            expect(() => validateResourceName('app#name')).toThrow('contains invalid characters');
        });

        it('should reject names that are too long', () => {
            const longName = 'a'.repeat(254);
            expect(() => validateResourceName(longName)).toThrow('cannot exceed');
        });

        it('should reject names starting with hyphen', () => {
            expect(() => validateResourceName('-myapp')).toThrow('contains invalid characters');
        });

        it('should reject empty names', () => {
            expect(() => validateResourceName('')).toThrow('must be a non-empty string');
        });
    });

    describe('validateNamespace', () => {
        it('should accept valid namespace names', () => {
            expect(validateNamespace('default')).toBe('default');
            expect(validateNamespace('kube-system')).toBe('kube-system');
            expect(validateNamespace('my-namespace')).toBe('my-namespace');
        });

        it('should reject invalid namespace names', () => {
            expect(() => validateNamespace('_invalid')).toThrow('contains invalid characters');
            expect(() => validateNamespace('Invalid')).toThrow('contains invalid characters');
            expect(() => validateNamespace('kube_system')).toThrow('contains invalid characters');
        });

        it('should reject reserved namespaces with invalid patterns', () => {
            expect(() => validateNamespace('-invalid')).toThrow('contains invalid characters');
        });
    });

    describe('validatePort', () => {
        it('should accept valid port numbers', () => {
            expect(validatePort(80)).toBe(80);
            expect(validatePort(443)).toBe(443);
            expect(validatePort(8080)).toBe(8080);
            expect(validatePort(65535)).toBe(65535);
        });

        it('should reject ports outside valid range', () => {
            expect(() => validatePort(0)).toThrow('must be between');
            expect(() => validatePort(-1)).toThrow('must be between');
            expect(() => validatePort(65536)).toThrow('must be between');
            expect(() => validatePort(100000)).toThrow('must be between');
        });

        it('should handle NaN', () => {
            expect(() => validatePort(NaN)).toThrow('must be a valid number');
        });
    });

    describe('validateLabelKey', () => {
        it('should accept valid label keys', () => {
            expect(validateLabelKey('app')).toBe('app');
            expect(validateLabelKey('app.kubernetes.io/name')).toBe('app.kubernetes.io/name');
            expect(validateLabelKey('example.com/my-label')).toBe('example.com/my-label');
        });

        it('should reject invalid label keys', () => {
            expect(() => validateLabelKey('_invalid')).toThrow('contains invalid characters');
            expect(() => validateLabelKey('key_with_underscore')).toThrow('contains invalid characters');
            expect(() => validateLabelKey('Key')).toThrow('contains invalid characters');
        });

        it('should reject keys that are too long', () => {
            const longKey = 'a'.repeat(254);
            expect(() => validateLabelKey(longKey)).toThrow('cannot exceed');
        });
    });

    describe('validateContainerName', () => {
        it('should accept valid container names', () => {
            expect(validateContainerName('nginx')).toBe('nginx');
            expect(validateContainerName('my-app')).toBe('my-app');
            expect(validateContainerName('app123')).toBe('app123');
        });

        it('should reject invalid container names', () => {
            expect(() => validateContainerName('')).toThrow();
            expect(() => validateContainerName('My-App')).toThrow();
            expect(() => validateContainerName('app_name')).toThrow();
        });
    });

    describe('escapeShellArg', () => {
        it('should escape shell metacharacters on Windows', () => {
            // Windows uses double quotes
            const result = escapeShellArg('hello');
            expect(result).toMatch(/^["']hello["']$/);
        });

        it('should handle special characters', () => {
            const result = escapeShellArg('$PATH');
            expect(result.includes('$PATH')).toBe(true);
        });

        it('should handle empty strings', () => {
            const result = escapeShellArg('');
            expect(result.length).toBeGreaterThan(0);
        });
    });
});
