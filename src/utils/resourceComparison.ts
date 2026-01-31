import * as yaml from 'js-yaml';
import { K8sClient } from './k8sClient';
import { KubeconfigManager } from './kubeconfig';

export interface ComparisonResult {
    leftResource: Record<string, unknown>;
    rightResource: Record<string, unknown>;
    differences: Difference[];
    summary: ComparisonSummary;
}

export interface Difference {
    path: string;
    leftValue: unknown;
    rightValue: unknown;
    type: 'added' | 'removed' | 'modified';
}

export interface ComparisonSummary {
    totalDifferences: number;
    added: number;
    removed: number;
    modified: number;
}

export class ResourceComparison {
    private k8sClient: K8sClient;
    private kubeconfigManager: KubeconfigManager;

    constructor(k8sClient: K8sClient, kubeconfigManager: KubeconfigManager) {
        this.k8sClient = k8sClient;
        this.kubeconfigManager = kubeconfigManager;
    }

    /**
     * Compare two resources and return detailed differences
     */
    public async compareResources(
        left: { name: string; namespace: string; kind: string; context?: string },
        right: { name: string; namespace: string; kind: string; context?: string }
    ): Promise<ComparisonResult> {
        // Fetch both resources
        const leftResource = await this.fetchResource(left.kind, left.name, left.namespace, left.context);
        const rightResource = await this.fetchResource(right.kind, right.name, right.namespace, right.context);

        // Clean resources for comparison (remove runtime fields)
        const cleanLeft = this.cleanResource(leftResource);
        const cleanRight = this.cleanResource(rightResource);

        // Find differences
        const differences = this.findDifferences(cleanLeft, cleanRight);

        // Generate summary
        const summary = this.generateSummary(differences);

        return {
            leftResource: cleanLeft,
            rightResource: cleanRight,
            differences,
            summary
        };
    }

    /**
     * Compare a resource with its previous revision (for Deployments, StatefulSets, etc.)
     */
    public async compareWithPreviousRevision(
        kind: string,
        name: string,
        namespace: string,
        revision?: number
    ): Promise<ComparisonResult> {
        const current = await this.fetchResource(kind, name, namespace);
        
        // For resources that support revisions (Deployments, StatefulSets, DaemonSets)
        if (kind === 'Deployment') {
            const previousRevision = await this.fetchPreviousDeploymentRevision(name, namespace, revision);
            const cleanCurrent = this.cleanResource(current);
            const cleanPrevious = this.cleanResource(previousRevision);
            
            const differences = this.findDifferences(cleanPrevious, cleanCurrent);
            const summary = this.generateSummary(differences);

            return {
                leftResource: cleanPrevious,
                rightResource: cleanCurrent,
                differences,
                summary
            };
        }

        throw new Error(`Revision comparison not supported for ${kind}`);
    }

    /**
     * Compare resources across different namespaces in the same cluster
     */
    public async compareAcrossNamespaces(
        kind: string,
        name: string,
        namespaceLeft: string,
        namespaceRight: string
    ): Promise<ComparisonResult> {
        const leftResource = await this.fetchResource(kind, name, namespaceLeft);
        const rightResource = await this.fetchResource(kind, name, namespaceRight);

        const cleanLeft = this.cleanResource(leftResource);
        const cleanRight = this.cleanResource(rightResource);

        const differences = this.findDifferences(cleanLeft, cleanRight);
        const summary = this.generateSummary(differences);

        return {
            leftResource: cleanLeft,
            rightResource: cleanRight,
            differences,
            summary
        };
    }

    /**
     * Compare the same resource across different clusters
     */
    public async compareAcrossClusters(
        kind: string,
        name: string,
        namespace: string,
        contextLeft: string,
        contextRight: string
    ): Promise<ComparisonResult> {
        const leftResource = await this.fetchResource(kind, name, namespace, contextLeft);
        const rightResource = await this.fetchResource(kind, name, namespace, contextRight);

        const cleanLeft = this.cleanResource(leftResource);
        const cleanRight = this.cleanResource(rightResource);

        const differences = this.findDifferences(cleanLeft, cleanRight);
        const summary = this.generateSummary(differences);

        return {
            leftResource: cleanLeft,
            rightResource: cleanRight,
            differences,
            summary
        };
    }

    /**
     * Fetch a resource from the cluster using kubectl-based approach
     */
    private async fetchResource(kind: string, name: string, namespace: string, context?: string): Promise<Record<string, unknown>> {
        const previousContext = context ? this.kubeconfigManager.getCurrentContext() : undefined;
        
        try {
            if (context && previousContext !== context) {
                await this.kubeconfigManager.setCurrentContext(context);
                this.k8sClient.refresh();
            }

            // Use existing K8sClient methods
            let resource: Record<string, unknown>;

            switch (kind.toLowerCase()) {
                case 'deployment': {
                    const deployments = await this.k8sClient.getDeployments(namespace);
                    const deployment = deployments.find(d => d.metadata?.name === name);
                    if (!deployment) {
                        throw new Error(`Deployment ${name} not found`);
                    }
                    resource = deployment as unknown as Record<string, unknown>;
                    break;
                }
                case 'statefulset': {
                    const statefulsets = await this.k8sClient.getStatefulSets(namespace);
                    const statefulset = statefulsets.find(s => s.metadata?.name === name);
                    if (!statefulset) {
                        throw new Error(`StatefulSet ${name} not found`);
                    }
                    resource = statefulset as unknown as Record<string, unknown>;
                    break;
                }
                case 'daemonset': {
                    const daemonsets = await this.k8sClient.getDaemonSets(namespace);
                    const daemonset = daemonsets.find(d => d.metadata?.name === name);
                    if (!daemonset) {
                        throw new Error(`DaemonSet ${name} not found`);
                    }
                    resource = daemonset as unknown as Record<string, unknown>;
                    break;
                }
                case 'service': {
                    const services = await this.k8sClient.getServices(namespace);
                    const service = services.find(s => s.metadata?.name === name);
                    if (!service) {
                        throw new Error(`Service ${name} not found`);
                    }
                    resource = service as unknown as Record<string, unknown>;
                    break;
                }
                case 'configmap': {
                    const configmaps = await this.k8sClient.getConfigMaps(namespace);
                    const configmap = configmaps.find(c => c.metadata?.name === name);
                    if (!configmap) {
                        throw new Error(`ConfigMap ${name} not found`);
                    }
                    resource = configmap as unknown as Record<string, unknown>;
                    break;
                }
                case 'secret': {
                    const secrets = await this.k8sClient.getSecrets(namespace);
                    const secret = secrets.find(s => s.metadata?.name === name);
                    if (!secret) {
                        throw new Error(`Secret ${name} not found`);
                    }
                    resource = secret as unknown as Record<string, unknown>;
                    break;
                }
                case 'pod': {
                    const pods = await this.k8sClient.getPods(namespace);
                    const pod = pods.find(p => p.metadata?.name === name);
                    if (!pod) {
                        throw new Error(`Pod ${name} not found`);
                    }
                    resource = pod as unknown as Record<string, unknown>;
                    break;
                }
                case 'job': {
                    const jobs = await this.k8sClient.getJobs(namespace);
                    const job = jobs.find(j => j.metadata?.name === name);
                    if (!job) {
                        throw new Error(`Job ${name} not found`);
                    }
                    resource = job as unknown as Record<string, unknown>;
                    break;                }                default:
                    throw new Error(`Unsupported resource kind: ${kind}`);
            }

            return resource;
        } finally {
            if (context && previousContext && previousContext !== context) {
                await this.kubeconfigManager.setCurrentContext(previousContext);
                this.k8sClient.refresh();
            }
        }
    }

    /**
     * Fetch previous revision of a Deployment (simplified - returns current for now)
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private async fetchPreviousDeploymentRevision(name: string, namespace: string, _revision?: number): Promise<Record<string, unknown>> {
        // For now, just return current deployment
        // Full implementation would require accessing ReplicaSet history
        const deployments = await this.k8sClient.getDeployments(namespace);
        const deployment = deployments.find(d => d.metadata?.name === name);
        if (!deployment) {
            throw new Error(`Deployment ${name} not found`);
        }
        return deployment as unknown as Record<string, unknown>;
    }

    /**
     * Remove runtime and system fields that shouldn't be compared
     */
    private cleanResource(resource: Record<string, unknown>): Record<string, unknown> {
        const cleaned = JSON.parse(JSON.stringify(resource)) as Record<string, unknown>;

        // Remove metadata fields that change frequently
        if (cleaned.metadata && typeof cleaned.metadata === 'object') {
            const metadata = cleaned.metadata as Record<string, unknown>;
            delete metadata.uid;
            delete metadata.resourceVersion;
            delete metadata.generation;
            delete metadata.creationTimestamp;
            delete metadata.selfLink;
            delete metadata.managedFields;
            
            // Remove annotations that are auto-generated
            if (metadata.annotations && typeof metadata.annotations === 'object') {
                const annotations = metadata.annotations as Record<string, unknown>;
                delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
                delete annotations['deployment.kubernetes.io/revision'];
            }
        }

        // Remove status (runtime state)
        delete cleaned.status;

        return cleaned;
    }

    /**
     * Find all differences between two objects
     */
    private findDifferences(left: unknown, right: unknown, path: string = ''): Difference[] {
        const differences: Difference[] = [];

        // Handle null/undefined cases
        if (left === null || left === undefined) {
            if (right !== null && right !== undefined) {
                differences.push({
                    path: path || 'root',
                    leftValue: left,
                    rightValue: right,
                    type: 'added'
                });
            }
            return differences;
        }

        if (right === null || right === undefined) {
            differences.push({
                path: path || 'root',
                leftValue: left,
                rightValue: right,
                type: 'removed'
            });
            return differences;
        }

        // Handle primitive types
        if (typeof left !== 'object' || typeof right !== 'object') {
            if (left !== right) {
                differences.push({
                    path: path || 'value',
                    leftValue: left,
                    rightValue: right,
                    type: 'modified'
                });
            }
            return differences;
        }

        // Handle arrays
        if (Array.isArray(left) && Array.isArray(right)) {
            const maxLength = Math.max(left.length, right.length);
            for (let i = 0; i < maxLength; i++) {
                const currentPath = `${path}[${i}]`;
                if (i >= left.length) {
                    differences.push({
                        path: currentPath,
                        leftValue: undefined,
                        rightValue: right[i],
                        type: 'added'
                    });
                } else if (i >= right.length) {
                    differences.push({
                        path: currentPath,
                        leftValue: left[i],
                        rightValue: undefined,
                        type: 'removed'
                    });
                } else {
                    differences.push(...this.findDifferences(left[i], right[i], currentPath));
                }
            }
            return differences;
        }

        // Handle objects
        const leftObj = left as Record<string, unknown>;
        const rightObj = right as Record<string, unknown>;
        const allKeys = new Set([...Object.keys(leftObj), ...Object.keys(rightObj)]);
        
        for (const key of allKeys) {
            const currentPath = path ? `${path}.${key}` : key;
            
            if (!(key in leftObj)) {
                differences.push({
                    path: currentPath,
                    leftValue: undefined,
                    rightValue: rightObj[key],
                    type: 'added'
                });
            } else if (!(key in rightObj)) {
                differences.push({
                    path: currentPath,
                    leftValue: leftObj[key],
                    rightValue: undefined,
                    type: 'removed'
                });
            } else {
                differences.push(...this.findDifferences(leftObj[key], rightObj[key], currentPath));
            }
        }

        return differences;
    }

    /**
     * Generate summary statistics from differences
     */
    private generateSummary(differences: Difference[]): ComparisonSummary {
        const summary: ComparisonSummary = {
            totalDifferences: differences.length,
            added: 0,
            removed: 0,
            modified: 0
        };

        for (const diff of differences) {
            switch (diff.type) {
                case 'added':
                    summary.added++;
                    break;
                case 'removed':
                    summary.removed++;
                    break;
                case 'modified':
                    summary.modified++;
                    break;
            }
        }

        return summary;
    }

    /**
     * Format comparison result as a unified diff string
     */
    public formatAsUnifiedDiff(result: ComparisonResult, leftLabel: string, rightLabel: string): string {
        const leftYaml = yaml.dump(result.leftResource, { indent: 2, lineWidth: -1 });
        const rightYaml = yaml.dump(result.rightResource, { indent: 2, lineWidth: -1 });

        const leftLines = leftYaml.split('\n');
        const rightLines = rightYaml.split('\n');

        let diff = `--- ${leftLabel}\n+++ ${rightLabel}\n`;

        const maxLines = Math.max(leftLines.length, rightLines.length);
        for (let i = 0; i < maxLines; i++) {
            const leftLine = leftLines[i] || '';
            const rightLine = rightLines[i] || '';

            if (leftLine !== rightLine) {
                if (leftLine) {
                    diff += `- ${leftLine}\n`;
                }
                if (rightLine) {
                    diff += `+ ${rightLine}\n`;
                }
            } else {
                diff += `  ${leftLine}\n`;
            }
        }

        return diff;
    }

    /**
     * Export comparison result as JSON
     */
    public exportAsJson(result: ComparisonResult): string {
        return JSON.stringify(result, null, 2);
    }
}
