import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';
import * as k8s from '@kubernetes/client-node';
import { BaseTreeProvider } from './baseProvider';
import { WatchPaths } from '../utils/watch';
import { logger } from '../utils/logger';

export class NamespaceItem extends vscode.TreeItem {
    constructor(
        public readonly namespace: k8s.V1Namespace,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(namespace.metadata?.name || 'unknown', collapsibleState);
        this.id = `namespace-${namespace.metadata?.uid || namespace.metadata?.name || Math.random()}`;
        this.contextValue = 'namespace';
        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.blue'));
    }

    private getTooltip(): string {
        const name = this.namespace.metadata?.name || 'unknown';
        const status = this.namespace.status?.phase || 'Unknown';
        const created = this.namespace.metadata?.creationTimestamp;
        return `Namespace: ${name}\nStatus: ${status}\nCreated: ${created || 'Unknown'}`;
    }

    private getDescription(): string {
        const status = this.namespace.status?.phase;
        if (status === 'Terminating') {
            return '⏳ Terminating';
        }
        return '';
    }
}

export class NamespaceProvider extends BaseTreeProvider<NamespaceItem> {
    private watchEnabled: boolean = false;

    constructor(private k8sClient: K8sClient) {
        super();
    }

    /**
     * Enable real-time watch for namespace changes
     */
    public enableWatch(): void {
        if (this.watchEnabled) {
            return;
        }

        try {
            const kubeconfig = this.k8sClient.getKubeConfig();
            this.startWatch<k8s.V1Namespace>(kubeconfig, WatchPaths.namespaces());
            this.watchEnabled = true;
            logger.info('Namespace watch enabled');
        } catch (error) {
            logger.error('Failed to enable namespace watch', error);
        }
    }

    /**
     * Disable real-time watch
     */
    public disableWatch(): void {
        this.stopAllWatches();
        this.watchEnabled = false;
        logger.info('Namespace watch disabled');
    }

    getTreeItem(element: NamespaceItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: NamespaceItem): Promise<NamespaceItem[]> {
        if (!element) {
            try {
                const namespaces = await this.k8sClient.getNamespaces();
                return namespaces.map(ns => new NamespaceItem(ns));
            } catch (error) {
                logger.error('Error fetching namespaces', error);
                return [];
            }
        }
        return [];
    }
}
