import * as k8s from '@kubernetes/client-node';
import { withRetry } from '../retry';
import { logger } from '../logger';
import { Cache, createCacheKey } from '../cache';
import { CACHE } from '../constants';

/**
 * Client for managing Kubernetes RBAC resources (Roles, RoleBindings, ClusterRoles, ClusterRoleBindings)
 */
export class RBACClient {
    private rbacApi: k8s.RbacAuthorizationV1Api;
    private cache: Cache<any>;

    constructor(private kc: k8s.KubeConfig, cacheTtlMs: number = CACHE.DEFAULT_TTL) {
        this.rbacApi = this.kc.makeApiClient(k8s.RbacAuthorizationV1Api);
        this.cache = new Cache<any>(cacheTtlMs);
        logger.debug('RBACClient initialized with caching');
    }

    /**
     * Clear all cached data
     */
    public clearCache(): void {
        this.cache.clear();
    }

    /**
     * Get cache statistics
     */
    public getCacheStats() {
        return this.cache.getStats();
    }

    /**
     * Refresh API clients with updated kubeconfig
     */
    public refresh(kc: k8s.KubeConfig): void {
        this.kc = kc;
        this.rbacApi = this.kc.makeApiClient(k8s.RbacAuthorizationV1Api);
        this.clearCache();
    }

    // ==================== ROLES ====================

    public async getRoles(namespace?: string): Promise<k8s.V1Role[]> {
        const cacheKey = createCacheKey('roles', namespace || 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return namespace
                        ? await this.rbacApi.listNamespacedRole(namespace)
                        : await this.rbacApi.listRoleForAllNamespaces();
                });
                return response.body.items;
            } catch (error) {
                logger.error('Error fetching roles', error);
                return [];
            }
        });
    }

    public async getRole(name: string, namespace: string): Promise<k8s.V1Role> {
        const cacheKey = createCacheKey('role', namespace, name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.rbacApi.readNamespacedRole(name, namespace);
            });
            return response.body;
        });
    }

    public async deleteRole(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.rbacApi.deleteNamespacedRole(name, namespace);
        });
        // Invalidate related cache entries
        this.cache.delete(`roles:${namespace}:*`);
        this.cache.delete(`role:${namespace}:${name}`);
    }

    // ==================== CLUSTER ROLES ====================

    public async getClusterRoles(): Promise<k8s.V1ClusterRole[]> {
        const cacheKey = createCacheKey('clusterroles', 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return await this.rbacApi.listClusterRole();
                });
                return response.body.items;
            } catch (error) {
                logger.error('Error fetching cluster roles', error);
                return [];
            }
        });
    }

    public async getClusterRole(name: string): Promise<k8s.V1ClusterRole> {
        const cacheKey = createCacheKey('clusterrole', name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.rbacApi.readClusterRole(name);
            });
            return response.body;
        });
    }

    public async deleteClusterRole(name: string): Promise<void> {
        await withRetry(async () => {
            await this.rbacApi.deleteClusterRole(name);
        });
        // Invalidate related cache entries
        this.cache.delete('clusterroles:*');
        this.cache.delete(`clusterrole:${name}`);
    }

    // ==================== ROLE BINDINGS ====================

    public async getRoleBindings(namespace?: string): Promise<k8s.V1RoleBinding[]> {
        const cacheKey = createCacheKey('rolebindings', namespace || 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return namespace
                        ? await this.rbacApi.listNamespacedRoleBinding(namespace)
                        : await this.rbacApi.listRoleBindingForAllNamespaces();
                });
                return response.body.items;
            } catch (error) {
                logger.error('Error fetching role bindings', error);
                return [];
            }
        });
    }

    public async getRoleBinding(name: string, namespace: string): Promise<k8s.V1RoleBinding> {
        const cacheKey = createCacheKey('rolebinding', namespace, name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.rbacApi.readNamespacedRoleBinding(name, namespace);
            });
            return response.body;
        });
    }

    public async deleteRoleBinding(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.rbacApi.deleteNamespacedRoleBinding(name, namespace);
        });
        // Invalidate related cache entries
        this.cache.delete(`rolebindings:${namespace}:*`);
        this.cache.delete(`rolebinding:${namespace}:${name}`);
    }

    // ==================== CLUSTER ROLE BINDINGS ====================

    public async getClusterRoleBindings(): Promise<k8s.V1ClusterRoleBinding[]> {
        const cacheKey = createCacheKey('clusterrolebindings', 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return await this.rbacApi.listClusterRoleBinding();
                });
                return response.body.items;
            } catch (error) {
                logger.error('Error fetching cluster role bindings', error);
                return [];
            }
        });
    }

    public async getClusterRoleBinding(name: string): Promise<k8s.V1ClusterRoleBinding> {
        const cacheKey = createCacheKey('clusterrolebinding', name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.rbacApi.readClusterRoleBinding(name);
            });
            return response.body;
        });
    }

    public async deleteClusterRoleBinding(name: string): Promise<void> {
        await withRetry(async () => {
            await this.rbacApi.deleteClusterRoleBinding(name);
        });
        // Invalidate related cache entries
        this.cache.delete('clusterrolebindings:*');
        this.cache.delete(`clusterrolebinding:${name}`);
    }
}
