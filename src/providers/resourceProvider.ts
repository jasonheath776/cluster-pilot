import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';
import { logger } from '../utils/logger';
import { BaseTreeProvider } from './baseProvider';

export type ResourceCategory = 'workloads' | 'config' | 'network' | 'storage';

export class ResourceProvider extends BaseTreeProvider<ResourceItem> {
    private namespaceFilter: string | undefined;

    constructor(
        private k8sClient: K8sClient,
        private category: ResourceCategory
    ) {
        super();
        // Enable progressive loading for large resource lists
        this.enableProgressiveLoading(100);
    }

    public override setTreeView(treeView: vscode.TreeView<ResourceItem>): void {
        super.setTreeView(treeView);
    }

    setNamespaceFilter(namespace: string | undefined): void {
        this.namespaceFilter = namespace;
        this.refresh();
    }

    getNamespaceFilter(): string | undefined {
        return this.namespaceFilter;
    }

    protected override getElementId(element: ResourceItem): string | undefined {
        return element.id;
    }

    getTreeItem(element: ResourceItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ResourceItem): Promise<ResourceItem[]> {
        // Handle load more button
        if (element?.contextValue === 'loadMore') {
            return [];
        }
        
        if (!element) {
            // Return resource types based on category
            return this.getResourceTypes();
        } else if (element.type === 'resourceType') {
            // Return actual resources with progressive loading and filtering
            const resources = await this.getResources(element.resourceKind!);
            const filtered = this.applyFilter(resources);
            const paginated = this.applyProgressiveLoading(filtered, element.resourceKind!);
            return paginated;
        }
        
        return [];
    }

    private getResourceTypes(): ResourceItem[] {
        switch (this.category) {
            case 'workloads':
                return [
                    new ResourceItem('Pods', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'pod', undefined, `${this.category}-pod`),
                    new ResourceItem('Deployments', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'deployment', undefined, `${this.category}-deployment`),
                    new ResourceItem('StatefulSets', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'statefulset', undefined, `${this.category}-statefulset`),
                    new ResourceItem('DaemonSets', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'daemonset', undefined, `${this.category}-daemonset`),
                    new ResourceItem('Jobs', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'job', undefined, `${this.category}-job`)
                ];
            case 'config':
                return [
                    new ResourceItem('ConfigMaps', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'configmap', undefined, `${this.category}-configmap`),
                    new ResourceItem('Secrets', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'secret', undefined, `${this.category}-secret`)
                ];
            case 'network':
                return [
                    new ResourceItem('Services', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'service', undefined, `${this.category}-service`),
                    new ResourceItem('Ingresses', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'ingress', undefined, `${this.category}-ingress`)
                ];
            case 'storage':
                return [
                    new ResourceItem('PersistentVolumes', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'persistentvolume', undefined, `${this.category}-persistentvolume`),
                    new ResourceItem('PersistentVolumeClaims', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'persistentvolumeclaim', undefined, `${this.category}-persistentvolumeclaim`),
                    new ResourceItem('StorageClasses', vscode.TreeItemCollapsibleState.Collapsed, 'resourceType', 'storageclass', undefined, `${this.category}-storageclass`)
                ];
            default:
                return [];
        }
    }

    private async getResources(kind: string): Promise<ResourceItem[]> {
        try {
            let resources: k8s.KubernetesObject[] = [];
            
            switch (kind) {
                case 'pod':
                    resources = await this.k8sClient.getPods(this.namespaceFilter);
                    break;
                case 'deployment':
                    resources = await this.k8sClient.getDeployments(this.namespaceFilter);
                    break;
                case 'statefulset':
                    resources = await this.k8sClient.getStatefulSets(this.namespaceFilter);
                    break;
                case 'daemonset':
                    resources = await this.k8sClient.getDaemonSets(this.namespaceFilter);
                    break;
                case 'job':
                    resources = await this.k8sClient.getJobs(this.namespaceFilter);
                    break;
                case 'service':
                    resources = await this.k8sClient.getServices(this.namespaceFilter);
                    break;
                case 'ingress':
                    resources = await this.k8sClient.getIngresses(this.namespaceFilter);
                    break;
                case 'configmap':
                    resources = await this.k8sClient.getConfigMaps(this.namespaceFilter);
                    break;
                case 'secret':
                    resources = await this.k8sClient.getSecrets(this.namespaceFilter);
                    break;
                case 'persistentvolume':
                    resources = await this.k8sClient.getPersistentVolumes();
                    break;
                case 'persistentvolumeclaim':
                    resources = await this.k8sClient.getPersistentVolumeClaims(this.namespaceFilter);
                    break;
                case 'storageclass':
                    resources = await this.k8sClient.getStorageClasses();
                    break;
            }

            // Filter by namespace if set
            if (this.namespaceFilter && resources.length > 0) {
                resources = resources.filter(r => r.metadata?.namespace === this.namespaceFilter);
            }

            return resources.map(resource => {
                const name = resource.metadata?.name || 'unknown';
                const namespace = resource.metadata?.namespace;
                const label = namespace ? `${name} (${namespace})` : name;
                
                return new ResourceItem(
                    label,
                    vscode.TreeItemCollapsibleState.None,
                    kind,
                    kind,
                    resource
                );
            });
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`Error fetching ${kind} resources`, error);
            
            // Show user-friendly error message
            vscode.window.showErrorMessage(`Failed to load ${kind} resources: ${errorMessage}`);
            
            return [new ResourceItem(
                'Error loading resources',
                vscode.TreeItemCollapsibleState.None,
                'error',
                kind
            )];
        }
    }
}

export class ResourceItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: string,
        public readonly resourceKind?: string,
        public readonly resource?: k8s.KubernetesObject,
        stableId?: string
    ) {
        super(label, collapsibleState);
        
        // Use provided stable ID or create one based on resource metadata
        if (stableId) {
            this.id = stableId;
        } else if (resource?.metadata?.uid) {
            this.id = `resource-${resource.metadata.uid}`;
        } else if (resource?.metadata?.name && resource?.metadata?.namespace) {
            this.id = `resource-${resourceKind}-${resource.metadata.namespace}-${resource.metadata.name}`;
        } else if (resource?.metadata?.name) {
            this.id = `resource-${resourceKind}-${resource.metadata.name}`;
        } else {
            this.id = `resource-${type}-${label}`;
        }
        
        this.contextValue = type;
        this.tooltip = this.createTooltip();
        this.iconPath = this.getIcon();
    }

    private createTooltip(): string {
        if (this.resource) {
            const name = this.resource.metadata?.name;
            const namespace = this.resource.metadata?.namespace;
            const status = this.getResourceStatus();
            
            let tooltip = `${this.resourceKind}: ${name}`;
            if (namespace) {
                tooltip += `\nNamespace: ${namespace}`;
            }
            if (status) {
                tooltip += `\nStatus: ${status}`;
            }
            
            return tooltip;
        }
        return this.label;
    }

    private getResourceStatus(): string | undefined {
        if (!this.resource) {
            return undefined;
        }

        const resource = this.resource as any;
        switch (this.resourceKind) {
            case 'pod':
                return resource.status?.phase;
            case 'deployment':
                const desired = resource.spec?.replicas || 0;
                const ready = resource.status?.readyReplicas || 0;
                return `${ready}/${desired}`;
            default:
                return undefined;
        }
    }

    private getIcon(): vscode.ThemeIcon {
        switch (this.resourceKind) {
            case 'pod':
                return new vscode.ThemeIcon('symbol-package');
            case 'deployment':
                return new vscode.ThemeIcon('layers');
            case 'service':
                return new vscode.ThemeIcon('globe');
            case 'configmap':
                return new vscode.ThemeIcon('file-code');
            case 'secret':
                return new vscode.ThemeIcon('lock');
            case 'persistentvolume':
            case 'persistentvolumeclaim':
                return new vscode.ThemeIcon('database');
            default:
                return new vscode.ThemeIcon('symbol-class');
        }
    }
}
