import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';

export class NodeManagerPanel {
    public static currentPanel: NodeManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (NodeManagerPanel.currentPanel) {
            NodeManagerPanel.currentPanel.panel.reveal(column);
            NodeManagerPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'nodeManager',
            'Node Management',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        NodeManagerPanel.currentPanel = new NodeManagerPanel(panel, extensionUri, k8sClient);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly k8sClient: K8sClient
    ) {
        this.panel = panel;
        this.panel.webview.html = this.getHtmlContent();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'refresh':
                        await this.refresh();
                        break;
                    case 'cordon':
                        await this.cordonNode(message.nodeName);
                        break;
                    case 'uncordon':
                        await this.uncordonNode(message.nodeName);
                        break;
                    case 'drain':
                        await this.drainNode(message.nodeName);
                        break;
                    case 'viewDetails':
                        await this.viewNodeDetails(message.nodeName);
                        break;
                }
            },
            null,
            this.disposables
        );

        this.refresh();
        this.startAutoRefresh();
    }

    private startAutoRefresh() {
        this.refreshInterval = setInterval(() => {
            this.refresh();
        }, 10000); // Refresh every 10 seconds
    }

    private async refresh() {
        try {
            const nodes = await this.k8sClient.getNodes();
            const metrics = await this.k8sClient.getNodeMetrics().catch(() => []);
            
            const nodeData = nodes.map(node => {
                const nodeName = node.metadata?.name || 'unknown';
                const metric = metrics.find(m => m.metadata?.name === nodeName);
                
                return {
                    name: nodeName,
                    ready: this.isNodeReady(node),
                    unschedulable: node.spec?.unschedulable === true,
                    role: this.getNodeRole(node),
                    version: node.status?.nodeInfo?.kubeletVersion || 'Unknown',
                    os: node.status?.nodeInfo?.osImage || 'Unknown',
                    kernel: node.status?.nodeInfo?.kernelVersion || 'Unknown',
                    containerRuntime: node.status?.nodeInfo?.containerRuntimeVersion || 'Unknown',
                    conditions: this.getNodeConditions(node),
                    capacity: this.getNodeCapacity(node),
                    allocatable: this.getNodeAllocatable(node),
                    usage: metric ? this.getNodeUsage(metric) : null,
                    addresses: this.getNodeAddresses(node),
                    taints: node.spec?.taints || [],
                    labels: node.metadata?.labels || {}
                };
            });

            this.panel.webview.postMessage({
                command: 'updateData',
                data: nodeData
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh nodes: ${error}`);
        }
    }

    private isNodeReady(node: k8s.V1Node): boolean {
        const conditions = node.status?.conditions || [];
        const readyCondition = conditions.find(c => c.type === 'Ready');
        return readyCondition?.status === 'True';
    }

    private getNodeRole(node: k8s.V1Node): string {
        const labels = node.metadata?.labels || {};
        
        if (labels['node-role.kubernetes.io/master'] || labels['node-role.kubernetes.io/control-plane']) {
            return 'Control Plane';
        }
        
        const roleKeys = Object.keys(labels).filter(k => k.startsWith('node-role.kubernetes.io/'));
        if (roleKeys.length > 0) {
            return roleKeys[0].replace('node-role.kubernetes.io/', '');
        }
        
        return 'Worker';
    }

    private getNodeConditions(node: k8s.V1Node): Array<{ type: string; status: string; reason: string; message: string }> {
        const conditions = node.status?.conditions || [];
        return conditions.map(c => ({
            type: c.type || 'Unknown',
            status: c.status || 'Unknown',
            reason: c.reason || '',
            message: c.message || ''
        }));
    }

    private getNodeCapacity(node: k8s.V1Node): { cpu: string; memory: string; pods: string } {
        const capacity = node.status?.capacity || {};
        return {
            cpu: capacity.cpu || '0',
            memory: this.formatBytes(this.parseMemory(capacity.memory || '0')),
            pods: capacity.pods || '0'
        };
    }

    private getNodeAllocatable(node: k8s.V1Node): { cpu: string; memory: string; pods: string } {
        const allocatable = node.status?.allocatable || {};
        return {
            cpu: allocatable.cpu || '0',
            memory: this.formatBytes(this.parseMemory(allocatable.memory || '0')),
            pods: allocatable.pods || '0'
        };
    }

    private getNodeUsage(metric: k8s.NodeMetric): { cpu: string; memory: string } {
        const usage = metric.usage || {};
        return {
            cpu: this.formatCpu(this.parseCpu(usage.cpu || '0')),
            memory: this.formatBytes(this.parseMemory(usage.memory || '0'))
        };
    }

    private getNodeAddresses(node: k8s.V1Node): Array<{ type: string; address: string }> {
        const addresses = node.status?.addresses || [];
        return addresses.map(a => ({
            type: a.type || 'Unknown',
            address: a.address || 'Unknown'
        }));
    }

    private parseCpu(cpu: string): number {
        if (cpu.endsWith('n')) {
            return parseInt(cpu.slice(0, -1));
        } else if (cpu.endsWith('u')) {
            return parseInt(cpu.slice(0, -1)) * 1000;
        } else if (cpu.endsWith('m')) {
            return parseInt(cpu.slice(0, -1)) * 1000000;
        } else {
            return parseFloat(cpu) * 1000000000;
        }
    }

    private formatCpu(nanocores: number): string {
        if (nanocores >= 1000000000) {
            return (nanocores / 1000000000).toFixed(2) + ' cores';
        } else if (nanocores >= 1000000) {
            return (nanocores / 1000000).toFixed(0) + 'm';
        } else {
            return nanocores.toFixed(0) + 'n';
        }
    }

    private parseMemory(memory: string): number {
        const units: Record<string, number> = {
            'Ki': 1024,
            'Mi': 1024 * 1024,
            'Gi': 1024 * 1024 * 1024,
            'Ti': 1024 * 1024 * 1024 * 1024,
            'K': 1000,
            'M': 1000 * 1000,
            'G': 1000 * 1000 * 1000,
            'T': 1000 * 1000 * 1000 * 1000
        };

        for (const [unit, multiplier] of Object.entries(units)) {
            if (memory.endsWith(unit)) {
                return parseInt(memory.slice(0, -unit.length)) * multiplier;
            }
        }

        return parseInt(memory);
    }

    private formatBytes(bytes: number): string {
        if (bytes >= 1024 * 1024 * 1024 * 1024) {
            return (bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2) + ' TiB';
        } else if (bytes >= 1024 * 1024 * 1024) {
            return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GiB';
        } else if (bytes >= 1024 * 1024) {
            return (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
        } else if (bytes >= 1024) {
            return (bytes / 1024).toFixed(2) + ' KiB';
        } else {
            return bytes + ' B';
        }
    }

    private async cordonNode(nodeName: string) {
        try {
            await this.k8sClient.cordonNode(nodeName);
            vscode.window.showInformationMessage(`Node ${nodeName} cordoned successfully`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to cordon node: ${error}`);
        }
    }

    private async uncordonNode(nodeName: string) {
        try {
            await this.k8sClient.uncordonNode(nodeName);
            vscode.window.showInformationMessage(`Node ${nodeName} uncordoned successfully`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to uncordon node: ${error}`);
        }
    }

    private async drainNode(nodeName: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to drain node ${nodeName}? This will evict all pods from the node.`,
            { modal: true },
            'Drain'
        );

        if (confirm !== 'Drain') {
            return;
        }

        try {
            await this.k8sClient.drainNode(nodeName);
            vscode.window.showInformationMessage(`Node ${nodeName} drained successfully`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to drain node: ${error}`);
        }
    }

    private async viewNodeDetails(nodeName: string) {
        try {
            const nodes = await this.k8sClient.getNodes();
            const node = nodes.find(n => n.metadata?.name === nodeName);
            
            if (!node) {
                vscode.window.showErrorMessage(`Node ${nodeName} not found`);
                return;
            }

            const yaml = JSON.stringify(node, null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: yaml,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get node details: ${error}`);
        }
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Node Management</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        h1 {
            margin: 0;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            font-size: 14px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .danger {
            background-color: var(--vscode-errorForeground);
        }
        .danger:hover {
            background-color: var(--vscode-errorForeground);
            opacity: 0.8;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 15px;
            border-radius: 4px;
        }
        .stat-label {
            font-size: 12px;
            opacity: 0.8;
            margin-bottom: 5px;
        }
        .stat-value {
            font-size: 24px;
            font-weight: bold;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
        }
        th, td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        th {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            font-weight: 600;
        }
        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .status {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 12px;
        }
        .status.ready {
            background-color: var(--vscode-testing-iconPassed);
            color: white;
        }
        .status.not-ready {
            background-color: var(--vscode-testing-iconFailed);
            color: white;
        }
        .status.unschedulable {
            background-color: var(--vscode-charts-orange);
            color: white;
        }
        .actions {
            display: flex;
            gap: 5px;
        }
        .actions button {
            padding: 4px 8px;
            font-size: 12px;
        }
        .capacity-bar {
            width: 100%;
            height: 20px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 3px;
            overflow: hidden;
            position: relative;
        }
        .capacity-fill {
            height: 100%;
            background-color: var(--vscode-charts-blue);
            transition: width 0.3s;
        }
        .capacity-text {
            position: absolute;
            top: 2px;
            left: 5px;
            font-size: 11px;
        }
        .section {
            margin-top: 30px;
        }
        .section-title {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 10px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Node Management</h1>
        <button onclick="refresh()">Refresh</button>
    </div>

    <div class="stats" id="stats">
        <div class="stat-card">
            <div class="stat-label">Total Nodes</div>
            <div class="stat-value" id="totalNodes">-</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Ready Nodes</div>
            <div class="stat-value" id="readyNodes">-</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Not Ready</div>
            <div class="stat-value" id="notReadyNodes">-</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Unschedulable</div>
            <div class="stat-value" id="unschedulableNodes">-</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Nodes</div>
        <table>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Role</th>
                    <th>Version</th>
                    <th>CPU Usage</th>
                    <th>Memory Usage</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody id="nodesTable">
                <tr>
                    <td colspan="7" style="text-align: center;">Loading...</td>
                </tr>
            </tbody>
        </table>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function cordonNode(nodeName) {
            vscode.postMessage({ command: 'cordon', nodeName });
        }

        function uncordonNode(nodeName) {
            vscode.postMessage({ command: 'uncordon', nodeName });
        }

        function drainNode(nodeName) {
            vscode.postMessage({ command: 'drain', nodeName });
        }

        function viewDetails(nodeName) {
            vscode.postMessage({ command: 'viewDetails', nodeName });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateData') {
                updateUI(message.data);
            }
        });

        function updateUI(nodes) {
            // Update stats
            document.getElementById('totalNodes').textContent = nodes.length;
            document.getElementById('readyNodes').textContent = nodes.filter(n => n.ready).length;
            document.getElementById('notReadyNodes').textContent = nodes.filter(n => !n.ready).length;
            document.getElementById('unschedulableNodes').textContent = nodes.filter(n => n.unschedulable).length;

            // Update table
            const tbody = document.getElementById('nodesTable');
            if (nodes.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No nodes found</td></tr>';
                return;
            }

            tbody.innerHTML = nodes.map(node => {
                const statusClass = node.ready ? 'ready' : 'not-ready';
                const statusText = node.ready ? 'Ready' : 'Not Ready';
                
                let cpuUsage = 'N/A';
                let memUsage = 'N/A';
                
                if (node.usage) {
                    cpuUsage = node.usage.cpu;
                    memUsage = node.usage.memory;
                }

                const actions = [];
                if (node.unschedulable) {
                    actions.push(\`<button onclick="uncordonNode('\${node.name}')">Uncordon</button>\`);
                } else {
                    actions.push(\`<button onclick="cordonNode('\${node.name}')">Cordon</button>\`);
                }
                actions.push(\`<button class="danger" onclick="drainNode('\${node.name}')">Drain</button>\`);
                actions.push(\`<button onclick="viewDetails('\${node.name}')">Details</button>\`);

                return \`
                    <tr>
                        <td>\${node.name}</td>
                        <td>
                            <span class="status \${statusClass}">\${statusText}</span>
                            \${node.unschedulable ? '<span class="status unschedulable">Unschedulable</span>' : ''}
                        </td>
                        <td>\${node.role}</td>
                        <td>\${node.version}</td>
                        <td>\${cpuUsage}</td>
                        <td>\${memUsage}</td>
                        <td>
                            <div class="actions">
                                \${actions.join('')}
                            </div>
                        </td>
                    </tr>
                \`;
            }).join('');
        }

        // Initial refresh
        refresh();
    </script>
</body>
</html>`;
    }

    public dispose() {
        NodeManagerPanel.currentPanel = undefined;

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
