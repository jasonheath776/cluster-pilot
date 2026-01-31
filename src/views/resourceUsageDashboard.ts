import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

interface ResourceMetrics {
    cpu: number;
    memory: number;
}

interface PodMetrics {
    namespace: string;
    name: string;
    cpu: number;
    memory: number;
    cpuPercent: number;
    memoryPercent: number;
    containers: Array<{
        name: string;
        cpu: number;
        memory: number;
    }>;
}

interface NodeMetrics {
    name: string;
    cpu: number;
    memory: number;
    cpuCapacity: number;
    memoryCapacity: number;
    cpuPercent: number;
    memoryPercent: number;
    podCount: number;
    podCapacity: number;
}

interface NamespaceMetrics {
    namespace: string;
    podCount: number;
    totalCpu: number;
    totalMemory: number;
    cpuRequests: number;
    cpuLimits: number;
    memoryRequests: number;
    memoryLimits: number;
}

export class ResourceUsageDashboardPanel {
    public static currentPanel: ResourceUsageDashboardPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;
    private metricsHistory: Array<{
        timestamp: number;
        pods: PodMetrics[];
        nodes: NodeMetrics[];
        namespaces: NamespaceMetrics[];
    }> = [];
    private maxHistoryLength = 30; // Keep 30 data points (5 minutes at 10s intervals)

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ResourceUsageDashboardPanel.currentPanel) {
            ResourceUsageDashboardPanel.currentPanel.panel.reveal(column);
            ResourceUsageDashboardPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'resourceUsageDashboard',
            'Resource Usage Dashboard',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        ResourceUsageDashboardPanel.currentPanel = new ResourceUsageDashboardPanel(panel, extensionUri, k8sClient);
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
                    case 'clearHistory':
                        this.metricsHistory = [];
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
        }, 10000); // Refresh every 10 seconds
    }

    private async refresh() {
        try {
            const [podMetrics, nodeMetrics, namespaceMetrics] = await Promise.all([
                this.collectPodMetrics(),
                this.collectNodeMetrics(),
                this.collectNamespaceMetrics()
            ]);

            // Add to history
            this.metricsHistory.push({
                timestamp: Date.now(),
                pods: podMetrics,
                nodes: nodeMetrics,
                namespaces: namespaceMetrics
            });

            // Trim history
            if (this.metricsHistory.length > this.maxHistoryLength) {
                this.metricsHistory = this.metricsHistory.slice(-this.maxHistoryLength);
            }

            this.panel.webview.postMessage({
                command: 'updateData',
                current: {
                    pods: podMetrics,
                    nodes: nodeMetrics,
                    namespaces: namespaceMetrics
                },
                history: this.metricsHistory
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh metrics: ${error}`);
        }
    }

    private async collectPodMetrics(): Promise<PodMetrics[]> {
        try {
            const [pods, podMetrics] = await Promise.all([
                this.k8sClient.getPods(),
                this.k8sClient.getPodMetrics()
            ]);

            const metrics: PodMetrics[] = [];

            for (const metric of podMetrics) {
                const pod = pods.find(p => 
                    p.metadata?.name === metric.metadata?.name && 
                    p.metadata?.namespace === metric.metadata?.namespace
                );

                if (!pod) continue;

                let totalCpu = 0;
                let totalMemory = 0;
                const containerMetrics = [];

                for (const container of metric.containers || []) {
                    const cpu = this.parseCpu(container.usage?.cpu || '0');
                    const memory = this.parseMemory(container.usage?.memory || '0');
                    
                    totalCpu += cpu;
                    totalMemory += memory;

                    containerMetrics.push({
                        name: container.name || 'unknown',
                        cpu,
                        memory
                    });
                }

                // Calculate requests for percentage
                let cpuRequest = 0;
                let memoryRequest = 0;

                for (const container of pod.spec?.containers || []) {
                    cpuRequest += this.parseCpu(container.resources?.requests?.cpu || '0');
                    memoryRequest += this.parseMemory(container.resources?.requests?.memory || '0');
                }

                metrics.push({
                    namespace: metric.metadata?.namespace || 'default',
                    name: metric.metadata?.name || 'unknown',
                    cpu: totalCpu,
                    memory: totalMemory,
                    cpuPercent: cpuRequest > 0 ? (totalCpu / cpuRequest) * 100 : 0,
                    memoryPercent: memoryRequest > 0 ? (totalMemory / memoryRequest) * 100 : 0,
                    containers: containerMetrics
                });
            }

            return metrics;
        } catch (error) {
            console.error('Failed to collect pod metrics:', error);
            return [];
        }
    }

    private async collectNodeMetrics(): Promise<NodeMetrics[]> {
        try {
            const [nodes, nodeMetrics, pods] = await Promise.all([
                this.k8sClient.getNodes(),
                this.k8sClient.getNodeMetrics(),
                this.k8sClient.getPods()
            ]);

            const metrics: NodeMetrics[] = [];

            for (const metric of nodeMetrics) {
                const node = nodes.find(n => n.metadata?.name === metric.metadata?.name);
                if (!node) continue;

                const cpuUsage = this.parseCpu(metric.usage?.cpu || '0');
                const memoryUsage = this.parseMemory(metric.usage?.memory || '0');
                const cpuCapacity = this.parseCpu(node.status?.capacity?.cpu || '0');
                const memoryCapacity = this.parseMemory(node.status?.capacity?.memory || '0');

                const nodePods = pods.filter(p => p.spec?.nodeName === node.metadata?.name);
                const podCapacity = parseInt(node.status?.capacity?.pods || '0');

                metrics.push({
                    name: metric.metadata?.name || 'unknown',
                    cpu: cpuUsage,
                    memory: memoryUsage,
                    cpuCapacity,
                    memoryCapacity,
                    cpuPercent: cpuCapacity > 0 ? (cpuUsage / cpuCapacity) * 100 : 0,
                    memoryPercent: memoryCapacity > 0 ? (memoryUsage / memoryCapacity) * 100 : 0,
                    podCount: nodePods.length,
                    podCapacity
                });
            }

            return metrics;
        } catch (error) {
            console.error('Failed to collect node metrics:', error);
            return [];
        }
    }

    private async collectNamespaceMetrics(): Promise<NamespaceMetrics[]> {
        try {
            const pods = await this.k8sClient.getPods();
            const namespaceMap = new Map<string, NamespaceMetrics>();

            for (const pod of pods) {
                const namespace = pod.metadata?.namespace || 'default';
                
                if (!namespaceMap.has(namespace)) {
                    namespaceMap.set(namespace, {
                        namespace,
                        podCount: 0,
                        totalCpu: 0,
                        totalMemory: 0,
                        cpuRequests: 0,
                        cpuLimits: 0,
                        memoryRequests: 0,
                        memoryLimits: 0
                    });
                }

                const nsMetrics = namespaceMap.get(namespace)!;
                nsMetrics.podCount++;

                for (const container of pod.spec?.containers || []) {
                    nsMetrics.cpuRequests += this.parseCpu(container.resources?.requests?.cpu || '0');
                    nsMetrics.cpuLimits += this.parseCpu(container.resources?.limits?.cpu || '0');
                    nsMetrics.memoryRequests += this.parseMemory(container.resources?.requests?.memory || '0');
                    nsMetrics.memoryLimits += this.parseMemory(container.resources?.limits?.memory || '0');
                }
            }

            // Get actual usage from pod metrics
            try {
                const podMetrics = await this.k8sClient.getPodMetrics();
                for (const metric of podMetrics) {
                    const namespace = metric.metadata?.namespace || 'default';
                    const nsMetrics = namespaceMap.get(namespace);
                    if (!nsMetrics) continue;

                    for (const container of metric.containers || []) {
                        nsMetrics.totalCpu += this.parseCpu(container.usage?.cpu || '0');
                        nsMetrics.totalMemory += this.parseMemory(container.usage?.memory || '0');
                    }
                }
            } catch (error) {
                console.error('Failed to get pod metrics for namespaces:', error);
            }

            return Array.from(namespaceMap.values());
        } catch (error) {
            console.error('Failed to collect namespace metrics:', error);
            return [];
        }
    }

    private parseCpu(cpu: string): number {
        // Parse CPU (cores)
        if (cpu.endsWith('m')) {
            return parseInt(cpu) / 1000;
        }
        if (cpu.endsWith('n')) {
            return parseInt(cpu) / 1000000000;
        }
        return parseFloat(cpu) || 0;
    }

    private parseMemory(memory: string): number {
        // Parse memory to bytes
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
    <title>Resource Usage Dashboard</title>
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
            font-size: 24px;
        }
        .actions {
            display: flex;
            gap: 10px;
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
        .tabs {
            display: flex;
            gap: 5px;
            margin-bottom: 20px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .tab {
            padding: 10px 20px;
            cursor: pointer;
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
        }
        .tab.active {
            border-bottom-color: var(--vscode-focusBorder);
            color: var(--vscode-focusBorder);
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .chart-container {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
            height: 400px;
            position: relative;
        }
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .metric-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 15px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-charts-blue);
        }
        .metric-card.high {
            border-left-color: var(--vscode-charts-red);
        }
        .metric-card.medium {
            border-left-color: var(--vscode-charts-orange);
        }
        .metric-card.low {
            border-left-color: var(--vscode-charts-green);
        }
        .metric-name {
            font-size: 12px;
            opacity: 0.8;
            margin-bottom: 5px;
        }
        .metric-value {
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 5px;
        }
        .metric-detail {
            font-size: 11px;
            opacity: 0.7;
        }
        .table-container {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 15px;
            border-radius: 4px;
            overflow-x: auto;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th {
            text-align: left;
            padding: 10px;
            background-color: var(--vscode-editor-background);
            font-size: 11px;
            text-transform: uppercase;
            opacity: 0.8;
        }
        td {
            padding: 10px;
            border-top: 1px solid var(--vscode-editor-background);
            font-size: 12px;
        }
        .progress-bar {
            height: 8px;
            background-color: var(--vscode-editor-background);
            border-radius: 4px;
            overflow: hidden;
            margin-top: 5px;
        }
        .progress-fill {
            height: 100%;
            transition: width 0.3s;
        }
        .progress-fill.low {
            background-color: var(--vscode-charts-green);
        }
        .progress-fill.medium {
            background-color: var(--vscode-charts-orange);
        }
        .progress-fill.high {
            background-color: var(--vscode-charts-red);
        }
        .no-data {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Resource Usage Dashboard</h1>
        <div class="actions">
            <button onclick="clearHistory()">Clear History</button>
            <button onclick="refresh()">Refresh</button>
        </div>
    </div>

    <div class="tabs">
        <button class="tab active" onclick="switchTab('overview')">Overview</button>
        <button class="tab" onclick="switchTab('nodes')">Nodes</button>
        <button class="tab" onclick="switchTab('namespaces')">Namespaces</button>
        <button class="tab" onclick="switchTab('pods')">Pods</button>
    </div>

    <div id="overview" class="tab-content active">
        <div class="metrics-grid" id="overviewMetrics"></div>
        <div class="chart-container">
            <canvas id="clusterTrendChart"></canvas>
        </div>
    </div>

    <div id="nodes" class="tab-content">
        <div class="table-container">
            <table id="nodesTable">
                <thead>
                    <tr>
                        <th>Node</th>
                        <th>CPU Usage</th>
                        <th>Memory Usage</th>
                        <th>Pods</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>
    </div>

    <div id="namespaces" class="tab-content">
        <div class="table-container">
            <table id="namespacesTable">
                <thead>
                    <tr>
                        <th>Namespace</th>
                        <th>Pods</th>
                        <th>CPU Usage</th>
                        <th>Memory Usage</th>
                        <th>CPU Requests</th>
                        <th>Memory Requests</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>
    </div>

    <div id="pods" class="tab-content">
        <div class="table-container">
            <table id="podsTable">
                <thead>
                    <tr>
                        <th>Namespace</th>
                        <th>Pod</th>
                        <th>CPU Usage</th>
                        <th>Memory Usage</th>
                        <th>CPU %</th>
                        <th>Memory %</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let clusterChart = null;
        let currentData = null;
        let historyData = null;

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function clearHistory() {
            vscode.postMessage({ command: 'clearHistory' });
        }

        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabName).classList.add('active');
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
            return cores.toFixed(2) + ' cores';
        }

        function getProgressClass(percent) {
            if (percent >= 80) return 'high';
            if (percent >= 50) return 'medium';
            return 'low';
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateData') {
                currentData = message.current;
                historyData = message.history;
                renderDashboard();
            }
        });

        function renderDashboard() {
            if (!currentData) return;

            renderOverview();
            renderNodes();
            renderNamespaces();
            renderPods();
        }

        function renderOverview() {
            const { nodes, namespaces, pods } = currentData;

            // Calculate totals
            const totalCpu = nodes.reduce((sum, n) => sum + n.cpu, 0);
            const totalCpuCapacity = nodes.reduce((sum, n) => sum + n.cpuCapacity, 0);
            const totalMemory = nodes.reduce((sum, n) => sum + n.memory, 0);
            const totalMemoryCapacity = nodes.reduce((sum, n) => sum + n.memoryCapacity, 0);
            const totalPods = nodes.reduce((sum, n) => sum + n.podCount, 0);
            const totalPodCapacity = nodes.reduce((sum, n) => sum + n.podCapacity, 0);

            const cpuPercent = totalCpuCapacity > 0 ? (totalCpu / totalCpuCapacity) * 100 : 0;
            const memoryPercent = totalMemoryCapacity > 0 ? (totalMemory / totalMemoryCapacity) * 100 : 0;
            const podPercent = totalPodCapacity > 0 ? (totalPods / totalPodCapacity) * 100 : 0;

            const metricsHtml = \`
                <div class="metric-card \${getProgressClass(cpuPercent)}">
                    <div class="metric-name">Cluster CPU Usage</div>
                    <div class="metric-value">\${cpuPercent.toFixed(1)}%</div>
                    <div class="metric-detail">\${formatCpu(totalCpu)} / \${formatCpu(totalCpuCapacity)}</div>
                    <div class="progress-bar">
                        <div class="progress-fill \${getProgressClass(cpuPercent)}" style="width: \${cpuPercent}%"></div>
                    </div>
                </div>
                <div class="metric-card \${getProgressClass(memoryPercent)}">
                    <div class="metric-name">Cluster Memory Usage</div>
                    <div class="metric-value">\${memoryPercent.toFixed(1)}%</div>
                    <div class="metric-detail">\${formatBytes(totalMemory)} / \${formatBytes(totalMemoryCapacity)}</div>
                    <div class="progress-bar">
                        <div class="progress-fill \${getProgressClass(memoryPercent)}" style="width: \${memoryPercent}%"></div>
                    </div>
                </div>
                <div class="metric-card \${getProgressClass(podPercent)}">
                    <div class="metric-name">Pod Usage</div>
                    <div class="metric-value">\${podPercent.toFixed(1)}%</div>
                    <div class="metric-detail">\${totalPods} / \${totalPodCapacity} pods</div>
                    <div class="progress-bar">
                        <div class="progress-fill \${getProgressClass(podPercent)}" style="width: \${podPercent}%"></div>
                    </div>
                </div>
                <div class="metric-card">
                    <div class="metric-name">Nodes</div>
                    <div class="metric-value">\${nodes.length}</div>
                    <div class="metric-detail">\${namespaces.length} namespaces</div>
                </div>
            \`;

            document.getElementById('overviewMetrics').innerHTML = metricsHtml;

            // Render trend chart
            renderTrendChart();
        }

        function renderTrendChart() {
            if (!historyData || historyData.length === 0) return;

            const ctx = document.getElementById('clusterTrendChart');
            
            if (clusterChart) {
                clusterChart.destroy();
            }

            const labels = historyData.map(h => {
                const date = new Date(h.timestamp);
                return date.toLocaleTimeString();
            });

            const cpuData = historyData.map(h => {
                const total = h.nodes.reduce((sum, n) => sum + n.cpu, 0);
                const capacity = h.nodes.reduce((sum, n) => sum + n.cpuCapacity, 0);
                return capacity > 0 ? (total / capacity) * 100 : 0;
            });

            const memoryData = historyData.map(h => {
                const total = h.nodes.reduce((sum, n) => sum + n.memory, 0);
                const capacity = h.nodes.reduce((sum, n) => sum + n.memoryCapacity, 0);
                return capacity > 0 ? (total / capacity) * 100 : 0;
            });

            clusterChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'CPU Usage %',
                            data: cpuData,
                            borderColor: 'rgb(75, 192, 192)',
                            backgroundColor: 'rgba(75, 192, 192, 0.2)',
                            tension: 0.1
                        },
                        {
                            label: 'Memory Usage %',
                            data: memoryData,
                            borderColor: 'rgb(255, 99, 132)',
                            backgroundColor: 'rgba(255, 99, 132, 0.2)',
                            tension: 0.1
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
                            max: 100,
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

        function renderNodes() {
            const tbody = document.querySelector('#nodesTable tbody');
            tbody.innerHTML = currentData.nodes.map(node => \`
                <tr>
                    <td><strong>\${node.name}</strong></td>
                    <td>
                        \${formatCpu(node.cpu)} / \${formatCpu(node.cpuCapacity)}
                        <div class="progress-bar">
                            <div class="progress-fill \${getProgressClass(node.cpuPercent)}" style="width: \${node.cpuPercent}%"></div>
                        </div>
                        \${node.cpuPercent.toFixed(1)}%
                    </td>
                    <td>
                        \${formatBytes(node.memory)} / \${formatBytes(node.memoryCapacity)}
                        <div class="progress-bar">
                            <div class="progress-fill \${getProgressClass(node.memoryPercent)}" style="width: \${node.memoryPercent}%"></div>
                        </div>
                        \${node.memoryPercent.toFixed(1)}%
                    </td>
                    <td>\${node.podCount} / \${node.podCapacity}</td>
                </tr>
            \`).join('');
        }

        function renderNamespaces() {
            const tbody = document.querySelector('#namespacesTable tbody');
            tbody.innerHTML = currentData.namespaces
                .sort((a, b) => b.totalCpu - a.totalCpu)
                .map(ns => \`
                <tr>
                    <td><strong>\${ns.namespace}</strong></td>
                    <td>\${ns.podCount}</td>
                    <td>\${formatCpu(ns.totalCpu)}</td>
                    <td>\${formatBytes(ns.totalMemory)}</td>
                    <td>\${formatCpu(ns.cpuRequests)} (limit: \${formatCpu(ns.cpuLimits)})</td>
                    <td>\${formatBytes(ns.memoryRequests)} (limit: \${formatBytes(ns.memoryLimits)})</td>
                </tr>
            \`).join('');
        }

        function renderPods() {
            const tbody = document.querySelector('#podsTable tbody');
            tbody.innerHTML = currentData.pods
                .sort((a, b) => b.cpu - a.cpu)
                .slice(0, 50) // Top 50
                .map(pod => \`
                <tr>
                    <td>\${pod.namespace}</td>
                    <td><strong>\${pod.name}</strong></td>
                    <td>\${formatCpu(pod.cpu)}</td>
                    <td>\${formatBytes(pod.memory)}</td>
                    <td>
                        <div class="progress-bar">
                            <div class="progress-fill \${getProgressClass(pod.cpuPercent)}" style="width: \${Math.min(pod.cpuPercent, 100)}%"></div>
                        </div>
                        \${pod.cpuPercent.toFixed(1)}%
                    </td>
                    <td>
                        <div class="progress-bar">
                            <div class="progress-fill \${getProgressClass(pod.memoryPercent)}" style="width: \${Math.min(pod.memoryPercent, 100)}%"></div>
                        </div>
                        \${pod.memoryPercent.toFixed(1)}%
                    </td>
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
        ResourceUsageDashboardPanel.currentPanel = undefined;

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
