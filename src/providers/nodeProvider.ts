import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';
import { BaseTreeProvider } from './baseProvider';
import { WatchPaths } from '../utils/watch';
import { logger } from '../utils/logger';

export class NodeItem extends vscode.TreeItem {
    constructor(
        public readonly node: k8s.V1Node,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(node.metadata?.name || 'unknown', collapsibleState);
        this.id = `node-${node.metadata?.uid || node.metadata?.name || Math.random()}`;
        this.contextValue = 'node';
        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.iconPath = this.getIcon();
    }

    private getTooltip(): string {
        const name = this.node.metadata?.name || 'unknown';
        const ready = this.isReady() ? 'Ready' : 'Not Ready';
        const version = this.node.status?.nodeInfo?.kubeletVersion || 'Unknown';
        const os = this.node.status?.nodeInfo?.osImage || 'Unknown';
        
        return `Node: ${name}\nStatus: ${ready}\nKubelet: ${version}\nOS: ${os}`;
    }

    private getDescription(): string {
        const parts: string[] = [];
        
        if (!this.isReady()) {
            parts.push('⚠️ Not Ready');
        }
        
        if (this.isUnschedulable()) {
            parts.push('🚫 Unschedulable');
        }
        
        const role = this.getRole();
        if (role) {
            parts.push(role);
        }
        
        return parts.join(' | ');
    }

    private getIcon(): vscode.ThemeIcon {
        if (!this.isReady()) {
            return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        }
        
        if (this.isUnschedulable()) {
            return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.orange'));
        }
        
        return new vscode.ThemeIcon('vm', new vscode.ThemeColor('testing.iconPassed'));
    }

    private isReady(): boolean {
        const conditions = this.node.status?.conditions || [];
        const readyCondition = conditions.find(c => c.type === 'Ready');
        return readyCondition?.status === 'True';
    }

    private isUnschedulable(): boolean {
        return this.node.spec?.unschedulable === true;
    }

    private getRole(): string {
        const labels = this.node.metadata?.labels || {};
        
        if (labels['node-role.kubernetes.io/master'] || labels['node-role.kubernetes.io/control-plane']) {
            return 'Control Plane';
        }
        
        const roleKeys = Object.keys(labels).filter(k => k.startsWith('node-role.kubernetes.io/'));
        if (roleKeys.length > 0) {
            return roleKeys[0].replace('node-role.kubernetes.io/', '');
        }
        
        return 'Worker';
    }
}

export class NodeProvider extends BaseTreeProvider<NodeItem> {
    private watchEnabled: boolean = false;

    constructor(private k8sClient: K8sClient) {
        super();
    }

    /**
     * Enable real-time watch for node changes
     */
    public enableWatch(): void {
        if (this.watchEnabled) {
            return;
        }

        try {
            const kubeconfig = this.k8sClient.getKubeConfig();
            this.startWatch<k8s.V1Node>(kubeconfig, WatchPaths.nodes());
            this.watchEnabled = true;
            logger.info('Node watch enabled');
        } catch (error) {
            logger.error('Failed to enable node watch', error);
        }
    }

    /**
     * Disable real-time watch
     */
    public disableWatch(): void {
        this.stopAllWatches();
        this.watchEnabled = false;
        logger.info('Node watch disabled');
    }

    getTreeItem(element: NodeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: NodeItem): Promise<NodeItem[]> {
        if (!element) {
            try {
                const nodes = await this.k8sClient.getNodes();
                return nodes.map(node => new NodeItem(node));
            } catch (error) {
                logger.error('Error fetching nodes', error);
                return [];
            }
        }
        return [];
    }
}
