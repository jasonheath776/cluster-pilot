import {
    assertExists,
    getNestedProperty,
    hasRequiredField,
    getResourceNamespace,
    getResourceName,
    isK8sResource
} from '../utils/nullChecks';

describe('null checks utilities', () => {
    describe('assertExists', () => {
        it('should return value when it exists', () => {
            expect(assertExists('value', 'should exist')).toBe('value');
            expect(assertExists(0, 'number')).toBe(0);
            expect(assertExists(false, 'boolean')).toBe(false);
        });

        it('should throw on null', () => {
            expect(() => assertExists(null, 'must not be null')).toThrow('must not be null');
        });

        it('should throw on undefined', () => {
            expect(() => assertExists(undefined, 'must not be undefined')).toThrow('must not be undefined');
        });

        it('should preserve type through assertion', () => {
            const obj = { name: 'test' };
            const result = assertExists(obj, 'object must exist');
            expect(result.name).toBe('test');
        });
    });

    describe('getNestedProperty', () => {
        const obj = {
            metadata: {
                name: 'pod-1',
                namespace: 'default',
                labels: {
                    app: 'frontend'
                }
            },
            spec: {
                containers: [
                    { name: 'main', image: 'nginx:1.0' }
                ]
            }
        };

        it('should get top-level properties', () => {
            expect(getNestedProperty(obj, 'metadata')).toEqual(obj.metadata);
            expect(getNestedProperty(obj, 'spec')).toEqual(obj.spec);
        });

        it('should get nested properties with dot notation', () => {
            expect(getNestedProperty(obj, 'metadata.name')).toBe('pod-1');
            expect(getNestedProperty(obj, 'metadata.namespace')).toBe('default');
            expect(getNestedProperty(obj, 'metadata.labels.app')).toBe('frontend');
        });

        it('should return undefined for non-existent paths', () => {
            expect(getNestedProperty(obj, 'nonexistent')).toBeUndefined();
            expect(getNestedProperty(obj, 'metadata.nonexistent')).toBeUndefined();
            expect(getNestedProperty(obj, 'metadata.labels.nonexistent')).toBeUndefined();
        });

        it('should handle null/undefined safely', () => {
            expect(getNestedProperty(null, 'any.path')).toBeUndefined();
            expect(getNestedProperty(undefined, 'any.path')).toBeUndefined();
            expect(getNestedProperty(obj, null as any)).toBeUndefined();
        });

        it('should handle array indices', () => {
            const arrayObj = { items: ['a', 'b', 'c'] };
            expect(getNestedProperty(arrayObj, 'items.0')).toBe('a');
            expect(getNestedProperty(arrayObj, 'items.2')).toBe('c');
        });
    });

    describe('hasRequiredField', () => {
        const resource = {
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
                name: 'test-pod',
                namespace: 'default'
            }
        };

        it('should return true for existing fields', () => {
            expect(hasRequiredField(resource, 'apiVersion')).toBe(true);
            expect(hasRequiredField(resource, 'metadata.name')).toBe(true);
            expect(hasRequiredField(resource, 'metadata.namespace')).toBe(true);
        });

        it('should return false for missing fields', () => {
            expect(hasRequiredField(resource, 'nonexistent')).toBe(false);
            expect(hasRequiredField(resource, 'metadata.owner')).toBe(false);
            expect(hasRequiredField(resource, 'spec.containers')).toBe(false);
        });

        it('should handle null/undefined resources', () => {
            expect(hasRequiredField(null, 'any')).toBe(false);
            expect(hasRequiredField(undefined, 'any')).toBe(false);
        });

        it('should handle empty path', () => {
            expect(hasRequiredField(resource, '')).toBe(false);
        });
    });

    describe('getResourceNamespace', () => {
        it('should get namespace from metadata', () => {
            const resource = {
                metadata: {
                    namespace: 'kube-system'
                }
            };
            expect(getResourceNamespace(resource)).toBe('kube-system');
        });

        it('should return default namespace when not specified', () => {
            const resource = {
                metadata: {
                    name: 'test'
                }
            };
            expect(getResourceNamespace(resource)).toBe('default');
        });

        it('should return provided default when resource lacks namespace', () => {
            const resource = { metadata: { name: 'test' } };
            expect(getResourceNamespace(resource, 'custom-default')).toBe('custom-default');
        });

        it('should handle null/undefined resource', () => {
            expect(getResourceNamespace(null)).toBe('default');
            expect(getResourceNamespace(undefined)).toBe('default');
            expect(getResourceNamespace(null, 'custom')).toBe('custom');
        });

        it('should handle missing metadata', () => {
            const resource = { spec: {} };
            expect(getResourceNamespace(resource)).toBe('default');
        });
    });

    describe('getResourceName', () => {
        it('should get name from metadata', () => {
            const resource = {
                metadata: {
                    name: 'my-deployment'
                }
            };
            expect(getResourceName(resource)).toBe('my-deployment');
        });

        it('should return empty string when name not found', () => {
            const resource = {
                metadata: {
                    namespace: 'default'
                }
            };
            expect(getResourceName(resource)).toBe('');
        });

        it('should handle null/undefined resource', () => {
            expect(getResourceName(null)).toBe('');
            expect(getResourceName(undefined)).toBe('');
        });

        it('should handle missing metadata', () => {
            expect(getResourceName({ spec: {} })).toBe('');
        });

        it('should handle metadata without name', () => {
            expect(getResourceName({ metadata: {} })).toBe('');
        });
    });

    describe('isK8sResource', () => {
        it('should identify valid K8s resources', () => {
            const validResource = {
                apiVersion: 'v1',
                kind: 'Pod',
                metadata: {
                    name: 'test'
                }
            };
            expect(isK8sResource(validResource)).toBe(true);
        });

        it('should require apiVersion', () => {
            const noApiVersion = {
                kind: 'Pod',
                metadata: { name: 'test' }
            };
            expect(isK8sResource(noApiVersion)).toBe(false);
        });

        it('should require kind', () => {
            const noKind = {
                apiVersion: 'v1',
                metadata: { name: 'test' }
            };
            expect(isK8sResource(noKind)).toBe(false);
        });

        it('should require metadata', () => {
            const noMetadata = {
                apiVersion: 'v1',
                kind: 'Pod'
            };
            expect(isK8sResource(noMetadata)).toBeFalsy();
        });

        it('should reject non-objects', () => {
            expect(isK8sResource(null)).toBeFalsy();
            expect(isK8sResource(undefined)).toBeFalsy();
            expect(isK8sResource('string')).toBeFalsy();
            expect(isK8sResource(123)).toBeFalsy();
            expect(isK8sResource([])).toBeFalsy();
        });

        it('should accept custom resource definitions', () => {
            const customResource = {
                apiVersion: 'example.com/v1',
                kind: 'CustomResource',
                metadata: {
                    name: 'my-custom'
                }
            };
            expect(isK8sResource(customResource)).toBe(true);
        });
    });
});
