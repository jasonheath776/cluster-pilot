import * as k8s from '@kubernetes/client-node';
import { withRetry } from '../retry';
import { logger } from '../logger';
import { Cache, createCacheKey } from '../cache';
import { CACHE } from '../constants';

/**
 * Client for managing Kubernetes configuration resources (ConfigMaps, Secrets, Namespaces)
 */
export class ConfigClient {
    private coreApi: k8s.CoreV1Api;
    private cache: Cache<any>;

    constructor(private kc: k8s.KubeConfig, cacheTtlMs: number = CACHE.DEFAULT_TTL) {
        this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        this.cache = new Cache<any>(cacheTtlMs);
        logger.debug('ConfigClient initialized with caching');
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
        this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        this.clearCache();
    }

    // ==================== CONFIGMAPS ====================

    public async getConfigMaps(namespace?: string): Promise<k8s.V1ConfigMap[]> {
        const cacheKey = createCacheKey('configmaps', namespace || 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return namespace
                        ? await this.coreApi.listNamespacedConfigMap(namespace)
                        : await this.coreApi.listConfigMapForAllNamespaces();
                });
                return response.body.items;
            } catch (error) {
                logger.error('Error fetching configmaps', error);
                return [];
            }
        });
    }

    public async getConfigMap(name: string, namespace: string): Promise<k8s.V1ConfigMap> {
        const cacheKey = createCacheKey('configmap', namespace, name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.coreApi.readNamespacedConfigMap(name, namespace);
            });
            return response.body;
        });
    }

    public async deleteConfigMap(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deleteNamespacedConfigMap(name, namespace);
        });
        // Invalidate related cache entries
        this.cache.delete(`configmaps:${namespace}:*`);
        this.cache.delete(`configmap:${namespace}:${name}`);
    }

    public async createConfigMap(namespace: string, configMap: k8s.V1ConfigMap): Promise<k8s.V1ConfigMap> {
        const response = await withRetry(async () => {
            return await this.coreApi.createNamespacedConfigMap(namespace, configMap);
        });
        return response.body;
    }

    public async updateConfigMap(name: string, namespace: string, configMap: k8s.V1ConfigMap): Promise<k8s.V1ConfigMap> {
        const response = await withRetry(async () => {
            return await this.coreApi.replaceNamespacedConfigMap(name, namespace, configMap);
        });
        return response.body;
    }

    // ==================== SECRETS ====================

    public async getSecrets(namespace?: string): Promise<k8s.V1Secret[]> {
        const cacheKey = createCacheKey('secrets', namespace || 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return namespace
                        ? await this.coreApi.listNamespacedSecret(namespace)
                        : await this.coreApi.listSecretForAllNamespaces();
                });
                return response.body.items;
            } catch (error) {
                logger.error('Error fetching secrets', error);
                return [];
            }
        });
    }

    public async getSecret(name: string, namespace: string): Promise<k8s.V1Secret> {
        const cacheKey = createCacheKey('secret', namespace, name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.coreApi.readNamespacedSecret(name, namespace);
            });
            return response.body;
        });
    }

    public async deleteSecret(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deleteNamespacedSecret(name, namespace);
        });
        // Invalidate related cache entries
        this.cache.delete(`secrets:${namespace}:*`);
        this.cache.delete(`secret:${namespace}:${name}`);
    }

    public async createSecret(namespace: string, secret: k8s.V1Secret): Promise<k8s.V1Secret> {
        const response = await withRetry(async () => {
            return await this.coreApi.createNamespacedSecret(namespace, secret);
        });
        return response.body;
    }

    public async updateSecret(name: string, namespace: string, secret: k8s.V1Secret): Promise<k8s.V1Secret> {
        const response = await withRetry(async () => {
            return await this.coreApi.replaceNamespacedSecret(name, namespace, secret);
        });
        return response.body;
    }

    // ==================== NAMESPACES ====================

    public async getNamespaces(): Promise<k8s.V1Namespace[]> {
        const cacheKey = createCacheKey('namespaces', 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return await this.coreApi.listNamespace();
                });
                return response.body.items;
            } catch (error) {
                logger.error('Error fetching namespaces', error);
                return [];
            }
        });
    }

    public async getNamespace(name: string): Promise<k8s.V1Namespace> {
        const cacheKey = createCacheKey('namespace', name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.coreApi.readNamespace(name);
            });
            return response.body;
        });
    }

    public async deleteNamespace(name: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deleteNamespace(name);
        });
        // Invalidate related cache entries
        this.cache.delete('namespaces:*');
        this.cache.delete(`namespace:${name}`);
    }

    public async createNamespace(namespace: k8s.V1Namespace): Promise<k8s.V1Namespace> {
        const response = await withRetry(async () => {
            return await this.coreApi.createNamespace(namespace);
        });
        return response.body;
    }

    // ==================== SERVICE ACCOUNTS ====================

    public async getServiceAccounts(namespace?: string): Promise<k8s.V1ServiceAccount[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.coreApi.listNamespacedServiceAccount(namespace)
                    : await this.coreApi.listServiceAccountForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching service accounts', error);
            return [];
        }
    }

    public async getServiceAccount(name: string, namespace: string): Promise<k8s.V1ServiceAccount> {
        const response = await withRetry(async () => {
            return await this.coreApi.readNamespacedServiceAccount(name, namespace);
        });
        return response.body;
    }

    public async deleteServiceAccount(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deleteNamespacedServiceAccount(name, namespace);
        });
    }
}
