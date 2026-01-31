import * as k8s from '@kubernetes/client-node';
import { withRetry } from '../retry';
import { logger } from '../logger';
import { Cache, createCacheKey } from '../cache';

/**
 * Client for managing Kubernetes workload resources (pods, deployments, statefulsets, daemonsets, jobs)
 */
export class WorkloadClient {
    private coreApi: k8s.CoreV1Api;
    private appsApi: k8s.AppsV1Api;
    private batchApi: k8s.BatchV1Api;
    private cache: Cache<any>;

    constructor(private kc: k8s.KubeConfig, cacheTtlMs: number = 30000) {
        this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
        this.batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
        this.cache = new Cache(cacheTtlMs);
        logger.debug('WorkloadClient initialized with caching');
    }

    /**
     * Refresh API clients with updated kubeconfig
     */
    public refresh(kc: k8s.KubeConfig): void {
        this.kc = kc;
        this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
        this.batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
        this.cache.clear();
    }

    /**
     * Clear cache manually
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

    // ==================== PODS ====================

    public async getPods(namespace?: string): Promise<k8s.V1Pod[]> {
        const cacheKey = createCacheKey('pods', namespace);
        
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return namespace
                        ? await this.coreApi.listNamespacedPod(namespace)
                        : await this.coreApi.listPodForAllNamespaces();
                });
                logger.debug(`Fetched ${response.body.items.length} pods`);
                return response.body.items;
            } catch (error: unknown) {
                throw error;
            }
        });
    }

    public async getPod(name: string, namespace: string): Promise<k8s.V1Pod> {
        const cacheKey = createCacheKey('pod', namespace, name);
        
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.coreApi.readNamespacedPod(name, namespace);
            });
            return response.body;
        });
    }

    public async deletePod(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deleteNamespacedPod(name, namespace);
        });
        // Invalidate cache for this namespace
        this.cache.invalidatePattern(`pods:${namespace}*`);
        this.cache.invalidatePattern(`pod:${namespace}:${name}`);
    }

    public async getLogs(namespace: string, podName: string, containerName?: string, tailLines?: number): Promise<string> {
        try {
            const response = await withRetry(async () => {
                return await this.coreApi.readNamespacedPodLog(
                    podName,
                    namespace,
                    containerName,
                    false,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    tailLines
                );
            });
            return response.body;
        } catch (error) {
            logger.error('Error fetching logs', error);
            return `Error fetching logs: ${error}`;
        }
    }

    // ==================== DEPLOYMENTS ====================

    public async getDeployments(namespace?: string): Promise<k8s.V1Deployment[]> {
        const cacheKey = createCacheKey('deployments', namespace);
        
        return this.cache.getOrCompute(cacheKey, async () => {
            try {
                const response = await withRetry(async () => {
                    return namespace
                        ? await this.appsApi.listNamespacedDeployment(namespace)
                        : await this.appsApi.listDeploymentForAllNamespaces();
                });
                return response.body.items;
            } catch (error: unknown) {
                throw error;
            }
        });
    }

    public async getDeployment(name: string, namespace: string): Promise<k8s.V1Deployment> {
        const cacheKey = createCacheKey('deployment', namespace, name);
        
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await withRetry(async () => {
                return await this.appsApi.readNamespacedDeployment(name, namespace);
            });
            return response.body;
        });
    }

    public async deleteDeployment(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.appsApi.deleteNamespacedDeployment(name, namespace);
        });
        // Invalidate cache
        this.cache.invalidatePattern(`deployments:${namespace}*`);
        this.cache.invalidatePattern(`deployment:${namespace}:${name}`);
    }

    public async scaleDeployment(name: string, namespace: string, replicas: number): Promise<void> {
        try {
            const patch = { spec: { replicas } };
            await withRetry(async () => {
                await this.appsApi.patchNamespacedDeployment(
                    name,
                    namespace,
                    patch,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { headers: { 'Content-Type': 'application/merge-patch+json' } }
                );
            });
        } catch (error) {
            logger.error('Failed to scale deployment', error);
            throw error;
        }
    }

    public async restartDeployment(name: string, namespace: string): Promise<void> {
        try {
            const patch = {
                spec: {
                    template: {
                        metadata: {
                            annotations: {
                                'kubectl.kubernetes.io/restartedAt': new Date().toISOString()
                            }
                        }
                    }
                }
            };

            await withRetry(async () => {
                await this.appsApi.patchNamespacedDeployment(
                    name,
                    namespace,
                    patch,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { headers: { 'Content-Type': 'application/merge-patch+json' } }
                );
            });
        } catch (error) {
            logger.error('Failed to restart deployment', error);
            throw error;
        }
    }

    // ==================== STATEFULSETS ====================

    public async getStatefulSets(namespace?: string): Promise<k8s.V1StatefulSet[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.appsApi.listNamespacedStatefulSet(namespace)
                    : await this.appsApi.listStatefulSetForAllNamespaces();
            });
            return response.body.items;
        } catch (error: unknown) {
            throw error;
        }
    }

    public async deleteStatefulSet(name: string, namespace: string): Promise<void> {
        try {
            await withRetry(async () => {
                await this.appsApi.deleteNamespacedStatefulSet(name, namespace);
            });
        } catch (error) {
            logger.error('Failed to delete StatefulSet', error);
            throw error;
        }
    }

    public async scaleStatefulSet(name: string, namespace: string, replicas: number): Promise<void> {
        try {
            const patch = { spec: { replicas } };
            await withRetry(async () => {
                await this.appsApi.patchNamespacedStatefulSet(
                    name,
                    namespace,
                    patch,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { headers: { 'Content-Type': 'application/merge-patch+json' } }
                );
            });
        } catch (error) {
            logger.error('Failed to scale StatefulSet', error);
            throw error;
        }
    }

    public async restartStatefulSet(name: string, namespace: string): Promise<void> {
        try {
            const statefulSet = await withRetry(async () => {
                return await this.appsApi.readNamespacedStatefulSet(name, namespace);
            });
            
            if (statefulSet.body.spec?.template?.metadata) {
                if (!statefulSet.body.spec.template.metadata.annotations) {
                    statefulSet.body.spec.template.metadata.annotations = {};
                }
                statefulSet.body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = 
                    new Date().toISOString();
                
                await withRetry(async () => {
                    await this.appsApi.replaceNamespacedStatefulSet(name, namespace, statefulSet.body);
                });
            }
        } catch (error) {
            logger.error('Failed to restart StatefulSet', error);
            throw error;
        }
    }

    public async setStatefulSetPartition(name: string, namespace: string, partition: number): Promise<void> {
        try {
            const patch = {
                spec: {
                    updateStrategy: {
                        type: 'RollingUpdate',
                        rollingUpdate: {
                            partition
                        }
                    }
                }
            };
            await withRetry(async () => {
                await this.appsApi.patchNamespacedStatefulSet(
                    name,
                    namespace,
                    patch,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { headers: { 'Content-Type': 'application/merge-patch+json' } }
                );
            });
        } catch (error) {
            logger.error('Failed to set StatefulSet partition', error);
            throw error;
        }
    }

    // ==================== DAEMONSETS ====================

    public async getDaemonSets(namespace?: string): Promise<k8s.V1DaemonSet[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.appsApi.listNamespacedDaemonSet(namespace)
                    : await this.appsApi.listDaemonSetForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching daemonsets', error);
            return [];
        }
    }

    public async deleteDaemonSet(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.appsApi.deleteNamespacedDaemonSet(name, namespace);
        });
    }

    public async restartDaemonSet(name: string, namespace: string): Promise<void> {
        try {
            const daemonSet = await withRetry(async () => {
                return await this.appsApi.readNamespacedDaemonSet(name, namespace);
            });
            
            if (daemonSet.body.spec?.template?.metadata) {
                if (!daemonSet.body.spec.template.metadata.annotations) {
                    daemonSet.body.spec.template.metadata.annotations = {};
                }
                daemonSet.body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = 
                    new Date().toISOString();
                
                await withRetry(async () => {
                    await this.appsApi.replaceNamespacedDaemonSet(name, namespace, daemonSet.body);
                });
            }
        } catch (error) {
            logger.error('Failed to restart DaemonSet', error);
            throw error;
        }
    }

    public async updateDaemonSetStrategy(name: string, namespace: string, maxUnavailable: string): Promise<void> {
        const patch = {
            spec: {
                updateStrategy: {
                    type: 'RollingUpdate',
                    rollingUpdate: {
                        maxUnavailable
                    }
                }
            }
        };

        await withRetry(async () => {
            await this.appsApi.patchNamespacedDaemonSet(
                name,
                namespace,
                patch,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { headers: { 'Content-Type': 'application/merge-patch+json' } }
            );
        });
    }

    // ==================== REPLICASETS ====================

    public async getReplicaSets(namespace?: string): Promise<k8s.V1ReplicaSet[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.appsApi.listNamespacedReplicaSet(namespace)
                    : await this.appsApi.listReplicaSetForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching replicasets', error);
            return [];
        }
    }

    public async deleteReplicaSet(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.appsApi.deleteNamespacedReplicaSet(name, namespace);
        });
    }

    public async scaleReplicaSet(name: string, namespace: string, replicas: number): Promise<void> {
        try {
            const replicaSet = await withRetry(async () => {
                return await this.appsApi.readNamespacedReplicaSet(name, namespace);
            });
            
            if (replicaSet.body.spec) {
                replicaSet.body.spec.replicas = replicas;
                await withRetry(async () => {
                    await this.appsApi.replaceNamespacedReplicaSet(name, namespace, replicaSet.body);
                });
            }
        } catch (error) {
            logger.error('Failed to scale ReplicaSet', error);
            throw error;
        }
    }

    // ==================== JOBS ====================

    public async getJobs(namespace?: string): Promise<k8s.V1Job[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.batchApi.listNamespacedJob(namespace)
                    : await this.batchApi.listJobForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching jobs', error);
            return [];
        }
    }

    public async deleteJob(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.batchApi.deleteNamespacedJob(name, namespace);
        });
    }

    // ==================== CRONJOBS ====================

    public async getCronJobs(namespace?: string): Promise<k8s.V1CronJob[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.batchApi.listNamespacedCronJob(namespace)
                    : await this.batchApi.listCronJobForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching cronjobs', error);
            return [];
        }
    }

    public async deleteCronJob(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.batchApi.deleteNamespacedCronJob(name, namespace);
        });
    }

    public async triggerCronJob(cronJobName: string, namespace: string): Promise<void> {
        try {
            // Get the CronJob to use as template
            const cronJobResponse = await withRetry(async () => {
                return await this.batchApi.readNamespacedCronJob(cronJobName, namespace);
            });
            const cronJob = cronJobResponse.body;

            // Create a Job from the CronJob template
            const job: k8s.V1Job = {
                apiVersion: 'batch/v1',
                kind: 'Job',
                metadata: {
                    name: `${cronJobName}-manual-${Date.now()}`,
                    namespace: namespace,
                    annotations: {
                        'cronjob.kubernetes.io/instantiate': 'manual'
                    }
                },
                spec: cronJob.spec?.jobTemplate.spec
            };

            await withRetry(async () => {
                await this.batchApi.createNamespacedJob(namespace, job);
            });
        } catch (error) {
            logger.error('Failed to trigger CronJob', error);
            throw error;
        }
    }

    public async toggleCronJobSuspend(name: string, namespace: string, suspend: boolean): Promise<void> {
        try {
            const patch = {
                spec: {
                    suspend: suspend
                }
            };

            await withRetry(async () => {
                await this.batchApi.patchNamespacedCronJob(
                    name,
                    namespace,
                    patch,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { headers: { 'Content-Type': 'application/merge-patch+json' } }
                );
            });
        } catch (error) {
            logger.error('Failed to update CronJob suspend status', error);
            throw error;
        }
    }
}
