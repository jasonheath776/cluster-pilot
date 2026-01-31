import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { KubeconfigManager } from '../utils/kubeconfig';
import { K8sClient } from '../utils/k8sClient';
import { isClusterMetricsEnabled } from '../commands';
import { BaseTreeProvider } from './baseProvider';

export class ClusterProvider extends BaseTreeProvider<ClusterItem> {
    constructor(
        private kubeconfigManager: KubeconfigManager,
        private k8sClient: K8sClient,
        private context: vscode.ExtensionContext
    ) {
        super();
    }

    getTreeItem(element: ClusterItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ClusterItem): Promise<ClusterItem[]> {
        if (!element) {
            // Return list of contexts
            const contexts = this.kubeconfigManager.getContexts();
            const currentContext = this.kubeconfigManager.getCurrentContext();
            
            return contexts.map(ctx => {
                const isActive = ctx.name === currentContext;
                const metricsEnabled = isClusterMetricsEnabled(this.context, ctx.name);
                const metricsIndicator = metricsEnabled ? '📊 ' : '';
                const displayLabel = isActive ? '✓ ' + metricsIndicator + ctx.name : metricsIndicator + ctx.name;
                
                return new ClusterItem(
                    ctx.name,
                    displayLabel,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'context',
                    isActive
                );
            });
        } else if (element.type === 'context') {
            // Return namespaces for the context
            try {
                const namespaces = await this.k8sClient.getNamespaces();
                return namespaces.map(ns => new ClusterItem(
                    ns.metadata?.name || 'unknown',
                    ns.metadata?.name || 'unknown',
                    vscode.TreeItemCollapsibleState.None,
                    'namespace'
                ));
            } catch (error) {
                return [new ClusterItem(
                    'error',
                    'Failed to load namespaces',
                    vscode.TreeItemCollapsibleState.None,
                    'error'
                )];
            }
        }
        
        return [];
    }
}

export class ClusterItem extends vscode.TreeItem {
    constructor(
        public readonly id: string,
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: string,
        public readonly isActive: boolean = false
    ) {
        super(label, collapsibleState);
        
        this.contextValue = type;
        this.tooltip = `${type}: ${id}`;
        
        if (type === 'context') {
            this.iconPath = new vscode.ThemeIcon(isActive ? 'cloud' : 'cloud-outline');
        } else if (type === 'namespace') {
            this.iconPath = new vscode.ThemeIcon('folder');
        }
    }
}
