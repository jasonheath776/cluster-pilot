import * as k8s from '@kubernetes/client-node';
import { KubeconfigManager } from './kubeconfig';
import { logger } from './logger';
import { withRetry } from './retry';
import { 
    WorkloadClient,
    NetworkClient,
    StorageClient,
    ConfigClient,
    RBACClient,
    ClusterClient
} from './clients';

export interface K8sResource {
    kind: string;
    metadata: {
        name: string;
        namespace?: string;
        labels?: { [key: string]: string };
        annotations?: { [key: string]: string };
    };
    spec?: unknown;
    status?: unknown;
}

export class K8sClient {
    private kc: k8s.KubeConfig;
    private appsApi!: k8s.AppsV1Api;

    // Domain clients
    public readonly workloads: WorkloadClient;
    public readonly network: NetworkClient;
    public readonly storage: StorageClient;
    public readonly config: ConfigClient;
    public readonly rbac: RBACClient;
    public readonly cluster: ClusterClient;

    constructor(private kubeconfigManager: KubeconfigManager) {
        this.kc = kubeconfigManager.getKubeConfig();
        this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
        
        // Initialize domain clients
        this.workloads = new WorkloadClient(this.kc);
        this.network = new NetworkClient(this.kc);
        this.storage = new StorageClient(this.kc);
        this.config = new ConfigClient(this.kc);
        this.rbac = new RBACClient(this.kc);
        this.cluster = new ClusterClient(this.kc);
        
        logger.debug('K8sClient initialized with domain clients');
    }

    public refresh(): void {
        this.kc = this.kubeconfigManager.getKubeConfig();
        this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
        
        // Refresh all domain clients
        this.workloads.refresh(this.kc);
        this.network.refresh(this.kc);
        this.storage.refresh(this.kc);
        this.config.refresh(this.kc);
        this.rbac.refresh(this.kc);
        this.cluster.refresh(this.kc);
    }

    /**
     * Get the kubeconfig instance for watch operations
     */
    public getKubeConfig(): k8s.KubeConfig {
        return this.kc;
    }

    // ==================== WORKLOAD DELEGATION ====================
    // Pods
    public async getPods(namespace?: string): Promise<k8s.V1Pod[]> {
        return this.workloads.getPods(namespace);
    }

    // Deployments
    public async getDeployments(namespace?: string): Promise<k8s.V1Deployment[]> {
        return this.workloads.getDeployments(namespace);
    }

    // StatefulSets
    public async getStatefulSets(namespace?: string): Promise<k8s.V1StatefulSet[]> {
        return this.workloads.getStatefulSets(namespace);
    }

    public async deleteStatefulSet(name: string, namespace: string): Promise<void> {
        return this.workloads.deleteStatefulSet(name, namespace);
    }

    public async scaleStatefulSet(name: string, namespace: string, replicas: number): Promise<void> {
        return this.workloads.scaleStatefulSet(name, namespace, replicas);
    }

    public async setStatefulSetPartition(name: string, namespace: string, partition: number): Promise<void> {
        return this.workloads.setStatefulSetPartition(name, namespace, partition);
    }

    // DaemonSets
    public async getDaemonSets(namespace?: string): Promise<k8s.V1DaemonSet[]> {
        return this.workloads.getDaemonSets(namespace);
    }

    public async deleteDaemonSet(name: string, namespace: string): Promise<void> {
        return this.workloads.deleteDaemonSet(name, namespace);
    }

    public async updateDaemonSetStrategy(name: string, namespace: string, maxUnavailable: string): Promise<void> {
        return this.workloads.updateDaemonSetStrategy(name, namespace, maxUnavailable);
    }

    // ==================== NETWORK DELEGATION ====================
    // Services
    public async getServices(namespace?: string): Promise<k8s.V1Service[]> {
        return this.network.getServices(namespace);
    }

    public async deleteService(name: string, namespace: string): Promise<void> {
        return this.network.deleteService(name, namespace);
    }

    public async getEndpoints(name: string, namespace: string): Promise<k8s.V1Endpoints | null> {
        try {
            if (!name || !namespace) {
                logger.warn('getEndpoints: name and namespace are required');
                return null;
            }
            return await this.network.getEndpoints(name, namespace);
        } catch (error) {
            logger.error(`Error fetching endpoints for ${name}/${namespace}`, error);
            return null;
        }
    }

    // Ingresses
    public async getIngresses(namespace?: string): Promise<k8s.V1Ingress[]> {
        return this.network.getIngresses(namespace);
    }

    public async deleteIngress(name: string, namespace: string): Promise<void> {
        return this.network.deleteIngress(name, namespace);
    }

    // ==================== STORAGE DELEGATION ====================
    // PersistentVolumes
    public async getPersistentVolumes(): Promise<k8s.V1PersistentVolume[]> {
        return this.storage.getPersistentVolumes();
    }

    public async deletePersistentVolume(name: string): Promise<void> {
        return this.storage.deletePersistentVolume(name);
    }

    public async createPersistentVolume(pv: k8s.V1PersistentVolume): Promise<k8s.V1PersistentVolume> {
        return this.storage.createPersistentVolume(pv);
    }

    public async updatePersistentVolume(name: string, pv: k8s.V1PersistentVolume): Promise<k8s.V1PersistentVolume> {
        return this.storage.updatePersistentVolume(name, pv);
    }

    // PersistentVolumeClaims
    public async getPersistentVolumeClaims(namespace?: string): Promise<k8s.V1PersistentVolumeClaim[]> {
        return this.storage.getPersistentVolumeClaims(namespace);
    }

    // StorageClasses
    public async getStorageClasses(): Promise<k8s.V1StorageClass[]> {
        return this.storage.getStorageClasses();
    }

    // ==================== CLUSTER DELEGATION ====================
    // Nodes
    public async getNodes(): Promise<k8s.V1Node[]> {
        return this.cluster.getNodes();
    }

    // ==================== CONFIG DELEGATION ====================
    // Namespaces
    public async getNamespaces(): Promise<k8s.V1Namespace[]> {
        return this.config.getNamespaces();
    }

    // Logs
    public async getLogs(namespace: string, podName: string, containerName?: string, tailLines?: number): Promise<string> {
        return this.workloads.getLogs(namespace, podName, containerName, tailLines);
    }

    // Delete resource
    public async deleteResource(kind: string, name: string, namespace?: string): Promise<void> {
        try {
            switch (kind.toLowerCase()) {
                case 'pod':
                    await this.workloads.deletePod(name, namespace!);
                    break;
                case 'deployment':
                    await this.workloads.deleteDeployment(name, namespace!);
                    break;
                case 'service':
                    await this.network.deleteService(name, namespace!);
                    break;
                case 'configmap':
                    await this.config.deleteConfigMap(name, namespace!);
                    break;
                case 'secret':
                    await this.config.deleteSecret(name, namespace!);
                    break;
                default:
                    throw new Error(`Unsupported resource type: ${kind}`);
            }
        } catch (error) {
            throw new Error(`Failed to delete ${kind} ${name}: ${error}`);
        }
    }

    // Get Events
    public async getEvents(namespace: string): Promise<k8s.CoreV1Event[]> {
        return this.cluster.getEvents(namespace);
    }

    // Restart StatefulSet
    public async restartStatefulSet(name: string, namespace: string): Promise<void> {
        return this.workloads.restartStatefulSet(name, namespace);
    }

    // Restart DaemonSet
    public async restartDaemonSet(name: string, namespace: string): Promise<void> {
        return this.workloads.restartDaemonSet(name, namespace);
    }

    // Scale ReplicaSet
    public async scaleReplicaSet(name: string, namespace: string, replicas: number): Promise<void> {
        return this.workloads.scaleReplicaSet(name, namespace, replicas);
    }

    // Metrics Methods
    public async getNodeMetrics(): Promise<k8s.NodeMetric[]> {
        return this.cluster.getNodeMetrics();
    }

    public async getPodMetrics(namespace?: string): Promise<k8s.PodMetric[]> {
        return this.cluster.getPodMetrics(namespace);
    }

    public async getClusterMetrics(): Promise<{
        nodeCount: number;
        podCount: number;
        namespaceCount: number;
        deploymentCount: number;
        serviceCount: number;
        totalCpu: string;
        totalMemory: string;
        usedCpu: string;
        usedMemory: string;
    }> {
        // Get basic counts from the domain clients
        const [nodes, allPods, namespaces, deployments, services] = await Promise.all([
            this.cluster.getNodes(),
            this.workloads.getPods(),
            this.config.getNamespaces(),
            this.workloads.getDeployments(),
            this.network.getServices()
        ]);

        // Get metrics from cluster client
        const metrics = await this.cluster.getClusterMetrics();

        return {
            nodeCount: nodes.length,
            podCount: allPods.length,
            namespaceCount: namespaces.length,
            deploymentCount: deployments.length,
            serviceCount: services.length,
            totalCpu: `${metrics.totalCpu.toFixed(2)} cores`,
            totalMemory: this.formatBytes(metrics.totalMemory),
            usedCpu: `${metrics.usedCpu.toFixed(2)} cores`,
            usedMemory: this.formatBytes(metrics.usedMemory)
        };
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) { return '0 B'; }
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
    }

    // Custom Resource Definitions
    public async getCRDs(): Promise<k8s.V1CustomResourceDefinition[]> {
        return this.cluster.getCRDs();
    }

    public async getCustomResources(group: string, version: string, plural: string, namespace?: string): Promise<any[]> {
        return this.cluster.getCustomResources(group, version, plural, namespace);
    }

    public async deleteCustomResource(group: string, version: string, plural: string, name: string, namespace?: string): Promise<void> {
        return this.cluster.deleteCustomResource(group, version, plural, name, namespace);
    }

    // ==================== RBAC DELEGATION ====================
    public async getRoles(namespace?: string): Promise<k8s.V1Role[]> {
        return this.rbac.getRoles(namespace);
    }

    public async getClusterRoles(): Promise<k8s.V1ClusterRole[]> {
        return this.rbac.getClusterRoles();
    }

    public async getRoleBindings(namespace?: string): Promise<k8s.V1RoleBinding[]> {
        return this.rbac.getRoleBindings(namespace);
    }

    public async getClusterRoleBindings(): Promise<k8s.V1ClusterRoleBinding[]> {
        return this.rbac.getClusterRoleBindings();
    }

    public async getServiceAccounts(namespace?: string): Promise<k8s.V1ServiceAccount[]> {
        return this.config.getServiceAccounts(namespace);
    }

    // Job and CronJob methods
    public async getJobs(namespace?: string): Promise<k8s.V1Job[]> {
        return this.workloads.getJobs(namespace);
    }

    public async getCronJobs(namespace?: string): Promise<k8s.V1CronJob[]> {
        return this.workloads.getCronJobs(namespace);
    }

    public async deleteJob(name: string, namespace: string): Promise<void> {
        return this.workloads.deleteJob(name, namespace);
    }

    public async triggerCronJob(cronJobName: string, namespace: string): Promise<void> {
        return this.workloads.triggerCronJob(cronJobName, namespace);
    }

    public async toggleCronJobSuspend(name: string, namespace: string, suspend: boolean): Promise<void> {
        return this.workloads.toggleCronJobSuspend(name, namespace, suspend);
    }

    // Namespace management methods
    public async createNamespace(name: string, labels?: { [key: string]: string }): Promise<void> {
        const namespace: k8s.V1Namespace = {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
                name: name,
                labels: labels || {}
            }
        };
        await this.config.createNamespace(namespace);
    }

    public async deleteNamespace(name: string): Promise<void> {
        return this.config.deleteNamespace(name);
    }

    public async getConfigMaps(namespace?: string): Promise<k8s.V1ConfigMap[]> {
        return this.config.getConfigMaps(namespace);
    }

    public async getSecrets(namespace?: string): Promise<k8s.V1Secret[]> {
        return this.config.getSecrets(namespace);
    }

    public async getSecret(name: string, namespace: string): Promise<k8s.V1Secret | null> {
        try {
            return await this.config.getSecret(name, namespace);
        } catch (error) {
            console.error('Failed to fetch secret:', error);
            return null;
        }
    }

    public async updateConfigMap(name: string, namespace: string, configMap: k8s.V1ConfigMap): Promise<void> {
        await this.config.updateConfigMap(name, namespace, configMap);
    }

    public async updateSecret(name: string, namespace: string, secret: k8s.V1Secret): Promise<void> {
        await this.config.updateSecret(name, namespace, secret);
    }

    public async cordonNode(nodeName: string): Promise<void> {
        return this.cluster.cordonNode(nodeName);
    }

    public async uncordonNode(nodeName: string): Promise<void> {
        return this.cluster.uncordonNode(nodeName);
    }

    public async drainNode(nodeName: string): Promise<void> {
        return this.cluster.drainNode(nodeName);
    }

    public async getNetworkPolicies(namespace?: string): Promise<k8s.V1NetworkPolicy[]> {
        return this.network.getNetworkPolicies(namespace);
    }

    public async deleteNetworkPolicy(name: string, namespace: string): Promise<void> {
        return this.network.deleteNetworkPolicy(name, namespace);
    }

    public async createNetworkPolicy(namespace: string, policy: k8s.V1NetworkPolicy): Promise<void> {
        await this.network.createNetworkPolicy(namespace, policy);
    }

    public async getResourceQuotas(namespace?: string): Promise<k8s.V1ResourceQuota[]> {
        // Implemented locally as not in ConfigClient
        return this.cluster.getResourceQuotas(namespace);
    }

    public async deleteResourceQuota(name: string, namespace: string): Promise<void> {
        return this.cluster.deleteResourceQuota(name, namespace);
    }

    public async getLimitRanges(namespace?: string): Promise<k8s.V1LimitRange[]> {
        return this.cluster.getLimitRanges(namespace);
    }

    public async deleteLimitRange(name: string, namespace: string): Promise<void> {
        return this.cluster.deleteLimitRange(name, namespace);
    }

    // HorizontalPodAutoscalers
    public async getHPAs(namespace?: string): Promise<k8s.V2HorizontalPodAutoscaler[]> {
        return this.cluster.getHPAs(namespace);
    }

    public async deleteHPA(name: string, namespace: string): Promise<void> {
        return this.cluster.deleteHPA(name, namespace);
    }

    // Pod Disruption Budgets
    public async getPodDisruptionBudgets(namespace?: string): Promise<k8s.V1PodDisruptionBudget[]> {
        return this.cluster.getPodDisruptionBudgets(namespace);
    }

    public async deletePodDisruptionBudget(name: string, namespace: string): Promise<void> {
        return this.cluster.deletePodDisruptionBudget(name, namespace);
    }

    public async scaleDeployment(name: string, namespace: string, replicas: number): Promise<void> {
        return this.workloads.scaleDeployment(name, namespace, replicas);
    }

    // Deployment Rollout Management
    public async getReplicaSets(namespace?: string): Promise<k8s.V1ReplicaSet[]> {
        return this.workloads.getReplicaSets(namespace);
    }

    // Keep rollback, pause, resume methods as they require coordination
    public async rollbackDeployment(
        name: string,
        namespace: string,
        revision: number
    ): Promise<void> {
        try {
            // Get the ReplicaSet with the target revision
            const replicaSets = await this.getReplicaSets(namespace);
            const targetRS = replicaSets.find(rs => {
                const ownerRefs = rs.metadata?.ownerReferences || [];
                const isOwnedByDeployment = ownerRefs.some(
                    ref => ref.kind === 'Deployment' && ref.name === name
                );
                const rsRevision = parseInt(
                    rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '0'
                );
                return isOwnedByDeployment && rsRevision === revision;
            });

            if (!targetRS || !targetRS.spec?.template) {
                throw new Error(`Revision ${revision} not found`);
            }

            // Update deployment with the target template
            const deployment = await this.appsApi.readNamespacedDeployment(name, namespace);
            if (deployment.body.spec) {
                deployment.body.spec.template = targetRS.spec.template;
                
                // Add annotation to track rollback
                if (!deployment.body.metadata) {
                    deployment.body.metadata = {};
                }
                if (!deployment.body.metadata.annotations) {
                    deployment.body.metadata.annotations = {};
                }
                deployment.body.metadata.annotations['kubernetes.io/change-cause'] = 
                    `Rolled back to revision ${revision}`;

                await this.appsApi.replaceNamespacedDeployment(
                    name,
                    namespace,
                    deployment.body
                );
            }
        } catch (error) {
            console.error('Failed to rollback deployment:', error);
            throw error;
        }
    }

    public async pauseDeployment(name: string, namespace: string): Promise<void> {
        try {
            const patch = { spec: { paused: true } };
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
        } catch (error) {
            console.error('Failed to pause deployment:', error);
            throw error;
        }
    }

    public async resumeDeployment(name: string, namespace: string): Promise<void> {
        try {
            const patch = { spec: { paused: false } };
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
        } catch (error) {
            console.error('Failed to resume deployment:', error);
            throw error;
        }
    }

    public async restartDeployment(name: string, namespace: string): Promise<void> {
        return this.workloads.restartDeployment(name, namespace);
    }
}