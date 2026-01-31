import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

interface CapacityData {
    nodes: Array<{
        name: string;
        cpuAllocatable: number;
        memoryAllocatable: number;
        cpuRequested: number;
        memoryRequested: number;
        cpuLimited: number;
        memoryLimited: number;
        cpuUsed: number;
        memoryUsed: number;
        podCount: number;
        podCapacity: number;
    }>;
    cluster: {
        totalCpuAllocatable: number;
        totalMemoryAllocatable: number;
        totalCpuRequested: number;
        totalMemoryRequested: number;
        totalCpuLimited: number;
        totalMemoryLimited: number;
        totalCpuUsed: number;
        totalMemoryUsed: number;
        totalPods: number;
        totalPodCapacity: number;
    };
    namespaces: Array<{
        name: string;
        podCount: number;
        cpuRequested: number;
        memoryRequested: number;
        cpuLimited: number;
        memoryLimited: number;
    }>;
}

export class CapacityPlanningPanel {
    public static currentPanel: CapacityPlanningPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (CapacityPlanningPanel.currentPanel) {
            CapacityPlanningPanel.currentPanel.panel.reveal(column);
            CapacityPlanningPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'capacityPlanning',
            'Cluster Capacity Planning',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        CapacityPlanningPanel.currentPanel = new CapacityPlanningPanel(panel, extensionUri, k8sClient);
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
        }, 30000); // Refresh every 30 seconds
    }

    private async refresh() {
        try {
            const data = await this.collectCapacityData();
            
            this.panel.webview.postMessage({
                command: 'updateData',
                data
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh capacity data: ${error}`);
        }
    }

    private async collectCapacityData(): Promise<CapacityData> {
        const [nodes, pods] = await Promise.all([
            this.k8sClient.getNodes(),
            this.k8sClient.getPods()
        ]);

        let nodeMetrics: any[] = [];
        let podMetrics: any[] = [];
        try {
            [nodeMetrics, podMetrics] = await Promise.all([
                this.k8sClient.getNodeMetrics(),
                this.k8sClient.getPodMetrics()
            ]);
        } catch (error) {
            console.warn('Metrics server not available:', error);
            nodeMetrics = [];
            podMetrics = [];
        }

        const nodeData = nodes.map(node => {
            const nodeName = node.metadata?.name || 'unknown';
            const nodePods = pods.filter(p => p.spec?.nodeName === nodeName);
            
            let cpuRequested = 0;
            let memoryRequested = 0;
            let cpuLimited = 0;
            let memoryLimited = 0;

            for (const pod of nodePods) {
                for (const container of pod.spec?.containers || []) {
                    cpuRequested += this.parseCpu(container.resources?.requests?.cpu || '0');
                    memoryRequested += this.parseMemory(container.resources?.requests?.memory || '0');
                    cpuLimited += this.parseCpu(container.resources?.limits?.cpu || '0');
                    memoryLimited += this.parseMemory(container.resources?.limits?.memory || '0');
                }
            }

            const metrics = nodeMetrics.find(m => m.metadata?.name === nodeName);
            const cpuUsed = metrics ? this.parseCpu(metrics.usage?.cpu || '0') : 0;
            const memoryUsed = metrics ? this.parseMemory(metrics.usage?.memory || '0') : 0;

            return {
                name: nodeName,
                cpuAllocatable: this.parseCpu(node.status?.allocatable?.cpu || '0'),
                memoryAllocatable: this.parseMemory(node.status?.allocatable?.memory || '0'),
                cpuRequested,
                memoryRequested,
                cpuLimited,
                memoryLimited,
                cpuUsed,
                memoryUsed,
                podCount: nodePods.length,
                podCapacity: parseInt(node.status?.allocatable?.pods || '0')
            };
        });

        // Aggregate cluster totals
        const cluster = nodeData.reduce((acc, node) => ({
            totalCpuAllocatable: acc.totalCpuAllocatable + node.cpuAllocatable,
            totalMemoryAllocatable: acc.totalMemoryAllocatable + node.memoryAllocatable,
            totalCpuRequested: acc.totalCpuRequested + node.cpuRequested,
            totalMemoryRequested: acc.totalMemoryRequested + node.memoryRequested,
            totalCpuLimited: acc.totalCpuLimited + node.cpuLimited,
            totalMemoryLimited: acc.totalMemoryLimited + node.memoryLimited,
            totalCpuUsed: acc.totalCpuUsed + node.cpuUsed,
            totalMemoryUsed: acc.totalMemoryUsed + node.memoryUsed,
            totalPods: acc.totalPods + node.podCount,
            totalPodCapacity: acc.totalPodCapacity + node.podCapacity
        }), {
            totalCpuAllocatable: 0,
            totalMemoryAllocatable: 0,
            totalCpuRequested: 0,
            totalMemoryRequested: 0,
            totalCpuLimited: 0,
            totalMemoryLimited: 0,
            totalCpuUsed: 0,
            totalMemoryUsed: 0,
            totalPods: 0,
            totalPodCapacity: 0
        });

        // Namespace breakdown
        const namespaceMap = new Map<string, {
            podCount: number;
            cpuRequested: number;
            memoryRequested: number;
            cpuLimited: number;
            memoryLimited: number;
        }>();

        for (const pod of pods) {
            const namespace = pod.metadata?.namespace || 'default';
            
            if (!namespaceMap.has(namespace)) {
                namespaceMap.set(namespace, {
                    podCount: 0,
                    cpuRequested: 0,
                    memoryRequested: 0,
                    cpuLimited: 0,
                    memoryLimited: 0
                });
            }

            const nsData = namespaceMap.get(namespace)!;
            nsData.podCount++;

            for (const container of pod.spec?.containers || []) {
                nsData.cpuRequested += this.parseCpu(container.resources?.requests?.cpu || '0');
                nsData.memoryRequested += this.parseMemory(container.resources?.requests?.memory || '0');
                nsData.cpuLimited += this.parseCpu(container.resources?.limits?.cpu || '0');
                nsData.memoryLimited += this.parseMemory(container.resources?.limits?.memory || '0');
            }
        }

        const namespaces = Array.from(namespaceMap.entries()).map(([name, data]) => ({
            name,
            ...data
        }));

        return {
            nodes: nodeData,
            cluster,
            namespaces
        };
    }

    private parseCpu(cpu: string): number {
        if (cpu.endsWith('m')) {
            return parseInt(cpu) / 1000;
        }
        if (cpu.endsWith('n')) {
            return parseInt(cpu) / 1000000000;
        }
        return parseFloat(cpu) || 0;
    }

    private parseMemory(memory: string): number {
        const units: { [key: string]: number } = {
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
                return parseInt(memory) * multiplier;
            }
        }

        return parseInt(memory) || 0;
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cluster Capacity Planning</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            margin: 0;
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
        h2 {
            margin: 20px 0 10px 0;
            font-size: 18px;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 5px;
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
        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .summary-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-charts-blue);
        }
        .summary-card h3 {
            margin: 0 0 15px 0;
            font-size: 14px;
            opacity: 0.8;
        }
        .capacity-bar {
            margin: 15px 0;
        }
        .capacity-label {
            display: flex;
            justify-content: space-between;
            font-size: 12px;
            margin-bottom: 5px;
        }
        .capacity-visual {
            height: 30px;
            background-color: var(--vscode-editor-background);
            border-radius: 4px;
            position: relative;
            overflow: hidden;
        }
        .capacity-segment {
            height: 100%;
            float: left;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            font-weight: bold;
            color: white;
        }
        .segment-used {
            background-color: var(--vscode-charts-red);
        }
        .segment-requested {
            background-color: var(--vscode-charts-orange);
        }
        .segment-limited {
            background-color: var(--vscode-charts-yellow);
        }
        .segment-free {
            background-color: var(--vscode-charts-green);
        }
        .legend {
            display: flex;
            gap: 15px;
            margin-top: 10px;
            font-size: 11px;
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .legend-color {
            width: 12px;
            height: 12px;
            border-radius: 2px;
        }
        .chart-container {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
            height: 400px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            overflow: hidden;
        }
        th {
            text-align: left;
            padding: 12px;
            background-color: var(--vscode-editor-background);
            font-size: 11px;
            text-transform: uppercase;
            opacity: 0.8;
        }
        td {
            padding: 12px;
            border-top: 1px solid var(--vscode-editor-background);
            font-size: 12px;
        }
        .progress-bar {
            height: 6px;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
            overflow: hidden;
            margin-top: 3px;
        }
        .progress-fill {
            height: 100%;
        }
        .warning {
            color: var(--vscode-charts-orange);
        }
        .critical {
            color: var(--vscode-charts-red);
        }
        .good {
            color: var(--vscode-charts-green);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Cluster Capacity Planning</h1>
        <button onclick="refresh()">Refresh</button>
    </div>

    <div id="summary" class="summary-cards"></div>

    <h2>Capacity Breakdown by Node</h2>
    <div class="chart-container">
        <canvas id="nodeCapacityChart"></canvas>
    </div>

    <h2>Node Details</h2>
    <table id="nodeTable">
        <thead>
            <tr>
                <th>Node</th>
                <th>CPU Allocatable</th>
                <th>CPU Requested</th>
                <th>Memory Allocatable</th>
                <th>Memory Requested</th>
                <th>Pods</th>
            </tr>
        </thead>
        <tbody></tbody>
    </table>

    <h2 style="margin-top: 30px;">Namespace Resource Consumption</h2>
    <table id="namespaceTable">
        <thead>
            <tr>
                <th>Namespace</th>
                <th>Pods</th>
                <th>CPU Requested</th>
                <th>CPU Limited</th>
                <th>Memory Requested</th>
                <th>Memory Limited</th>
            </tr>
        </thead>
        <tbody></tbody>
    </table>

    <script>
        const vscode = acquireVsCodeApi();
        let nodeChart = null;

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
        }

        function formatCpu(cores) {
            if (cores < 0.001) return (cores * 1000000).toFixed(0) + ' µ';
            if (cores < 1) return (cores * 1000).toFixed(0) + ' m';
            return cores.toFixed(2);
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateData') {
                renderDashboard(message.data);
            }
        });

        function renderDashboard(data) {
            renderSummary(data.cluster);
            renderNodeChart(data.nodes);
            renderNodeTable(data.nodes);
            renderNamespaceTable(data.namespaces);
        }

        function renderSummary(cluster) {
            const cpuRequestedPercent = (cluster.totalCpuRequested / cluster.totalCpuAllocatable) * 100;
            const memRequestedPercent = (cluster.totalMemoryRequested / cluster.totalMemoryAllocatable) * 100;
            const cpuUsedPercent = (cluster.totalCpuUsed / cluster.totalCpuAllocatable) * 100;
            const memUsedPercent = (cluster.totalMemoryUsed / cluster.totalMemoryAllocatable) * 100;
            const cpuLimitedPercent = (cluster.totalCpuLimited / cluster.totalCpuAllocatable) * 100;
            const memLimitedPercent = (cluster.totalMemoryLimited / cluster.totalMemoryAllocatable) * 100;

            const cpuFreePercent = Math.max(0, 100 - Math.max(cpuUsedPercent, cpuRequestedPercent, cpuLimitedPercent));
            const memFreePercent = Math.max(0, 100 - Math.max(memUsedPercent, memRequestedPercent, memLimitedPercent));

            document.getElementById('summary').innerHTML = \`
                <div class="summary-card">
                    <h3>CPU Capacity</h3>
                    <div class="capacity-label">
                        <span>Total Allocatable: <strong>\${formatCpu(cluster.totalCpuAllocatable)} cores</strong></span>
                    </div>
                    <div class="capacity-visual">
                        \${cpuUsedPercent > 0 ? \`<div class="capacity-segment segment-used" style="width: \${cpuUsedPercent}%">\${cpuUsedPercent.toFixed(0)}%</div>\` : ''}
                        \${cpuRequestedPercent > cpuUsedPercent ? \`<div class="capacity-segment segment-requested" style="width: \${cpuRequestedPercent - cpuUsedPercent}%"></div>\` : ''}
                        \${cpuLimitedPercent > cpuRequestedPercent ? \`<div class="capacity-segment segment-limited" style="width: \${cpuLimitedPercent - cpuRequestedPercent}%"></div>\` : ''}
                        <div class="capacity-segment segment-free" style="width: \${cpuFreePercent}%"></div>
                    </div>
                    <div class="legend">
                        <div class="legend-item">
                            <div class="legend-color segment-used"></div>
                            <span>Used: \${formatCpu(cluster.totalCpuUsed)}</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color segment-requested"></div>
                            <span>Requested: \${formatCpu(cluster.totalCpuRequested)}</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color segment-limited"></div>
                            <span>Limited: \${formatCpu(cluster.totalCpuLimited)}</span>
                        </div>
                    </div>
                </div>

                <div class="summary-card">
                    <h3>Memory Capacity</h3>
                    <div class="capacity-label">
                        <span>Total Allocatable: <strong>\${formatBytes(cluster.totalMemoryAllocatable)}</strong></span>
                    </div>
                    <div class="capacity-visual">
                        \${memUsedPercent > 0 ? \`<div class="capacity-segment segment-used" style="width: \${memUsedPercent}%">\${memUsedPercent.toFixed(0)}%</div>\` : ''}
                        \${memRequestedPercent > memUsedPercent ? \`<div class="capacity-segment segment-requested" style="width: \${memRequestedPercent - memUsedPercent}%"></div>\` : ''}
                        \${memLimitedPercent > memRequestedPercent ? \`<div class="capacity-segment segment-limited" style="width: \${memLimitedPercent - memRequestedPercent}%"></div>\` : ''}
                        <div class="capacity-segment segment-free" style="width: \${memFreePercent}%"></div>
                    </div>
                    <div class="legend">
                        <div class="legend-item">
                            <div class="legend-color segment-used"></div>
                            <span>Used: \${formatBytes(cluster.totalMemoryUsed)}</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color segment-requested"></div>
                            <span>Requested: \${formatBytes(cluster.totalMemoryRequested)}</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color segment-limited"></div>
                            <span>Limited: \${formatBytes(cluster.totalMemoryLimited)}</span>
                        </div>
                    </div>
                </div>

                <div class="summary-card">
                    <h3>Pod Capacity</h3>
                    <div class="capacity-label">
                        <span><strong>\${cluster.totalPods}</strong> / \${cluster.totalPodCapacity} pods</span>
                        <span class="\${(cluster.totalPods / cluster.totalPodCapacity) > 0.8 ? 'critical' : (cluster.totalPods / cluster.totalPodCapacity) > 0.6 ? 'warning' : 'good'}">
                            \${((cluster.totalPods / cluster.totalPodCapacity) * 100).toFixed(1)}%
                        </span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill segment-used" style="width: \${(cluster.totalPods / cluster.totalPodCapacity) * 100}%"></div>
                    </div>
                </div>
            \`;
        }

        function renderNodeChart(nodes) {
            const ctx = document.getElementById('nodeCapacityChart');
            
            if (nodeChart) {
                nodeChart.destroy();
            }

            nodeChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: nodes.map(n => n.name),
                    datasets: [
                        {
                            label: 'CPU Used (cores)',
                            data: nodes.map(n => n.cpuUsed),
                            backgroundColor: 'rgba(255, 99, 132, 0.7)',
                            borderColor: 'rgb(255, 99, 132)',
                            borderWidth: 1
                        },
                        {
                            label: 'CPU Requested (cores)',
                            data: nodes.map(n => n.cpuRequested),
                            backgroundColor: 'rgba(255, 159, 64, 0.7)',
                            borderColor: 'rgb(255, 159, 64)',
                            borderWidth: 1
                        },
                        {
                            label: 'CPU Allocatable (cores)',
                            data: nodes.map(n => n.cpuAllocatable),
                            backgroundColor: 'rgba(75, 192, 192, 0.7)',
                            borderColor: 'rgb(75, 192, 192)',
                            borderWidth: 1,
                            type: 'line'
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            labels: {
                                color: 'var(--vscode-foreground)'
                            }
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                color: 'var(--vscode-foreground)'
                            },
                            grid: {
                                color: 'rgba(128, 128, 128, 0.2)'
                            }
                        },
                        x: {
                            ticks: {
                                color: 'var(--vscode-foreground)'
                            },
                            grid: {
                                color: 'rgba(128, 128, 128, 0.2)'
                            }
                        }
                    }
                }
            });
        }

        function renderNodeTable(nodes) {
            const tbody = document.querySelector('#nodeTable tbody');
            tbody.innerHTML = nodes.map(node => {
                const cpuPercent = (node.cpuRequested / node.cpuAllocatable) * 100;
                const memPercent = (node.memoryRequested / node.memoryAllocatable) * 100;
                const podPercent = (node.podCount / node.podCapacity) * 100;

                return \`
                    <tr>
                        <td><strong>\${node.name}</strong></td>
                        <td>
                            \${formatCpu(node.cpuAllocatable)} cores
                            <div class="progress-bar">
                                <div class="progress-fill segment-used" style="width: \${Math.min(cpuPercent, 100)}%"></div>
                            </div>
                        </td>
                        <td class="\${cpuPercent > 80 ? 'critical' : cpuPercent > 60 ? 'warning' : 'good'}">
                            \${formatCpu(node.cpuRequested)} (\${cpuPercent.toFixed(1)}%)
                        </td>
                        <td>
                            \${formatBytes(node.memoryAllocatable)}
                            <div class="progress-bar">
                                <div class="progress-fill segment-used" style="width: \${Math.min(memPercent, 100)}%"></div>
                            </div>
                        </td>
                        <td class="\${memPercent > 80 ? 'critical' : memPercent > 60 ? 'warning' : 'good'}">
                            \${formatBytes(node.memoryRequested)} (\${memPercent.toFixed(1)}%)
                        </td>
                        <td class="\${podPercent > 80 ? 'critical' : podPercent > 60 ? 'warning' : 'good'}">
                            \${node.podCount} / \${node.podCapacity}
                        </td>
                    </tr>
                \`;
            }).join('');
        }

        function renderNamespaceTable(namespaces) {
            const tbody = document.querySelector('#namespaceTable tbody');
            tbody.innerHTML = namespaces
                .sort((a, b) => b.cpuRequested - a.cpuRequested)
                .map(ns => \`
                    <tr>
                        <td><strong>\${ns.name}</strong></td>
                        <td>\${ns.podCount}</td>
                        <td>\${formatCpu(ns.cpuRequested)} cores</td>
                        <td>\${formatCpu(ns.cpuLimited)} cores</td>
                        <td>\${formatBytes(ns.memoryRequested)}</td>
                        <td>\${formatBytes(ns.memoryLimited)}</td>
                    </tr>
                \`).join('');
        }

        // Initial load
        refresh();
    </script>
</body>
</html>`;
    }

    public dispose() {
        CapacityPlanningPanel.currentPanel = undefined;

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
