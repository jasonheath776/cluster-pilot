import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

interface PDBInfo {
    name: string;
    namespace: string;
    minAvailable?: string | number;
    maxUnavailable?: string | number;
    currentHealthy: number;
    desiredHealthy: number;
    disruptionsAllowed: number;
    expectedPods: number;
    selector: { [key: string]: string };
    matchingPods: Array<{
        name: string;
        ready: boolean;
        status: string;
    }>;
    conditions: Array<{
        type: string;
        status: string;
        reason?: string;
        message?: string;
    }>;
}

export class PDBManagerPanel {
    public static currentPanel: PDBManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (PDBManagerPanel.currentPanel) {
            PDBManagerPanel.currentPanel.panel.reveal(column);
            PDBManagerPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'pdbManager',
            'Pod Disruption Budget Management',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        PDBManagerPanel.currentPanel = new PDBManagerPanel(panel, extensionUri, k8sClient);
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
                    case 'delete':
                        await this.deletePDB(message.name, message.namespace);
                        break;
                    case 'viewYaml':
                        await this.viewYaml(message.name, message.namespace);
                        break;
                    case 'viewPods':
                        await this.viewPods(message.selector, message.namespace);
                        break;
                    case 'createTemplate':
                        await this.createTemplate(message.type);
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
            const pdbs = await this.k8sClient.getPodDisruptionBudgets();
            const pdbInfos: PDBInfo[] = [];

            for (const pdb of pdbs) {
                const namespace = pdb.metadata?.namespace || 'default';
                const name = pdb.metadata?.name || 'unknown';

                // Get selector
                const selector = pdb.spec?.selector?.matchLabels || {};

                // Get matching pods
                const pods = await this.k8sClient.getPods(namespace);
                const matchingPods = pods.filter(pod => {
                    const labels = pod.metadata?.labels || {};
                    return Object.entries(selector).every(([key, value]) => labels[key] === value);
                });

                const podDetails = matchingPods.map(pod => ({
                    name: pod.metadata?.name || 'unknown',
                    ready: pod.status?.containerStatuses?.every(c => c.ready) || false,
                    status: pod.status?.phase || 'Unknown'
                }));

                const conditions = (pdb.status?.conditions || []).map(c => ({
                    type: c.type || 'Unknown',
                    status: c.status || 'Unknown',
                    reason: c.reason,
                    message: c.message
                }));

                pdbInfos.push({
                    name,
                    namespace,
                    minAvailable: pdb.spec?.minAvailable,
                    maxUnavailable: pdb.spec?.maxUnavailable,
                    currentHealthy: pdb.status?.currentHealthy || 0,
                    desiredHealthy: pdb.status?.desiredHealthy || 0,
                    disruptionsAllowed: pdb.status?.disruptionsAllowed || 0,
                    expectedPods: pdb.status?.expectedPods || 0,
                    selector,
                    matchingPods: podDetails,
                    conditions
                });
            }

            this.panel.webview.postMessage({
                command: 'updateData',
                pdbs: pdbInfos
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh PDBs: ${error}`);
        }
    }

    private async deletePDB(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete Pod Disruption Budget "${name}" in namespace "${namespace}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            await this.k8sClient.deletePodDisruptionBudget(name, namespace);
            vscode.window.showInformationMessage(`PDB ${name} deleted`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete PDB: ${error}`);
        }
    }

    private async viewYaml(name: string, namespace: string) {
        try {
            const pdbs = await this.k8sClient.getPodDisruptionBudgets(namespace);
            const pdb = pdbs.find(p => p.metadata?.name === name);

            if (!pdb) {
                vscode.window.showErrorMessage(`PDB ${name} not found`);
                return;
            }

            const yaml = JSON.stringify(pdb, null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: yaml,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view PDB: ${error}`);
        }
    }

    private async viewPods(selector: { [key: string]: string }, namespace: string) {
        try {
            const pods = await this.k8sClient.getPods(namespace);
            const matchingPods = pods.filter(pod => {
                const labels = pod.metadata?.labels || {};
                return Object.entries(selector).every(([key, value]) => labels[key] === value);
            });

            if (matchingPods.length === 0) {
                vscode.window.showInformationMessage('No pods found matching selector');
                return;
            }

            const podInfo = matchingPods.map(pod => {
                const status = pod.status?.phase || 'Unknown';
                const ready = pod.status?.containerStatuses?.every(c => c.ready) ? '✓' : '✗';
                const node = pod.spec?.nodeName || 'unscheduled';
                return `${ready} ${pod.metadata?.name} - ${status} (Node: ${node})`;
            }).join('\n');

            const doc = await vscode.workspace.openTextDocument({
                content: `Pods matching selector:\n${JSON.stringify(selector, null, 2)}\n\n${podInfo}`,
                language: 'plaintext'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view pods: ${error}`);
        }
    }

    private async createTemplate(type: string) {
        let template = '';

        switch (type) {
            case 'minAvailable':
                template = `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: example-pdb-minavailable
  namespace: default
spec:
  minAvailable: 2  # Minimum pods that must remain available
  selector:
    matchLabels:
      app: example
      tier: frontend
# Use minAvailable when you want to ensure a minimum number
# of pods are always running (e.g., for high availability)`;
                break;

            case 'minAvailablePercent':
                template = `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: example-pdb-percent
  namespace: default
spec:
  minAvailable: 80%  # At least 80% of pods must remain available
  selector:
    matchLabels:
      app: example
# Use percentage when scaling dynamically
# 80% means if you have 10 pods, at least 8 must stay up`;
                break;

            case 'maxUnavailable':
                template = `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: example-pdb-maxunavailable
  namespace: default
spec:
  maxUnavailable: 1  # Maximum 1 pod can be down at a time
  selector:
    matchLabels:
      app: example
# Use maxUnavailable when you want to limit disruptions
# (e.g., during node drains or cluster upgrades)`;
                break;

            case 'maxUnavailablePercent':
                template = `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: example-pdb-maxpercent
  namespace: default
spec:
  maxUnavailable: 20%  # Maximum 20% can be unavailable
  selector:
    matchLabels:
      app: example
# Useful for controlled rolling updates
# 20% means if you have 10 pods, max 2 can be down`;
                break;

            case 'singlePod':
                template = `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: example-pdb-single
  namespace: default
spec:
  minAvailable: 1  # At least 1 pod must always be available
  selector:
    matchLabels:
      app: example
# For services that must never have zero pods
# Protects against accidental complete shutdown`;
                break;

            default:
                template = `# Unknown PDB type`;
        }

        const doc = await vscode.workspace.openTextDocument({
            content: template,
            language: 'yaml'
        });
        await vscode.window.showTextDocument(doc);
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pod Disruption Budget Management</title>
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
            font-size: 24px;
        }
        .subtitle {
            font-size: 12px;
            opacity: 0.7;
            margin-top: 5px;
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
        .dropdown {
            position: relative;
            display: inline-block;
        }
        .dropdown-content {
            display: none;
            position: absolute;
            background-color: var(--vscode-dropdown-background);
            min-width: 200px;
            box-shadow: 0px 8px 16px 0px rgba(0,0,0,0.2);
            z-index: 1;
            border: 1px solid var(--vscode-dropdown-border);
        }
        .dropdown-content button {
            width: 100%;
            text-align: left;
            padding: 12px 16px;
            display: block;
        }
        .dropdown:hover .dropdown-content {
            display: block;
        }
        .pdb-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-charts-blue);
        }
        .pdb-card.healthy {
            border-left-color: var(--vscode-charts-green);
        }
        .pdb-card.warning {
            border-left-color: var(--vscode-charts-orange);
        }
        .pdb-card.error {
            border-left-color: var(--vscode-charts-red);
        }
        .pdb-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .pdb-title {
            font-size: 18px;
            font-weight: bold;
        }
        .pdb-namespace {
            font-size: 12px;
            opacity: 0.8;
            margin-left: 10px;
        }
        .pdb-actions {
            display: flex;
            gap: 5px;
        }
        .pdb-actions button {
            padding: 4px 8px;
            font-size: 12px;
        }
        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin: 15px 0;
        }
        .status-box {
            background-color: var(--vscode-editor-background);
            padding: 15px;
            border-radius: 3px;
            text-align: center;
        }
        .status-label {
            font-size: 11px;
            opacity: 0.8;
            margin-bottom: 5px;
            text-transform: uppercase;
        }
        .status-value {
            font-size: 24px;
            font-weight: bold;
        }
        .status-value.good {
            color: var(--vscode-charts-green);
        }
        .status-value.warning {
            color: var(--vscode-charts-orange);
        }
        .status-value.critical {
            color: var(--vscode-charts-red);
        }
        .disruption-badge {
            display: inline-block;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: bold;
            margin: 10px 0;
        }
        .disruption-badge.allowed {
            background-color: var(--vscode-charts-green);
            color: white;
        }
        .disruption-badge.blocked {
            background-color: var(--vscode-charts-red);
            color: white;
        }
        .info-section {
            margin: 15px 0;
        }
        .info-label {
            font-size: 11px;
            opacity: 0.8;
            margin-bottom: 5px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .info-content {
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .selector-tag {
            display: inline-block;
            padding: 4px 8px;
            margin: 3px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-size: 11px;
        }
        .pod-list {
            margin: 10px 0;
        }
        .pod-item {
            padding: 8px;
            margin: 5px 0;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 3px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .pod-item.ready {
            border-left: 3px solid var(--vscode-charts-green);
        }
        .pod-item.not-ready {
            border-left: 3px solid var(--vscode-charts-red);
        }
        .pod-status-icon {
            font-size: 16px;
        }
        .pod-name {
            flex: 1;
            font-family: var(--vscode-editor-font-family);
        }
        .pod-phase {
            font-size: 10px;
            padding: 3px 6px;
            border-radius: 3px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .condition {
            padding: 10px;
            margin: 5px 0;
            border-radius: 3px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        .condition.true {
            border-left: 3px solid var(--vscode-charts-green);
        }
        .condition.false {
            border-left: 3px solid var(--vscode-charts-red);
        }
        .condition-type {
            font-weight: bold;
            margin-bottom: 5px;
        }
        .condition-message {
            font-size: 11px;
            opacity: 0.8;
        }
        .policy-display {
            font-size: 16px;
            font-weight: bold;
            padding: 15px;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
            text-align: center;
            margin: 15px 0;
        }
        .no-pdbs {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
        .health-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 5px;
        }
        .health-indicator.healthy {
            background-color: var(--vscode-charts-green);
        }
        .health-indicator.warning {
            background-color: var(--vscode-charts-orange);
        }
        .health-indicator.error {
            background-color: var(--vscode-charts-red);
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1>Pod Disruption Budget Management</h1>
            <div class="subtitle">Control pod availability during voluntary disruptions</div>
        </div>
        <div class="actions">
            <div class="dropdown">
                <button>Create Template ▾</button>
                <div class="dropdown-content">
                    <button onclick="createTemplate('minAvailable')">Min Available (Count)</button>
                    <button onclick="createTemplate('minAvailablePercent')">Min Available (Percent)</button>
                    <button onclick="createTemplate('maxUnavailable')">Max Unavailable (Count)</button>
                    <button onclick="createTemplate('maxUnavailablePercent')">Max Unavailable (Percent)</button>
                    <button onclick="createTemplate('singlePod')">Single Pod Protection</button>
                </div>
            </div>
            <button onclick="refresh()">Refresh</button>
        </div>
    </div>

    <div id="pdbsContainer">
        <div class="no-pdbs">Loading Pod Disruption Budgets...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function deletePDB(name, namespace) {
            vscode.postMessage({
                command: 'delete',
                name: name,
                namespace: namespace
            });
        }

        function viewYaml(name, namespace) {
            vscode.postMessage({
                command: 'viewYaml',
                name: name,
                namespace: namespace
            });
        }

        function viewPods(selector, namespace) {
            vscode.postMessage({
                command: 'viewPods',
                selector: selector,
                namespace: namespace
            });
        }

        function createTemplate(type) {
            vscode.postMessage({
                command: 'createTemplate',
                type: type
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateData') {
                renderPDBs(message.pdbs);
            }
        });

        function renderPDBs(pdbs) {
            const container = document.getElementById('pdbsContainer');
            
            if (pdbs.length === 0) {
                container.innerHTML = '<div class="no-pdbs">No Pod Disruption Budgets found</div>';
                return;
            }

            container.innerHTML = pdbs.map(pdb => {
                const isHealthy = pdb.disruptionsAllowed > 0 && pdb.currentHealthy >= pdb.desiredHealthy;
                const isWarning = pdb.disruptionsAllowed === 0 && pdb.currentHealthy >= pdb.desiredHealthy;
                const isError = pdb.currentHealthy < pdb.desiredHealthy;
                
                const cardClass = isHealthy ? 'healthy' : (isWarning ? 'warning' : 'error');
                const healthClass = isHealthy ? 'healthy' : (isWarning ? 'warning' : 'error');
                const healthText = isHealthy ? 'Healthy' : (isWarning ? 'At Minimum' : 'Unhealthy');

                const policyText = pdb.minAvailable 
                    ? \`Min Available: \${pdb.minAvailable}\` 
                    : \`Max Unavailable: \${pdb.maxUnavailable || 'N/A'}\`;

                const disruptionBadge = pdb.disruptionsAllowed > 0
                    ? \`<div class="disruption-badge allowed">✓ \${pdb.disruptionsAllowed} Disruption(s) Allowed</div>\`
                    : \`<div class="disruption-badge blocked">✗ No Disruptions Allowed</div>\`;

                const selectorTags = Object.entries(pdb.selector).map(([key, value]) => 
                    \`<span class="selector-tag">\${key}=\${value}</span>\`
                ).join('');

                const selectorHtml = Object.keys(pdb.selector).length > 0 ? \`
                    <div class="info-section">
                        <div class="info-label">Pod Selector</div>
                        <div class="info-content">
                            \${selectorTags}
                            <button onclick='viewPods(\${JSON.stringify(pdb.selector)}, "\${pdb.namespace}")' 
                                    style="margin-left: 10px; padding: 4px 8px; font-size: 11px;">
                                View Pods
                            </button>
                        </div>
                    </div>
                \` : '';

                const readyPods = pdb.matchingPods.filter(p => p.ready).length;
                const podsHtml = pdb.matchingPods.length > 0 ? \`
                    <div class="info-section">
                        <div class="info-label">Matching Pods (\${readyPods}/\${pdb.matchingPods.length} ready)</div>
                        <div class="pod-list">
                            \${pdb.matchingPods.map(pod => \`
                                <div class="pod-item \${pod.ready ? 'ready' : 'not-ready'}">
                                    <span class="pod-status-icon">\${pod.ready ? '✓' : '✗'}</span>
                                    <span class="pod-name">\${pod.name}</span>
                                    <span class="pod-phase">\${pod.status}</span>
                                </div>
                            \`).join('')}
                        </div>
                    </div>
                \` : '<div class="info-section"><div class="info-label">No Matching Pods</div></div>';

                const conditionsHtml = pdb.conditions.length > 0 ? \`
                    <div class="info-section">
                        <div class="info-label">Conditions</div>
                        \${pdb.conditions.map(c => \`
                            <div class="condition \${c.status.toLowerCase()}">
                                <div class="condition-type">\${c.type}: \${c.status}</div>
                                \${c.reason ? \`<div>Reason: \${c.reason}</div>\` : ''}
                                \${c.message ? \`<div class="condition-message">\${c.message}</div>\` : ''}
                            </div>
                        \`).join('')}
                    </div>
                \` : '';

                return \`
                    <div class="pdb-card \${cardClass}">
                        <div class="pdb-header">
                            <div>
                                <span class="health-indicator \${healthClass}"></span>
                                <span class="pdb-title">\${pdb.name}</span>
                                <span class="pdb-namespace">namespace: \${pdb.namespace}</span>
                            </div>
                            <div class="pdb-actions">
                                <button onclick="viewYaml('\${pdb.name}', '\${pdb.namespace}')">View YAML</button>
                                <button onclick="deletePDB('\${pdb.name}', '\${pdb.namespace}')">Delete</button>
                            </div>
                        </div>

                        <div class="policy-display">
                            \${policyText}
                        </div>

                        \${disruptionBadge}

                        <div class="status-grid">
                            <div class="status-box">
                                <div class="status-label">Current Healthy</div>
                                <div class="status-value \${pdb.currentHealthy >= pdb.desiredHealthy ? 'good' : 'critical'}">
                                    \${pdb.currentHealthy}
                                </div>
                            </div>
                            <div class="status-box">
                                <div class="status-label">Desired Healthy</div>
                                <div class="status-value">\${pdb.desiredHealthy}</div>
                            </div>
                            <div class="status-box">
                                <div class="status-label">Expected Pods</div>
                                <div class="status-value">\${pdb.expectedPods}</div>
                            </div>
                            <div class="status-box">
                                <div class="status-label">Status</div>
                                <div class="status-value" style="font-size: 14px;">\${healthText}</div>
                            </div>
                        </div>

                        \${selectorHtml}
                        \${podsHtml}
                        \${conditionsHtml}
                    </div>
                \`;
            }).join('');
        }

        // Initial load
        refresh();
    </script>
</body>
</html>`;
    }

    public dispose() {
        PDBManagerPanel.currentPanel = undefined;

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
