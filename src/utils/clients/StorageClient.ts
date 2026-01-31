import * as k8s from '@kubernetes/client-node';
import { withRetry } from '../retry';
import { logger } from '../logger';
import { Cache, createCacheKey } from '../cache';
import { CACHE } from '../constants';

/**
 * Client for managing Kubernetes storage resources (PVs, PVCs, StorageClasses)
 */
export class StorageClient {
    private coreApi: k8s.CoreV1Api;
    private storageApi: k8s.StorageV1Api;
    private cache: Cache<any>;

    constructor(private kc: k8s.KubeConfig, cacheTtlMs: number = CACHE.DEFAULT_TTL) {
        this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        this.storageApi = this.kc.makeApiClient(k8s.StorageV1Api);
        this.cache = new Cache<any>(cacheTtlMs);
        logger.debug('StorageClient initialized with caching');
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
        this.storageApi = this.kc.makeApiClient(k8s.StorageV1Api);
        this.clearCache();
    }

    // ==================== PERSISTENT VOLUMES ====================

    public async getPersistentVolumes(): Promise<k8s.V1PersistentVolume[]> {
        const cacheKey = createCacheKey('pvs', 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return await this.coreApi.listPersistentVolume();
                });
                return response.body.items;
            } catch (error: unknown) {
                throw error;
            }
        });
    }

    public async getPersistentVolume(name: string): Promise<k8s.V1PersistentVolume> {
        const cacheKey = createCacheKey('pv', name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.coreApi.readPersistentVolume(name);
            });
            return response.body;
        });
    }

    public async deletePersistentVolume(name: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deletePersistentVolume(name);
        });
        // Invalidate related cache entries
        this.cache.delete('pvs:*');
        this.cache.delete(`pv:${name}`);
    }

    public async createPersistentVolume(pv: k8s.V1PersistentVolume): Promise<k8s.V1PersistentVolume> {
        const response = await withRetry(async () => {
            return await this.coreApi.createPersistentVolume(pv);
        });
        return response.body;
    }

    public async updatePersistentVolume(name: string, pv: k8s.V1PersistentVolume): Promise<k8s.V1PersistentVolume> {
        const response = await withRetry(async () => {
            return await this.coreApi.replacePersistentVolume(name, pv);
        });
        return response.body;
    }

    // ==================== PERSISTENT VOLUME CLAIMS ====================

    public async getPersistentVolumeClaims(namespace?: string): Promise<k8s.V1PersistentVolumeClaim[]> {
        const cacheKey = createCacheKey('pvcs', namespace || 'all');
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return namespace
                        ? await this.coreApi.listNamespacedPersistentVolumeClaim(namespace)
                        : await this.coreApi.listPersistentVolumeClaimForAllNamespaces();
                });
                return response.body.items;
            } catch (error: unknown) {
                throw error;
            }
        });
    }

    public async getPersistentVolumeClaim(name: string, namespace: string): Promise<k8s.V1PersistentVolumeClaim> {
        const cacheKey = createCacheKey('pvc', namespace, name);
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.coreApi.readNamespacedPersistentVolumeClaim(name, namespace);
            });
            return response.body;
        });
    }

    public async deletePersistentVolumeClaim(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deleteNamespacedPersistentVolumeClaim(name, namespace);
        });
        // Invalidate related cache entries
        this.cache.delete(`pvcs:${namespace}:*`);
        this.cache.delete(`pvc:${namespace}:${name}`);
    }

    public async createPersistentVolumeClaim(namespace: string, pvc: k8s.V1PersistentVolumeClaim): Promise<k8s.V1PersistentVolumeClaim> {
        const response = await withRetry(async () => {
            return await this.coreApi.createNamespacedPersistentVolumeClaim(namespace, pvc);
        });
        return response.body;
    }

    // ==================== STORAGE CLASSES ====================

    public async getStorageClasses(): Promise<k8s.V1StorageClass[]> {
        try {
            const response = await withRetry(async () => {
                return await this.storageApi.listStorageClass();
            });
            return response.body.items;
        } catch (error: unknown) {
            throw error;
        }
    }

    public async getStorageClass(name: string): Promise<k8s.V1StorageClass> {
        const response = await withRetry(async () => {
            return await this.storageApi.readStorageClass(name);
        });
        return response.body;
    }

    public async deleteStorageClass(name: string): Promise<void> {
        await withRetry(async () => {
            await this.storageApi.deleteStorageClass(name);
        });
    }

    public async createStorageClass(sc: k8s.V1StorageClass): Promise<k8s.V1StorageClass> {
        const response = await withRetry(async () => {
            return await this.storageApi.createStorageClass(sc);
        });
        return response.body;
    }
}
