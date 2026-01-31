import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';
import * as k8s from '@kubernetes/client-node';

export class CRDProvider implements vscode.TreeDataProvider<CRDItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<CRDItem | undefined | null | void> = 
        new vscode.EventEmitter<CRDItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<CRDItem | undefined | null | void> = 
        this._onDidChangeTreeData.event;

    constructor(private k8sClient: K8sClient) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: CRDItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: CRDItem): Promise<CRDItem[]> {
        try {
            if (!element) {
                // Return list of CRDs
                const crds = await this.k8sClient.getCRDs();
                return crds.map(crd => new CRDItem(
                    crd.metadata?.name || 'unknown',
                    crd.spec?.names?.plural || crd.metadata?.name || 'unknown',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'crd',
                    crd
                ));
            } else if (element.type === 'crd') {
                // Return list of custom resource instances
                const crd = element.resource as k8s.V1CustomResourceDefinition;
                const group = crd.spec?.group || '';
                const version = crd.spec?.versions?.[0]?.name || '';
                const plural = crd.spec?.names?.plural || '';
                const scope = crd.spec?.scope || 'Namespaced';

                if (!group || !version || !plural) {
                    return [];
                }

                const resources = scope === 'Namespaced'
                    ? await this.k8sClient.getCustomResources(group, version, plural)
                    : await this.k8sClient.getCustomResources(group, version, plural);

                return resources.map((resource: any) => new CRDItem(
                    resource.metadata?.name || 'unknown',
                    resource.metadata?.name || 'unknown',
                    vscode.TreeItemCollapsibleState.None,
                    'customresource',
                    resource,
                    element.resource as k8s.V1CustomResourceDefinition
                ));
            }
        } catch (error) {
            console.error('Failed to load CRDs:', error);
            return [];
        }
        return [];
    }
}

export class CRDItem extends vscode.TreeItem {
    public readonly resourceKind: string;
    
    constructor(
        public readonly id: string,
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: string,
        public readonly resource: any,
        public readonly crd?: k8s.V1CustomResourceDefinition
    ) {
        super(label, collapsibleState);
        
        // Set contextValue to match menu patterns
        if (type === 'crd') {
            this.contextValue = 'crd';
            this.resourceKind = 'CustomResourceDefinition';
        } else {
            this.contextValue = 'customresource';
            this.resourceKind = 'CustomResource';
        }
        
        this.tooltip = `${type}: ${id}`;
        
        if (type === 'crd') {
            this.iconPath = new vscode.ThemeIcon('extensions');
            const crdResource = resource as k8s.V1CustomResourceDefinition;
            const kind = crdResource.spec?.names?.kind || '';
            const group = crdResource.spec?.group || '';
            this.description = `${kind} (${group})`;
        } else {
            this.iconPath = new vscode.ThemeIcon('symbol-class');
            this.description = resource.metadata?.namespace || 'cluster-wide';
        }
    }
}
