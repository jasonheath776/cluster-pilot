import * as k8s from '@kubernetes/client-node';
import { withRetry } from '../retry';
import { logger } from '../logger';
import { Cache, createCacheKey } from '../cache';
import { CACHE } from '../constants';

/**
 * Client for managing Kubernetes network resources (services, ingresses, endpoints, network policies)
 */
export class NetworkClient {
    private coreApi: k8s.CoreV1Api;
    private networkingApi: k8s.NetworkingV1Api;
    private cache: Cache<any>;

    constructor(private kc: k8s.KubeConfig, cacheTtlMs: number = CACHE.DEFAULT_TTL) {
        this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
        this.cache = new Cache<any>(cacheTtlMs);
        logger.debug('NetworkClient initialized with caching');
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
        this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
        this.clearCache();
    }

    // ==================== SERVICES ====================

    public async getServices(namespace?: string): Promise<k8s.V1Service[]> {
        const cacheKey = createCacheKey('services', namespace || 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return namespace
                        ? await this.coreApi.listNamespacedService(namespace)
                        : await this.coreApi.listServiceForAllNamespaces();
                });
                return response.body.items;
            } catch (error: unknown) {
                throw error;
            }
        });
    }

    public async getService(name: string, namespace: string): Promise<k8s.V1Service> {
        const cacheKey = createCacheKey('service', namespace, name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.coreApi.readNamespacedService(name, namespace);
            });
            return response.body;
        });
    }

    public async deleteService(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deleteNamespacedService(name, namespace);
        });
        // Invalidate related cache entries
        this.cache.delete(`services:${namespace}:*`);
        this.cache.delete(`service:${namespace}:${name}`);
    }

    // ==================== ENDPOINTS ====================

    public async getEndpoints(name: string, namespace: string): Promise<k8s.V1Endpoints> {
        const response = await withRetry(async () => {
            return await this.coreApi.readNamespacedEndpoints(name, namespace);
        });
        return response.body;
    }

    public async getAllEndpoints(namespace?: string): Promise<k8s.V1Endpoints[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.coreApi.listNamespacedEndpoints(namespace)
                    : await this.coreApi.listEndpointsForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching endpoints', error);
            return [];
        }
    }

    // ==================== INGRESSES ====================

    public async getIngresses(namespace?: string): Promise<k8s.V1Ingress[]> {
        const cacheKey = createCacheKey('ingresses', namespace || 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return namespace
                        ? await this.networkingApi.listNamespacedIngress(namespace)
                        : await this.networkingApi.listIngressForAllNamespaces();
                });
                return response.body.items;
            } catch (error: unknown) {
                throw error;
            }
        });
    }

    public async getIngress(name: string, namespace: string): Promise<k8s.V1Ingress> {
        const cacheKey = createCacheKey('ingress', namespace, name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.networkingApi.readNamespacedIngress(name, namespace);
            });
            return response.body;
        });
    }

    public async deleteIngress(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.networkingApi.deleteNamespacedIngress(name, namespace);
        });
        // Invalidate related cache entries
        this.cache.delete(`ingresses:${namespace}:*`);
        this.cache.delete(`ingress:${namespace}:${name}`);
    }

    // ==================== NETWORK POLICIES ====================

    public async getNetworkPolicies(namespace?: string): Promise<k8s.V1NetworkPolicy[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.networkingApi.listNamespacedNetworkPolicy(namespace)
                    : await this.networkingApi.listNetworkPolicyForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching network policies', error);
            return [];
        }
    }

    public async getNetworkPolicy(name: string, namespace: string): Promise<k8s.V1NetworkPolicy> {
        const response = await withRetry(async () => {
            return await this.networkingApi.readNamespacedNetworkPolicy(name, namespace);
        });
        return response.body;
    }

    public async deleteNetworkPolicy(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.networkingApi.deleteNamespacedNetworkPolicy(name, namespace);
        });
    }

    public async createNetworkPolicy(namespace: string, policy: k8s.V1NetworkPolicy): Promise<k8s.V1NetworkPolicy> {
        const response = await withRetry(async () => {
            return await this.networkingApi.createNamespacedNetworkPolicy(namespace, policy);
        });
        return response.body;
    }
}
