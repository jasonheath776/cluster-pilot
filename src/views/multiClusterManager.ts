import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';
import { KubeconfigManager } from '../utils/kubeconfig';

interface ClusterInfo {
    name: string;
    context: string;
    server: string;
    namespace: string;
    isActive: boolean;
    status: 'connected' | 'disconnected' | 'error' | 'checking';
    nodeCount?: number;
    podCount?: number;
    namespaceCount?: number;
    version?: string;
    lastChecked?: Date;
    error?: string;
}

export class MultiClusterManagerPanel {
    private static currentPanel: MultiClusterManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private k8sClient: K8sClient;
    private kubeconfigManager: KubeconfigManager;
    private clusters: Map<string, ClusterInfo> = new Map();
    private refreshInterval?: NodeJS.Timeout;

    private constructor(
        panel: vscode.WebviewPanel,
        k8sClient: K8sClient,
        kubeconfigManager: KubeconfigManager
    ) {
        this.panel = panel;
        this.k8sClient = k8sClient;
        this.kubeconfigManager = kubeconfigManager;

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'switchCluster':
                        await this.switchToCluster(message.context);
                        break;
                    case 'refreshCluster':
                        await this.refreshCluster(message.context);
                        break;
                    case 'refreshAll':
                        await this.refreshAllClusters();
                        break;
                    case 'addCluster':
                        await this.addCluster();
                        break;
                    case 'removeCluster':
                        await this.removeCluster(message.context);
                        break;
                    case 'compareAcrossClusters':
                        await this.compareAcrossClusters(message.contexts);
                        break;
                    case 'getClusterDetails':
                        await this.showClusterDetails(message.context);
                        break;
                    case 'showBackupManager':
                        await vscode.commands.executeCommand('clusterPilot.showBackupPanel');
                        break;
                }
            },
            null,
            this.disposables
        );

        // Auto-refresh every 30 seconds
        this.refreshInterval = setInterval(() => {
            this.refreshAllClusters();
        }, 30000);
    }

    public static async show(k8sClient: K8sClient, kubeconfigManager: KubeconfigManager) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (MultiClusterManagerPanel.currentPanel) {
            MultiClusterManagerPanel.currentPanel.panel.reveal(column);
            await MultiClusterManagerPanel.currentPanel.refreshAllClusters();
        } else {
            const panel = vscode.window.createWebviewPanel(
                'clusterPilot.multiClusterManager',
                'Multi-Cluster Manager',
                column || vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            MultiClusterManagerPanel.currentPanel = new MultiClusterManagerPanel(
                panel,
                k8sClient,
                kubeconfigManager
            );

            await MultiClusterManagerPanel.currentPanel.initialize();
        }
    }

    private async initialize() {
        await this.loadClusters();
        await this.refreshAllClusters();
        this.updateWebview();
    }

    private async loadClusters() {
        const contexts = this.kubeconfigManager.getContexts();
        const currentContext = this.kubeconfigManager.getCurrentContext();
        const kubeconfig = this.kubeconfigManager.getKubeConfig();

        for (const contextObj of contexts) {
            const contextName = contextObj.name;
            const cluster = contextObj.cluster ? kubeconfig.getCluster(contextObj.cluster) : null;

            this.clusters.set(contextName, {
                name: contextName,
                context: contextName,
                server: cluster?.server || 'unknown',
                namespace: contextObj.namespace || 'default',
                isActive: contextName === currentContext,
                status: 'checking'
            });
        }
    }

    private async refreshAllClusters() {
        const currentContext = this.kubeconfigManager.getCurrentContext();
        
        for (const [contextName, clusterInfo] of this.clusters.entries()) {
            try {
                // Switch to this context temporarily
                if (currentContext !== contextName) {
                    await this.kubeconfigManager.setCurrentContext(contextName);
                    this.k8sClient.refresh();
                }

                // Gather cluster information - don't catch errors here
                const [nodes, pods, namespaces] = await Promise.all([
                    this.k8sClient.getNodes(),
                    this.k8sClient.getPods(),
                    this.k8sClient.getNamespaces()
                ]);

                clusterInfo.status = 'connected';
                clusterInfo.nodeCount = nodes.length;
                clusterInfo.podCount = pods.length;
                clusterInfo.namespaceCount = namespaces.length;
                clusterInfo.version = nodes[0]?.status?.nodeInfo?.kubeletVersion;
                clusterInfo.lastChecked = new Date();
                clusterInfo.error = undefined;

            } catch (error) {
                clusterInfo.status = 'disconnected';
                clusterInfo.error = undefined;
                clusterInfo.lastChecked = new Date();
                clusterInfo.nodeCount = undefined;
                clusterInfo.podCount = undefined;
                clusterInfo.namespaceCount = undefined;
                clusterInfo.version = undefined;
            }
        }

        // Switch back to original context
        if (currentContext) {
            await this.kubeconfigManager.setCurrentContext(currentContext);
            this.k8sClient.refresh();
        }

        this.updateWebview();
        
        const connectedCount = Array.from(this.clusters.values()).filter(c => c.status === 'connected').length;
        const totalCount = this.clusters.size;
        vscode.window.showInformationMessage(`Refreshed all clusters: ${connectedCount}/${totalCount} connected`);
    }

    private async refreshCluster(contextName: string) {
        const clusterInfo = this.clusters.get(contextName);
        if (!clusterInfo) {
            return;
        }

        const currentContext = this.kubeconfigManager.getCurrentContext();

        try {
            await this.kubeconfigManager.setCurrentContext(contextName);
            this.k8sClient.refresh();

            const [nodes, pods, namespaces] = await Promise.all([
                this.k8sClient.getNodes(),
                this.k8sClient.getPods(),
                this.k8sClient.getNamespaces()
            ]);

            clusterInfo.status = 'connected';
            clusterInfo.nodeCount = nodes.length;
            clusterInfo.podCount = pods.length;
            clusterInfo.namespaceCount = namespaces.length;
            clusterInfo.version = nodes[0]?.status?.nodeInfo?.kubeletVersion;
            clusterInfo.lastChecked = new Date();
            clusterInfo.error = undefined;
            
            vscode.window.showInformationMessage(`Cluster "${contextName}" is connected`);

        } catch (error) {
            clusterInfo.status = 'disconnected';
            clusterInfo.error = undefined;
            clusterInfo.lastChecked = new Date();
            clusterInfo.nodeCount = undefined;
            clusterInfo.podCount = undefined;
            clusterInfo.namespaceCount = undefined;
            clusterInfo.version = undefined;
            
            vscode.window.showWarningMessage(`Cluster "${contextName}" is disconnected`);
        } finally {
            if (currentContext) {
                await this.kubeconfigManager.setCurrentContext(currentContext);
                this.k8sClient.refresh();
            }
        }

        this.updateWebview();
    }

    private async switchToCluster(contextName: string) {
        try {
            await this.kubeconfigManager.setCurrentContext(contextName);
            this.k8sClient.refresh();

            // Update active status
            for (const cluster of this.clusters.values()) {
                cluster.isActive = cluster.context === contextName;
            }

            vscode.window.showInformationMessage(`Switched to cluster: ${contextName}`);
            this.updateWebview();
            
            // Trigger refresh of other views
            vscode.commands.executeCommand('clusterPilot.refresh');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to switch cluster: ${errorMessage}`);
        }
    }

    private async addCluster() {
        await vscode.commands.executeCommand('clusterPilot.addCluster');
        await this.loadClusters();
        await this.refreshAllClusters();
        vscode.window.showInformationMessage('Cluster configuration refreshed');
    }

    private async removeCluster(contextName: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Remove cluster "${contextName}"?`,
            { modal: true },
            'Remove'
        );

        if (confirm === 'Remove') {
            try {
                this.kubeconfigManager.removeContext(contextName);
                this.clusters.delete(contextName);
                vscode.window.showInformationMessage(`Cluster ${contextName} removed`);
                this.updateWebview();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to remove cluster: ${errorMessage}`);
            }
        }
    }

    private async compareAcrossClusters(contexts: string[]) {
        if (contexts.length !== 2) {
            vscode.window.showWarningMessage('Please select exactly 2 clusters to compare');
            return;
        }

        const { compareAcrossClusters } = await import('../commands');
        await compareAcrossClusters(this.k8sClient, this.kubeconfigManager);
    }

    private async showClusterDetails(contextName: string) {
        const cluster = this.clusters.get(contextName);
        if (!cluster) {
            return;
        }

        const details = `
Cluster: ${cluster.name}
Server: ${cluster.server}
Status: ${cluster.status}
Namespace: ${cluster.namespace}
Kubernetes Version: ${cluster.version || 'N/A'}
Nodes: ${cluster.nodeCount || 0}
Pods: ${cluster.podCount || 0}
Namespaces: ${cluster.namespaceCount || 0}
Last Checked: ${cluster.lastChecked?.toLocaleString() || 'Never'}
${cluster.error ? `\nError: ${cluster.error}` : ''}
        `.trim();

        vscode.window.showInformationMessage(details, { modal: true });
    }

    private updateWebview() {
        this.panel.webview.html = this.getWebviewContent();
    }

    private getWebviewContent(): string {
        const clustersArray = Array.from(this.clusters.values());
        const activeCluster = clustersArray.find(c => c.isActive);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Multi-Cluster Manager</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .header h1 {
            font-size: 20px;
            font-weight: 600;
        }

        .header-actions {
            display: flex;
            gap: 10px;
        }

        button {
            padding: 6px 12px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 13px;
        }

        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 25px;
        }

        .summary-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 15px;
            border-radius: 4px;
            border-left: 3px solid var(--vscode-focusBorder);
        }

        .summary-card h3 {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            text-transform: uppercase;
        }

        .summary-card .value {
            font-size: 24px;
            font-weight: 600;
        }

        .clusters-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 15px;
        }

        .cluster-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 15px;
            transition: all 0.2s;
        }

        .cluster-card:hover {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }

        .cluster-card.active {
            border-color: var(--vscode-focusBorder);
            border-width: 2px;
            background-color: var(--vscode-editor-selectionBackground);
        }

        .cluster-header {
            display: flex;
            justify-content: space-between;
            align-items: start;
            margin-bottom: 12px;
        }

        .cluster-name {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 4px;
        }

        .cluster-server {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            word-break: break-all;
        }

        .status-badge {
            padding: 3px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .status-connected {
            background-color: var(--vscode-testing-iconPassed);
            color: var(--vscode-editor-background);
        }

        .status-disconnected {
            background-color: var(--vscode-descriptionForeground);
            color: var(--vscode-editor-background);
        }

        .status-error {
            background-color: var(--vscode-errorForeground);
            color: var(--vscode-editor-background);
        }

        .status-checking {
            background-color: var(--vscode-focusBorder);
            color: var(--vscode-editor-background);
        }

        .cluster-stats {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
            margin: 15px 0;
        }

        .stat {
            text-align: center;
        }

        .stat-value {
            font-size: 20px;
            font-weight: 600;
            color: var(--vscode-focusBorder);
        }

        .stat-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }

        .cluster-info {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 12px;
        }

        .cluster-info-row {
            display: flex;
            justify-content: space-between;
            padding: 4px 0;
        }

        .cluster-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }

        .cluster-actions button {
            flex: 1;
            min-width: 80px;
            padding: 5px 10px;
            font-size: 12px;
        }

        .error-message {
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            color: var(--vscode-errorForeground);
            padding: 8px;
            border-radius: 4px;
            font-size: 12px;
            margin-top: 10px;
        }

        .active-badge {
            background-color: var(--vscode-focusBorder);
            color: var(--vscode-editor-background);
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: 600;
            margin-left: 8px;
        }

        .last-checked {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-align: right;
            margin-top: 8px;
        }

        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }

        .empty-state-icon {
            font-size: 48px;
            margin-bottom: 16px;
            opacity: 0.5;
        }

        .empty-state h2 {
            margin-bottom: 8px;
        }

        .empty-state p {
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1>Multi-Cluster Manager</h1>
            ${activeCluster ? `<span style="color: var(--vscode-descriptionForeground); font-size: 13px; margin-left: 10px;">Active: ${activeCluster.name}</span>` : ''}
        </div>
        <div class="header-actions">
            <button onclick="showBackupManager()" class="secondary">💾 Backup Manager</button>
            <button onclick="refreshAll()" class="secondary">↻ Refresh All</button>
            <button onclick="addCluster()">+ Add Cluster</button>
        </div>
    </div>

    <div class="summary">
        <div class="summary-card">
            <h3>Total Clusters</h3>
            <div class="value">${clustersArray.length}</div>
        </div>
        <div class="summary-card">
            <h3>Connected</h3>
            <div class="value">${clustersArray.filter(c => c.status === 'connected').length}</div>
        </div>
        <div class="summary-card">
            <h3>Total Nodes</h3>
            <div class="value">${clustersArray.reduce((sum, c) => sum + (c.nodeCount || 0), 0)}</div>
        </div>
        <div class="summary-card">
            <h3>Total Pods</h3>
            <div class="value">${clustersArray.reduce((sum, c) => sum + (c.podCount || 0), 0)}</div>
        </div>
    </div>

    ${clustersArray.length === 0 ? `
        <div class="empty-state">
            <div class="empty-state-icon">☁️</div>
            <h2>No Clusters Configured</h2>
            <p>Add your first Kubernetes cluster to get started</p>
            <button onclick="addCluster()">+ Add Cluster</button>
        </div>
    ` : `
        <div class="clusters-grid">
            ${clustersArray.map(cluster => `
                <div class="cluster-card ${cluster.isActive ? 'active' : ''}">
                    <div class="cluster-header">
                        <div>
                            <div class="cluster-name">
                                ${this.escapeHtml(cluster.name)}
                                ${cluster.isActive ? '<span class="active-badge">ACTIVE</span>' : ''}
                            </div>
                            <div class="cluster-server">${this.escapeHtml(cluster.server)}</div>
                        </div>
                        <span class="status-badge status-${cluster.status}">${cluster.status}</span>
                    </div>

                    ${cluster.status === 'connected' ? `
                        <div class="cluster-stats">
                            <div class="stat">
                                <div class="stat-value">${cluster.nodeCount || 0}</div>
                                <div class="stat-label">Nodes</div>
                            </div>
                            <div class="stat">
                                <div class="stat-value">${cluster.podCount || 0}</div>
                                <div class="stat-label">Pods</div>
                            </div>
                            <div class="stat">
                                <div class="stat-value">${cluster.namespaceCount || 0}</div>
                                <div class="stat-label">Namespaces</div>
                            </div>
                        </div>

                        <div class="cluster-info">
                            <div class="cluster-info-row">
                                <span>Version:</span>
                                <span>${cluster.version || 'Unknown'}</span>
                            </div>
                            <div class="cluster-info-row">
                                <span>Namespace:</span>
                                <span>${cluster.namespace}</span>
                            </div>
                        </div>
                    ` : ''}

                    ${cluster.error ? `
                        <div class="error-message">
                            ${this.escapeHtml(cluster.error)}
                        </div>
                    ` : ''}

                    <div class="cluster-actions">
                        ${!cluster.isActive ? `
                            <button onclick="switchCluster('${cluster.context}')" ${cluster.status !== 'connected' ? 'disabled style="opacity: 0.5;"' : ''}>Switch</button>
                        ` : `
                            <button disabled style="opacity: 0.5;">Active</button>
                        `}
                        <button onclick="refreshCluster('${cluster.context}')" class="secondary">Refresh</button>
                        <button onclick="showDetails('${cluster.context}')" class="secondary" ${cluster.status !== 'connected' ? 'disabled style="opacity: 0.5;"' : ''}>Details</button>
                        <button onclick="removeCluster('${cluster.context}')" class="secondary">Remove</button>
                    </div>

                    ${cluster.lastChecked ? `
                        <div class="last-checked">
                            Last checked: ${new Date(cluster.lastChecked).toLocaleTimeString()}
                        </div>
                    ` : ''}
                </div>
            `).join('')}
        </div>
    `}

    <script>
        const vscode = acquireVsCodeApi();

        function switchCluster(context) {
            vscode.postMessage({ command: 'switchCluster', context });
        }

        function refreshCluster(context) {
            vscode.postMessage({ command: 'refreshCluster', context });
        }

        function refreshAll() {
            vscode.postMessage({ command: 'refreshAll' });
        }

        function addCluster() {
            vscode.postMessage({ command: 'addCluster' });
        }

        function removeCluster(context) {
            vscode.postMessage({ command: 'removeCluster', context });
        }

        function showDetails(context) {
            vscode.postMessage({ command: 'getClusterDetails', context });
        }

        function compareAcrossClusters(contexts) {
            vscode.postMessage({ command: 'compareAcrossClusters', contexts });
        }

        function showBackupManager() {
            vscode.postMessage({ command: 'showBackupManager' });
        }
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const map: Record<string, string> = {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            '&': '&amp;',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            '<': '&lt;',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            '>': '&gt;',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            '"': '&quot;',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    public dispose() {
        MultiClusterManagerPanel.currentPanel = undefined;

        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
