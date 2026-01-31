import * as k8s from '@kubernetes/client-node';
import { withRetry } from '../retry';
import { logger } from '../logger';

/**
 * Client for managing Kubernetes cluster-level resources (Nodes, Events, CRDs, Metrics, HPAs, PDBs, etc.)
 */
export class ClusterClient {
    private coreApi: k8s.CoreV1Api;
    private apiExtensionsApi: k8s.ApiextensionsV1Api;
    private customObjectsApi: k8s.CustomObjectsApi;
    private autoscalingApi: k8s.AutoscalingV2Api;
    private policyApi: k8s.PolicyV1Api;
    private metricsClient: k8s.Metrics;

    constructor(private kc: k8s.KubeConfig) {
        this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        this.apiExtensionsApi = this.kc.makeApiClient(k8s.ApiextensionsV1Api);
        this.customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
        this.autoscalingApi = this.kc.makeApiClient(k8s.AutoscalingV2Api);
        this.policyApi = this.kc.makeApiClient(k8s.PolicyV1Api);
        this.metricsClient = new k8s.Metrics(this.kc);
        logger.debug('ClusterClient initialized');
    }

    /**
     * Refresh API clients with updated kubeconfig
     */
    public refresh(kc: k8s.KubeConfig): void {
        this.kc = kc;
        this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        this.apiExtensionsApi = this.kc.makeApiClient(k8s.ApiextensionsV1Api);
        this.customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
        this.autoscalingApi = this.kc.makeApiClient(k8s.AutoscalingV2Api);
        this.policyApi = this.kc.makeApiClient(k8s.PolicyV1Api);
        this.metricsClient = new k8s.Metrics(this.kc);
    }

    // ==================== NODES ====================

    public async getNodes(): Promise<k8s.V1Node[]> {
        try {
            const response = await withRetry(async () => {
                return await this.coreApi.listNode();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching nodes', error);
            return [];
        }
    }

    public async getNode(name: string): Promise<k8s.V1Node> {
        const response = await withRetry(async () => {
            return await this.coreApi.readNode(name);
        });
        return response.body;
    }

    public async deleteNode(name: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deleteNode(name);
        });
    }

    public async cordonNode(nodeName: string): Promise<void> {
        try {
            const patch = [
                {
                    op: 'replace',
                    path: '/spec/unschedulable',
                    value: true
                }
            ];
            
            await withRetry(async () => {
                await this.coreApi.patchNode(
                    nodeName,
                    patch,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { headers: { 'Content-Type': 'application/json-patch+json' } }
                );
            });
        } catch (error) {
            logger.error('Failed to cordon node', error);
            throw error;
        }
    }

    public async uncordonNode(nodeName: string): Promise<void> {
        try {
            const patch = [
                {
                    op: 'replace',
                    path: '/spec/unschedulable',
                    value: false
                }
            ];
            
            await withRetry(async () => {
                await this.coreApi.patchNode(
                    nodeName,
                    patch,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { headers: { 'Content-Type': 'application/json-patch+json' } }
                );
            });
        } catch (error) {
            logger.error('Failed to uncordon node', error);
            throw error;
        }
    }

    public async drainNode(nodeName: string): Promise<void> {
        try {
            // First, cordon the node
            await this.cordonNode(nodeName);

            // Get all pods on the node
            const response = await withRetry(async () => {
                return await this.coreApi.listPodForAllNamespaces(
                    undefined,
                    undefined,
                    `spec.nodeName=${nodeName}`
                );
            });
            const pods = response.body.items;

            // Delete all pods (except DaemonSet pods)
            const deletionPromises = pods
                .filter(pod => {
                    // Skip DaemonSet pods
                    const ownerRefs = pod.metadata?.ownerReferences || [];
                    return !ownerRefs.some(ref => ref.kind === 'DaemonSet');
                })
                .map(pod => {
                    const namespace = pod.metadata?.namespace || 'default';
                    const name = pod.metadata?.name || '';
                    return withRetry(async () => {
                        await this.coreApi.deleteNamespacedPod(
                            name,
                            namespace,
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            undefined,
                            { gracePeriodSeconds: 30 } as k8s.V1DeleteOptions
                        );
                    });
                });

            await Promise.all(deletionPromises);
        } catch (error) {
            logger.error('Failed to drain node', error);
            throw error;
        }
    }

    // ==================== EVENTS ====================

    public async getEvents(namespace: string): Promise<k8s.CoreV1Event[]> {
        try {
            const response = await withRetry(async () => {
                return await this.coreApi.listNamespacedEvent(namespace);
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching events', error);
            return [];
        }
    }

    public async getAllEvents(): Promise<k8s.CoreV1Event[]> {
        try {
            const response = await withRetry(async () => {
                return await this.coreApi.listEventForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching all events', error);
            return [];
        }
    }

    // ==================== METRICS ====================

    public async getNodeMetrics(): Promise<k8s.NodeMetric[]> {
        try {
            const metrics = await withRetry(async () => {
                return await this.metricsClient.getNodeMetrics();
            });
            return metrics.items;
        } catch (error) {
            logger.error('Error fetching node metrics', error);
            return [];
        }
    }

    public async getPodMetrics(namespace?: string): Promise<k8s.PodMetric[]> {
        try {
            const metrics = await withRetry(async () => {
                return namespace
                    ? await this.metricsClient.getPodMetrics(namespace)
                    : await this.metricsClient.getPodMetrics();
            });
            return metrics.items;
        } catch (error) {
            logger.error('Error fetching pod metrics', error);
            return [];
        }
    }

    public async getClusterMetrics(): Promise<{
        nodeMetrics: k8s.NodeMetric[];
        podMetrics: k8s.PodMetric[];
        totalCpu: number;
        totalMemory: number;
        usedCpu: number;
        usedMemory: number;
    }> {
        const nodeMetrics = await this.getNodeMetrics();
        const podMetrics = await this.getPodMetrics();

        let totalCpu = 0;
        let totalMemory = 0;
        let usedCpu = 0;
        let usedMemory = 0;

        for (const node of nodeMetrics) {
            if (node.usage) {
                usedCpu += this.parseResource(node.usage.cpu || '0');
                usedMemory += this.parseResource(node.usage.memory || '0');
            }
        }

        const nodes = await this.getNodes();
        for (const node of nodes) {
            if (node.status?.allocatable) {
                totalCpu += this.parseResource(node.status.allocatable.cpu || '0');
                totalMemory += this.parseResource(node.status.allocatable.memory || '0');
            }
        }

        return {
            nodeMetrics,
            podMetrics,
            totalCpu,
            totalMemory,
            usedCpu,
            usedMemory
        };
    }

    private parseResource(value: string): number {
        const units: { [key: string]: number } = {
            'n': 0.000000001,
            'u': 0.000001,
            'm': 0.001,
            '': 1,
            'k': 1000,
            'K': 1024,
            'M': 1024 * 1024,
            'G': 1024 * 1024 * 1024,
            'T': 1024 * 1024 * 1024 * 1024,
            'Ki': 1024,
            'Mi': 1024 * 1024,
            'Gi': 1024 * 1024 * 1024,
            'Ti': 1024 * 1024 * 1024 * 1024
        };

        const match = value.match(/^(\d+(?:\.\d+)?)(.*)/);
        if (!match) {return 0;}

        const num = parseFloat(match[1]);
        const unit = match[2];
        return num * (units[unit] || 1);
    }

    // ==================== CRDs ====================

    public async getCRDs(): Promise<k8s.V1CustomResourceDefinition[]> {
        try {
            const response = await withRetry(async () => {
                return await this.apiExtensionsApi.listCustomResourceDefinition();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching CRDs', error);
            return [];
        }
    }

    public async getCRD(name: string): Promise<k8s.V1CustomResourceDefinition> {
        const response = await withRetry(async () => {
            return await this.apiExtensionsApi.readCustomResourceDefinition(name);
        });
        return response.body;
    }

    public async getCustomResources(group: string, version: string, plural: string, namespace?: string): Promise<any[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.customObjectsApi.listNamespacedCustomObject(group, version, namespace, plural)
                    : await this.customObjectsApi.listClusterCustomObject(group, version, plural);
            });
            return (response.body as any).items || [];
        } catch (error) {
            logger.error('Error fetching custom resources', error);
            return [];
        }
    }

    public async deleteCustomResource(group: string, version: string, plural: string, name: string, namespace?: string): Promise<void> {
        await withRetry(async () => {
            if (namespace) {
                await this.customObjectsApi.deleteNamespacedCustomObject(group, version, namespace, plural, name);
            } else {
                await this.customObjectsApi.deleteClusterCustomObject(group, version, plural, name);
            }
        });
    }

    // ==================== HPAs ====================

    public async getHPAs(namespace?: string): Promise<k8s.V2HorizontalPodAutoscaler[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.autoscalingApi.listNamespacedHorizontalPodAutoscaler(namespace)
                    : await this.autoscalingApi.listHorizontalPodAutoscalerForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching HPAs', error);
            return [];
        }
    }

    public async getHPA(name: string, namespace: string): Promise<k8s.V2HorizontalPodAutoscaler> {
        const response = await withRetry(async () => {
            return await this.autoscalingApi.readNamespacedHorizontalPodAutoscaler(name, namespace);
        });
        return response.body;
    }

    public async deleteHPA(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.autoscalingApi.deleteNamespacedHorizontalPodAutoscaler(name, namespace);
        });
    }

    // ==================== PDBs ====================

    public async getPodDisruptionBudgets(namespace?: string): Promise<k8s.V1PodDisruptionBudget[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.policyApi.listNamespacedPodDisruptionBudget(namespace)
                    : await this.policyApi.listPodDisruptionBudgetForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching PDBs', error);
            return [];
        }
    }

    public async getPodDisruptionBudget(name: string, namespace: string): Promise<k8s.V1PodDisruptionBudget> {
        const response = await withRetry(async () => {
            return await this.policyApi.readNamespacedPodDisruptionBudget(name, namespace);
        });
        return response.body;
    }

    public async deletePodDisruptionBudget(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.policyApi.deleteNamespacedPodDisruptionBudget(name, namespace);
        });
    }

    // ==================== RESOURCE QUOTAS ====================

    public async getResourceQuotas(namespace?: string): Promise<k8s.V1ResourceQuota[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.coreApi.listNamespacedResourceQuota(namespace)
                    : await this.coreApi.listResourceQuotaForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching resource quotas', error);
            return [];
        }
    }

    public async getResourceQuota(name: string, namespace: string): Promise<k8s.V1ResourceQuota> {
        const response = await withRetry(async () => {
            return await this.coreApi.readNamespacedResourceQuota(name, namespace);
        });
        return response.body;
    }

    public async deleteResourceQuota(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deleteNamespacedResourceQuota(name, namespace);
        });
    }

    // ==================== LIMIT RANGES ====================

    public async getLimitRanges(namespace?: string): Promise<k8s.V1LimitRange[]> {
        try {
            const response = await withRetry(async () => {
                return namespace
                    ? await this.coreApi.listNamespacedLimitRange(namespace)
                    : await this.coreApi.listLimitRangeForAllNamespaces();
            });
            return response.body.items;
        } catch (error) {
            logger.error('Error fetching limit ranges', error);
            return [];
        }
    }

    public async getLimitRange(name: string, namespace: string): Promise<k8s.V1LimitRange> {
        const response = await withRetry(async () => {
            return await this.coreApi.readNamespacedLimitRange(name, namespace);
        });
        return response.body;
    }

    public async deleteLimitRange(name: string, namespace: string): Promise<void> {
        await withRetry(async () => {
            await this.coreApi.deleteNamespacedLimitRange(name, namespace);
        });
    }

    // ==================== GENERIC RESOURCE OPERATIONS ====================

    public async deleteResource(kind: string, name: string, namespace?: string): Promise<void> {
        const deleteMethod = this.getDeleteMethod(kind);
        if (namespace) {
            await withRetry(async () => {
                await deleteMethod.call(this.coreApi, name, namespace);
            });
        } else {
            await withRetry(async () => {
                await deleteMethod.call(this.coreApi, name);
            });
        }
    }

    private getDeleteMethod(kind: string): Function {
        const methodMap: { [key: string]: string } = {
            'Pod': 'deleteNamespacedPod',
            'Service': 'deleteNamespacedService',
            'Deployment': 'deleteNamespacedDeployment',
            'StatefulSet': 'deleteNamespacedStatefulSet',
            'DaemonSet': 'deleteNamespacedDaemonSet',
            'ReplicaSet': 'deleteNamespacedReplicaSet',
            'Job': 'deleteNamespacedJob',
            'CronJob': 'deleteNamespacedCronJob',
            'ConfigMap': 'deleteNamespacedConfigMap',
            'Secret': 'deleteNamespacedSecret',
            'PersistentVolume': 'deletePersistentVolume',
            'PersistentVolumeClaim': 'deleteNamespacedPersistentVolumeClaim',
            'Namespace': 'deleteNamespace',
            'Node': 'deleteNode',
            'ServiceAccount': 'deleteNamespacedServiceAccount'
        };

        const methodName = methodMap[kind];
        if (!methodName) {
            throw new Error(`Unknown resource kind: ${kind}`);
        }

        return (this.coreApi as any)[methodName];
    }
}
