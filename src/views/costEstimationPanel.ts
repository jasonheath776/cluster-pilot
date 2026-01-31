import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

interface CostRate {
    cpuPerCoreHour: number;
    memoryPerGBHour: number;
    storagePerGBMonth: number;
}

interface ResourceCost {
    namespace: string;
    podCount: number;
    cpuCores: number;
    memoryGB: number;
    storageGB: number;
    cpuCost: number;
    memoryCost: number;
    storageCost: number;
    totalCost: number;
}

interface CostData {
    namespaces: ResourceCost[];
    cluster: {
        totalPods: number;
        totalCpuCores: number;
        totalMemoryGB: number;
        totalStorageGB: number;
        totalCost: number;
    };
    rates: CostRate;
    historicalCosts: Array<{
        timestamp: string;
        cost: number;
    }>;
}

export class CostEstimationPanel {
    public static currentPanel: CostEstimationPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _updateInterval: NodeJS.Timeout | undefined;
    private costHistory: Array<{ timestamp: string; cost: number }> = [];
    private readonly maxHistoryPoints = 24; // 24 hours of hourly data
    private costRates: CostRate = {
        cpuPerCoreHour: 0.04,     // $0.04 per core-hour (adjustable)
        memoryPerGBHour: 0.004,   // $0.004 per GB-hour (adjustable)
        storagePerGBMonth: 0.10   // $0.10 per GB-month (adjustable)
    };

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (CostEstimationPanel.currentPanel) {
            CostEstimationPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'costEstimation',
            'Cost Estimation',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        CostEstimationPanel.currentPanel = new CostEstimationPanel(panel, extensionUri, k8sClient);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private k8sClient: K8sClient) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtmlForWebview();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'refresh':
                        await this.updateCostData();
                        break;
                    case 'updateRates':
                        this.updateCostRates(message.rates);
                        await this.updateCostData();
                        break;
                    case 'exportReport':
                        await this.exportCostReport();
                        break;
                }
            },
            null,
            this._disposables
        );

        this.updateCostData();
        this._updateInterval = setInterval(() => this.updateCostData(), 60000); // Update every minute
    }

    private updateCostRates(rates: Partial<CostRate>) {
        this.costRates = {
            ...this.costRates,
            ...rates
        };
    }

    private async collectCostData(): Promise<CostData> {
        const [nodes, pods, pvcs] = await Promise.all([
            this.k8sClient.getNodes(),
            this.k8sClient.getPods(),
            this.k8sClient.getPersistentVolumeClaims()
        ]);

        // Group pods by namespace
        const namespaceMap = new Map<string, any[]>();
        for (const pod of pods) {
            const ns = pod.metadata?.namespace || 'default';
            if (!namespaceMap.has(ns)) {
                namespaceMap.set(ns, []);
            }
            namespaceMap.get(ns)!.push(pod);
        }

        // Calculate costs per namespace
        const namespaceCosts: ResourceCost[] = [];
        for (const [namespace, nsPods] of namespaceMap.entries()) {
            let cpuCores = 0;
            let memoryGB = 0;

            // Calculate resource requests (more accurate than limits for cost)
            for (const pod of nsPods) {
                const containers = pod.spec?.containers || [];
                for (const container of containers) {
                    const cpuRequest = container.resources?.requests?.cpu || '0';
                    const memoryRequest = container.resources?.requests?.memory || '0';
                    
                    cpuCores += this.parseCpu(cpuRequest);
                    memoryGB += this.parseMemory(memoryRequest) / (1024 * 1024 * 1024); // bytes to GB
                }
            }

            // Calculate storage costs for this namespace
            let storageGB = 0;
            const nsPvcs = pvcs.filter(pvc => pvc.metadata?.namespace === namespace);
            for (const pvc of nsPvcs) {
                const storage = pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || '0';
                storageGB += this.parseMemory(storage) / (1024 * 1024 * 1024); // bytes to GB
            }

            const cpuCost = cpuCores * this.costRates.cpuPerCoreHour * 24 * 30; // Monthly cost
            const memoryCost = memoryGB * this.costRates.memoryPerGBHour * 24 * 30; // Monthly cost
            const storageCost = storageGB * this.costRates.storagePerGBMonth;
            const totalCost = cpuCost + memoryCost + storageCost;

            namespaceCosts.push({
                namespace,
                podCount: nsPods.length,
                cpuCores,
                memoryGB,
                storageGB,
                cpuCost,
                memoryCost,
                storageCost,
                totalCost
            });
        }

        // Sort by total cost descending
        namespaceCosts.sort((a, b) => b.totalCost - a.totalCost);

        // Calculate cluster totals
        const clusterTotals = namespaceCosts.reduce((acc, ns) => ({
            totalPods: acc.totalPods + ns.podCount,
            totalCpuCores: acc.totalCpuCores + ns.cpuCores,
            totalMemoryGB: acc.totalMemoryGB + ns.memoryGB,
            totalStorageGB: acc.totalStorageGB + ns.storageGB,
            totalCost: acc.totalCost + ns.totalCost
        }), {
            totalPods: 0,
            totalCpuCores: 0,
            totalMemoryGB: 0,
            totalStorageGB: 0,
            totalCost: 0
        });

        // Add current cost to history
        const now = new Date();
        this.costHistory.push({
            timestamp: now.toISOString(),
            cost: clusterTotals.totalCost / 30 / 24 // hourly cost
        });

        // Keep only last N points
        if (this.costHistory.length > this.maxHistoryPoints) {
            this.costHistory = this.costHistory.slice(-this.maxHistoryPoints);
        }

        return {
            namespaces: namespaceCosts,
            cluster: clusterTotals,
            rates: this.costRates,
            historicalCosts: this.costHistory
        };
    }

    private parseCpu(cpu: string): number {
        if (!cpu) return 0;
        if (cpu.endsWith('m')) {
            return parseInt(cpu) / 1000;
        } else if (cpu.endsWith('n')) {
            return parseInt(cpu) / 1000000000;
        }
        return parseFloat(cpu);
    }

    private parseMemory(memory: string): number {
        if (!memory) return 0;
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
                return parseFloat(memory) * multiplier;
            }
        }
        return parseFloat(memory);
    }

    private async updateCostData() {
        try {
            const data = await this.collectCostData();
            this._panel.webview.postMessage({
                command: 'updateCostData',
                data
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to collect cost data: ${error}`);
        }
    }

    private async exportCostReport() {
        try {
            const data = await this.collectCostData();
            
            // Generate CSV report
            let csv = 'Namespace,Pods,CPU Cores,Memory GB,Storage GB,CPU Cost,Memory Cost,Storage Cost,Total Cost\n';
            for (const ns of data.namespaces) {
                csv += `${ns.namespace},${ns.podCount},${ns.cpuCores.toFixed(2)},${ns.memoryGB.toFixed(2)},${ns.storageGB.toFixed(2)},`;
                csv += `$${ns.cpuCost.toFixed(2)},$${ns.memoryCost.toFixed(2)},$${ns.storageCost.toFixed(2)},$${ns.totalCost.toFixed(2)}\n`;
            }
            csv += `\nCluster Total,${data.cluster.totalPods},${data.cluster.totalCpuCores.toFixed(2)},${data.cluster.totalMemoryGB.toFixed(2)},${data.cluster.totalStorageGB.toFixed(2)},,,,$${data.cluster.totalCost.toFixed(2)}\n`;
            
            // Add cost rates
            csv += `\nCost Rates:\n`;
            csv += `CPU per core-hour,$${data.rates.cpuPerCoreHour}\n`;
            csv += `Memory per GB-hour,$${data.rates.memoryPerGBHour}\n`;
            csv += `Storage per GB-month,$${data.rates.storagePerGBMonth}\n`;

            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`cluster-cost-report-${new Date().toISOString().split('T')[0]}.csv`),
                filters: { 'CSV Files': ['csv'] }
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'));
                vscode.window.showInformationMessage('Cost report exported successfully');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export cost report: ${error}`);
        }
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cost Estimation</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            margin: 0;
        }

        h1, h2 {
            color: var(--vscode-foreground);
            margin-top: 0;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .buttons {
            display: flex;
            gap: 10px;
        }

        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            border-radius: 2px;
        }

        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }

        .card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 15px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-textLink-foreground);
        }

        .card-title {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 5px;
        }

        .card-value {
            font-size: 1.8em;
            font-weight: bold;
            margin-bottom: 5px;
        }

        .card-subtitle {
            font-size: 0.8em;
            color: var(--vscode-descriptionForeground);
        }

        .rates-section {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            border-radius: 4px;
            margin-bottom: 30px;
        }

        .rates-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }

        .rate-input {
            display: flex;
            flex-direction: column;
        }

        .rate-input label {
            margin-bottom: 5px;
            font-size: 0.9em;
        }

        .rate-input input {
            padding: 6px 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
        }

        .chart-container {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            border-radius: 4px;
            margin-bottom: 30px;
            height: 300px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }

        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        th {
            background-color: var(--vscode-editor-background);
            font-weight: bold;
            position: sticky;
            top: 0;
        }

        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .cost-high {
            color: #f48771;
        }

        .cost-medium {
            color: #dcdcaa;
        }

        .cost-low {
            color: #4ec9b0;
        }

        .breakdown {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }

        .tab-container {
            margin-bottom: 20px;
        }

        .tabs {
            display: flex;
            gap: 5px;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 20px;
        }

        .tab {
            padding: 10px 20px;
            cursor: pointer;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
        }

        .tab.active {
            border-bottom: 2px solid var(--vscode-textLink-foreground);
            color: var(--vscode-textLink-foreground);
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        .forecast {
            margin-top: 30px;
            padding: 20px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
        }

        .forecast-value {
            font-size: 1.5em;
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>💰 Cost Estimation</h1>
        <div class="buttons">
            <button onclick="refresh()">Refresh</button>
            <button onclick="exportReport()">Export Report</button>
        </div>
    </div>

    <div class="rates-section">
        <h2>Cost Rates (Adjustable)</h2>
        <div class="rates-grid">
            <div class="rate-input">
                <label>CPU Cost ($ per core-hour)</label>
                <input type="number" id="cpuRate" step="0.001" value="0.04" onchange="updateRates()">
            </div>
            <div class="rate-input">
                <label>Memory Cost ($ per GB-hour)</label>
                <input type="number" id="memoryRate" step="0.001" value="0.004" onchange="updateRates()">
            </div>
            <div class="rate-input">
                <label>Storage Cost ($ per GB-month)</label>
                <input type="number" id="storageRate" step="0.01" value="0.10" onchange="updateRates()">
            </div>
        </div>
    </div>

    <div class="summary-cards">
        <div class="card">
            <div class="card-title">Monthly Cost</div>
            <div class="card-value" id="totalCost">$0.00</div>
            <div class="card-subtitle">Estimated monthly spend</div>
        </div>
        <div class="card">
            <div class="card-title">Daily Cost</div>
            <div class="card-value" id="dailyCost">$0.00</div>
            <div class="card-subtitle">Average daily spend</div>
        </div>
        <div class="card">
            <div class="card-title">CPU Cores</div>
            <div class="card-value" id="totalCpu">0</div>
            <div class="card-subtitle">Total requested cores</div>
        </div>
        <div class="card">
            <div class="card-title">Memory</div>
            <div class="card-value" id="totalMemory">0 GB</div>
            <div class="card-subtitle">Total requested memory</div>
        </div>
        <div class="card">
            <div class="card-title">Storage</div>
            <div class="card-value" id="totalStorage">0 GB</div>
            <div class="card-subtitle">Total provisioned storage</div>
        </div>
    </div>

    <div class="tab-container">
        <div class="tabs">
            <button class="tab active" onclick="switchTab('overview')">Overview</button>
            <button class="tab" onclick="switchTab('namespaces')">By Namespace</button>
            <button class="tab" onclick="switchTab('breakdown')">Cost Breakdown</button>
            <button class="tab" onclick="switchTab('trends')">Trends</button>
        </div>

        <div id="overview-tab" class="tab-content active">
            <div class="chart-container">
                <canvas id="costPieChart"></canvas>
            </div>
            <div class="forecast">
                <h3>Forecast</h3>
                <div>Next Month Estimate: <span class="forecast-value" id="nextMonthForecast">$0.00</span></div>
                <div style="margin-top: 10px;">
                    <span class="breakdown">Based on current resource requests and usage patterns</span>
                </div>
            </div>
        </div>

        <div id="namespaces-tab" class="tab-content">
            <table id="namespacesTable">
                <thead>
                    <tr>
                        <th>Namespace</th>
                        <th>Pods</th>
                        <th>CPU Cores</th>
                        <th>Memory (GB)</th>
                        <th>Storage (GB)</th>
                        <th>Monthly Cost</th>
                        <th>% of Total</th>
                    </tr>
                </thead>
                <tbody id="namespacesBody"></tbody>
            </table>
        </div>

        <div id="breakdown-tab" class="tab-content">
            <div class="chart-container">
                <canvas id="breakdownChart"></canvas>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Cost Component</th>
                        <th>Monthly Cost</th>
                        <th>% of Total</th>
                    </tr>
                </thead>
                <tbody id="breakdownBody"></tbody>
            </table>
        </div>

        <div id="trends-tab" class="tab-content">
            <div class="chart-container">
                <canvas id="trendsChart"></canvas>
            </div>
            <p class="breakdown">Hourly cost trend over the last 24 hours</p>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let costData = null;
        let costPieChart = null;
        let breakdownChart = null;
        let trendsChart = null;

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateCostData') {
                costData = message.data;
                updateUI();
            }
        });

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function updateRates() {
            const rates = {
                cpuPerCoreHour: parseFloat(document.getElementById('cpuRate').value),
                memoryPerGBHour: parseFloat(document.getElementById('memoryRate').value),
                storagePerGBMonth: parseFloat(document.getElementById('storageRate').value)
            };
            vscode.postMessage({ command: 'updateRates', rates });
        }

        function exportReport() {
            vscode.postMessage({ command: 'exportReport' });
        }

        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabName + '-tab').classList.add('active');

            if (tabName === 'overview' && costData) {
                updateCostPieChart();
            } else if (tabName === 'breakdown' && costData) {
                updateBreakdownChart();
            } else if (tabName === 'trends' && costData) {
                updateTrendsChart();
            }
        }

        function updateUI() {
            if (!costData) return;

            // Update summary cards
            document.getElementById('totalCost').textContent = '$' + costData.cluster.totalCost.toFixed(2);
            document.getElementById('dailyCost').textContent = '$' + (costData.cluster.totalCost / 30).toFixed(2);
            document.getElementById('totalCpu').textContent = costData.cluster.totalCpuCores.toFixed(2);
            document.getElementById('totalMemory').textContent = costData.cluster.totalMemoryGB.toFixed(2) + ' GB';
            document.getElementById('totalStorage').textContent = costData.cluster.totalStorageGB.toFixed(2) + ' GB';
            document.getElementById('nextMonthForecast').textContent = '$' + costData.cluster.totalCost.toFixed(2);

            // Update cost rates
            document.getElementById('cpuRate').value = costData.rates.cpuPerCoreHour;
            document.getElementById('memoryRate').value = costData.rates.memoryPerGBHour;
            document.getElementById('storageRate').value = costData.rates.storagePerGBMonth;

            updateNamespacesTable();
            updateBreakdownTable();
            updateCostPieChart();
            updateBreakdownChart();
            updateTrendsChart();
        }

        function updateNamespacesTable() {
            const tbody = document.getElementById('namespacesBody');
            tbody.innerHTML = '';

            costData.namespaces.forEach(ns => {
                const percentage = (ns.totalCost / costData.cluster.totalCost * 100).toFixed(1);
                const costClass = ns.totalCost > 100 ? 'cost-high' : ns.totalCost > 10 ? 'cost-medium' : 'cost-low';

                tbody.innerHTML += \`
                    <tr>
                        <td><strong>\${ns.namespace}</strong></td>
                        <td>\${ns.podCount}</td>
                        <td>\${ns.cpuCores.toFixed(2)}</td>
                        <td>\${ns.memoryGB.toFixed(2)}</td>
                        <td>\${ns.storageGB.toFixed(2)}</td>
                        <td class="\${costClass}">$\${ns.totalCost.toFixed(2)}</td>
                        <td>\${percentage}%</td>
                    </tr>
                \`;
            });
        }

        function updateBreakdownTable() {
            const tbody = document.getElementById('breakdownBody');
            tbody.innerHTML = '';

            const totalCpuCost = costData.namespaces.reduce((sum, ns) => sum + ns.cpuCost, 0);
            const totalMemoryCost = costData.namespaces.reduce((sum, ns) => sum + ns.memoryCost, 0);
            const totalStorageCost = costData.namespaces.reduce((sum, ns) => sum + ns.storageCost, 0);
            const total = totalCpuCost + totalMemoryCost + totalStorageCost;

            const components = [
                { name: 'CPU', cost: totalCpuCost },
                { name: 'Memory', cost: totalMemoryCost },
                { name: 'Storage', cost: totalStorageCost }
            ];

            components.forEach(comp => {
                const percentage = (comp.cost / total * 100).toFixed(1);
                tbody.innerHTML += \`
                    <tr>
                        <td><strong>\${comp.name}</strong></td>
                        <td>$\${comp.cost.toFixed(2)}</td>
                        <td>\${percentage}%</td>
                    </tr>
                \`;
            });
        }

        function updateCostPieChart() {
            const ctx = document.getElementById('costPieChart').getContext('2d');
            
            if (costPieChart) {
                costPieChart.destroy();
            }

            const topNamespaces = costData.namespaces.slice(0, 10);
            const othersCost = costData.namespaces.slice(10).reduce((sum, ns) => sum + ns.totalCost, 0);

            const labels = topNamespaces.map(ns => ns.namespace);
            const data = topNamespaces.map(ns => ns.totalCost);

            if (othersCost > 0) {
                labels.push('Others');
                data.push(othersCost);
            }

            costPieChart = new Chart(ctx, {
                type: 'pie',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: [
                            '#4ec9b0', '#ce9178', '#dcdcaa', '#569cd6', '#c586c0',
                            '#9cdcfe', '#f48771', '#b5cea8', '#d4d4d4', '#808080', '#666666'
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'right',
                            labels: { color: 'var(--vscode-foreground)' }
                        },
                        tooltip: {
                            callbacks: {
                                label: (context) => {
                                    const label = context.label || '';
                                    const value = context.parsed || 0;
                                    return label + ': $' + value.toFixed(2);
                                }
                            }
                        }
                    }
                }
            });
        }

        function updateBreakdownChart() {
            const ctx = document.getElementById('breakdownChart').getContext('2d');
            
            if (breakdownChart) {
                breakdownChart.destroy();
            }

            const totalCpuCost = costData.namespaces.reduce((sum, ns) => sum + ns.cpuCost, 0);
            const totalMemoryCost = costData.namespaces.reduce((sum, ns) => sum + ns.memoryCost, 0);
            const totalStorageCost = costData.namespaces.reduce((sum, ns) => sum + ns.storageCost, 0);

            breakdownChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: ['CPU', 'Memory', 'Storage'],
                    datasets: [{
                        label: 'Monthly Cost ($)',
                        data: [totalCpuCost, totalMemoryCost, totalStorageCost],
                        backgroundColor: ['#4ec9b0', '#ce9178', '#dcdcaa']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                color: 'var(--vscode-foreground)',
                                callback: (value) => '$' + value.toFixed(0)
                            },
                            grid: { color: 'var(--vscode-panel-border)' }
                        },
                        x: {
                            ticks: { color: 'var(--vscode-foreground)' },
                            grid: { color: 'var(--vscode-panel-border)' }
                        }
                    },
                    plugins: {
                        legend: {
                            labels: { color: 'var(--vscode-foreground)' }
                        }
                    }
                }
            });
        }

        function updateTrendsChart() {
            const ctx = document.getElementById('trendsChart').getContext('2d');
            
            if (trendsChart) {
                trendsChart.destroy();
            }

            if (!costData.historicalCosts || costData.historicalCosts.length === 0) {
                return;
            }

            const labels = costData.historicalCosts.map(h => {
                const date = new Date(h.timestamp);
                return date.getHours() + ':00';
            });
            const data = costData.historicalCosts.map(h => h.cost);

            trendsChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Hourly Cost ($)',
                        data: data,
                        borderColor: '#4ec9b0',
                        backgroundColor: 'rgba(78, 201, 176, 0.1)',
                        tension: 0.4,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                color: 'var(--vscode-foreground)',
                                callback: (value) => '$' + value.toFixed(3)
                            },
                            grid: { color: 'var(--vscode-panel-border)' }
                        },
                        x: {
                            ticks: { color: 'var(--vscode-foreground)' },
                            grid: { color: 'var(--vscode-panel-border)' }
                        }
                    },
                    plugins: {
                        legend: {
                            labels: { color: 'var(--vscode-foreground)' }
                        }
                    }
                }
            });
        }

        // Initial load
        refresh();
    </script>
</body>
</html>`;
    }

    public dispose() {
        CostEstimationPanel.currentPanel = undefined;

        if (this._updateInterval) {
            clearInterval(this._updateInterval);
        }

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
