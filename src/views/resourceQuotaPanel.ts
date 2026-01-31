import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';

interface QuotaStatus {
    resource: string;
    used: string;
    hard: string;
    percentage: number;
}

interface LimitRangeConstraint {
    type: string;
    resource: string;
    min?: string;
    max?: string;
    default?: string;
    defaultRequest?: string;
    maxLimitRequestRatio?: string;
}

export class ResourceQuotaPanel {
    public static currentPanel: ResourceQuotaPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ResourceQuotaPanel.currentPanel) {
            ResourceQuotaPanel.currentPanel.panel.reveal(column);
            ResourceQuotaPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'resourceQuota',
            'Resource Quotas & Limits',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        ResourceQuotaPanel.currentPanel = new ResourceQuotaPanel(panel, extensionUri, k8sClient);
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
                    case 'deleteQuota':
                        await this.deleteQuota(message.name, message.namespace);
                        break;
                    case 'deleteLimitRange':
                        await this.deleteLimitRange(message.name, message.namespace);
                        break;
                    case 'viewYaml':
                        await this.viewYaml(message.type, message.name, message.namespace);
                        break;
                    case 'createQuota':
                        await this.createQuotaTemplate();
                        break;
                    case 'createLimitRange':
                        await this.createLimitRangeTemplate();
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
            const [quotas, limitRanges] = await Promise.all([
                this.k8sClient.getResourceQuotas(),
                this.k8sClient.getLimitRanges()
            ]);

            const quotaData = quotas.map(quota => {
                const namespace = quota.metadata?.namespace || 'default';
                const name = quota.metadata?.name || 'unknown';
                const statusItems: QuotaStatus[] = [];

                const hard = quota.status?.hard || {};
                const used = quota.status?.used || {};

                for (const resource in hard) {
                    const hardValue = hard[resource];
                    const usedValue = used[resource] || '0';
                    
                    const hardNum = this.parseResourceValue(hardValue);
                    const usedNum = this.parseResourceValue(usedValue);
                    const percentage = hardNum > 0 ? (usedNum / hardNum) * 100 : 0;

                    statusItems.push({
                        resource,
                        used: usedValue,
                        hard: hardValue,
                        percentage: Math.round(percentage)
                    });
                }

                return {
                    name,
                    namespace,
                    statusItems
                };
            });

            const limitRangeData = limitRanges.map(lr => {
                const namespace = lr.metadata?.namespace || 'default';
                const name = lr.metadata?.name || 'unknown';
                const constraints: LimitRangeConstraint[] = [];

                (lr.spec?.limits || []).forEach(limit => {
                    const type = limit.type || 'Unknown';
                    
                    for (const resource in (limit.max || {})) {
                        constraints.push({
                            type,
                            resource,
                            max: limit.max?.[resource],
                            min: limit.min?.[resource],
                            default: limit._default?.[resource],
                            defaultRequest: limit.defaultRequest?.[resource],
                            maxLimitRequestRatio: limit.maxLimitRequestRatio?.[resource]
                        });
                    }

                    // Also add resources that only have min, default, or defaultRequest
                    for (const resource in (limit.min || {})) {
                        if (!constraints.find(c => c.resource === resource && c.type === type)) {
                            constraints.push({
                                type,
                                resource,
                                min: limit.min?.[resource],
                                max: limit.max?.[resource],
                                default: limit._default?.[resource],
                                defaultRequest: limit.defaultRequest?.[resource]
                            });
                        }
                    }

                    for (const resource in (limit._default || {})) {
                        if (!constraints.find(c => c.resource === resource && c.type === type)) {
                            constraints.push({
                                type,
                                resource,
                                default: limit._default?.[resource],
                                defaultRequest: limit.defaultRequest?.[resource]
                            });
                        }
                    }
                });

                return {
                    name,
                    namespace,
                    constraints
                };
            });

            this.panel.webview.postMessage({
                command: 'updateData',
                quotas: quotaData,
                limitRanges: limitRangeData
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh resource quotas: ${error}`);
        }
    }

    private parseResourceValue(value: string): number {
        // Parse Kubernetes resource values (e.g., "100m", "1Gi", "10")
        if (value.endsWith('m')) {
            return parseFloat(value.slice(0, -1)) / 1000;
        } else if (value.endsWith('Ki')) {
            return parseFloat(value.slice(0, -2)) * 1024;
        } else if (value.endsWith('Mi')) {
            return parseFloat(value.slice(0, -2)) * 1024 * 1024;
        } else if (value.endsWith('Gi')) {
            return parseFloat(value.slice(0, -2)) * 1024 * 1024 * 1024;
        } else if (value.endsWith('Ti')) {
            return parseFloat(value.slice(0, -2)) * 1024 * 1024 * 1024 * 1024;
        }
        return parseFloat(value);
    }

    private async deleteQuota(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete ResourceQuota "${name}" in namespace "${namespace}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            await this.k8sClient.deleteResourceQuota(name, namespace);
            vscode.window.showInformationMessage(`ResourceQuota ${name} deleted`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete ResourceQuota: ${error}`);
        }
    }

    private async deleteLimitRange(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete LimitRange "${name}" in namespace "${namespace}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            await this.k8sClient.deleteLimitRange(name, namespace);
            vscode.window.showInformationMessage(`LimitRange ${name} deleted`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete LimitRange: ${error}`);
        }
    }

    private async viewYaml(type: string, name: string, namespace: string) {
        try {
            let resource: unknown;

            if (type === 'quota') {
                const quotas = await this.k8sClient.getResourceQuotas(namespace);
                resource = quotas.find(q => q.metadata?.name === name);
            } else {
                const limitRanges = await this.k8sClient.getLimitRanges(namespace);
                resource = limitRanges.find(lr => lr.metadata?.name === name);
            }

            if (!resource) {
                vscode.window.showErrorMessage(`Resource not found`);
                return;
            }

            const yaml = JSON.stringify(resource, null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: yaml,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view resource: ${error}`);
        }
    }

    private async createQuotaTemplate() {
        const template = `apiVersion: v1
kind: ResourceQuota
metadata:
  name: example-quota
  namespace: default
spec:
  hard:
    requests.cpu: "4"
    requests.memory: "8Gi"
    limits.cpu: "8"
    limits.memory: "16Gi"
    persistentvolumeclaims: "10"
    pods: "50"
    services: "20"
    configmaps: "20"
    secrets: "20"`;

        const doc = await vscode.workspace.openTextDocument({
            content: template,
            language: 'yaml'
        });
        await vscode.window.showTextDocument(doc);
    }

    private async createLimitRangeTemplate() {
        const template = `apiVersion: v1
kind: LimitRange
metadata:
  name: example-limitrange
  namespace: default
spec:
  limits:
  - max:
      cpu: "2"
      memory: "4Gi"
    min:
      cpu: "100m"
      memory: "128Mi"
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "200m"
      memory: "256Mi"
    type: Container
  - max:
      cpu: "4"
      memory: "8Gi"
    min:
      cpu: "200m"
      memory: "256Mi"
    type: Pod`;

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
    <title>Resource Quotas & Limits</title>
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
        .section {
            margin-bottom: 30px;
        }
        .section-title {
            font-size: 20px;
            font-weight: bold;
            margin-bottom: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 15px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-charts-blue);
        }
        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .card-title {
            font-size: 16px;
            font-weight: bold;
        }
        .card-namespace {
            font-size: 12px;
            opacity: 0.8;
            margin-left: 10px;
        }
        .card-actions {
            display: flex;
            gap: 5px;
        }
        .card-actions button {
            padding: 4px 8px;
            font-size: 12px;
        }
        .quota-item {
            margin: 10px 0;
        }
        .quota-resource {
            font-weight: 500;
            margin-bottom: 5px;
            display: flex;
            justify-content: space-between;
        }
        .quota-values {
            font-size: 12px;
            opacity: 0.8;
        }
        .progress-bar {
            width: 100%;
            height: 20px;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
            overflow: hidden;
            position: relative;
            margin-top: 5px;
        }
        .progress-fill {
            height: 100%;
            background-color: var(--vscode-charts-green);
            transition: width 0.3s;
        }
        .progress-fill.warning {
            background-color: var(--vscode-charts-orange);
        }
        .progress-fill.critical {
            background-color: var(--vscode-charts-red);
        }
        .progress-text {
            position: absolute;
            top: 2px;
            left: 5px;
            font-size: 11px;
            font-weight: bold;
        }
        .constraint-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }
        .constraint-table th,
        .constraint-table td {
            text-align: left;
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 13px;
        }
        .constraint-table th {
            background-color: var(--vscode-editor-background);
            font-weight: 600;
        }
        .type-badge {
            display: inline-block;
            padding: 2px 6px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-size: 11px;
        }
        .no-data {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
        .info-box {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-charts-blue);
            padding: 10px 15px;
            margin-bottom: 20px;
            border-radius: 3px;
        }
        .info-box h3 {
            margin: 0 0 5px 0;
            font-size: 14px;
        }
        .info-box p {
            margin: 0;
            font-size: 12px;
            opacity: 0.9;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Resource Quotas & Limit Ranges</h1>
        <div class="actions">
            <button onclick="createQuota()">Create Quota Template</button>
            <button onclick="createLimitRange()">Create LimitRange Template</button>
            <button onclick="refresh()">Refresh</button>
        </div>
    </div>

    <div class="info-box">
        <h3>About Resource Management</h3>
        <p>ResourceQuotas limit aggregate resource consumption per namespace. LimitRanges set default resource requests/limits and enforce min/max constraints for individual pods and containers.</p>
    </div>

    <div class="section">
        <div class="section-title">
            <span>Resource Quotas</span>
        </div>
        <div id="quotasContainer">
            <div class="no-data">Loading...</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">
            <span>Limit Ranges</span>
        </div>
        <div id="limitRangesContainer">
            <div class="no-data">Loading...</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function deleteQuota(name, namespace) {
            vscode.postMessage({
                command: 'deleteQuota',
                name: name,
                namespace: namespace
            });
        }

        function deleteLimitRange(name, namespace) {
            vscode.postMessage({
                command: 'deleteLimitRange',
                name: name,
                namespace: namespace
            });
        }

        function viewYaml(type, name, namespace) {
            vscode.postMessage({
                command: 'viewYaml',
                type: type,
                name: name,
                namespace: namespace
            });
        }

        function createQuota() {
            vscode.postMessage({ command: 'createQuota' });
        }

        function createLimitRange() {
            vscode.postMessage({ command: 'createLimitRange' });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateData') {
                renderQuotas(message.quotas);
                renderLimitRanges(message.limitRanges);
            }
        });

        function renderQuotas(quotas) {
            const container = document.getElementById('quotasContainer');
            
            if (quotas.length === 0) {
                container.innerHTML = '<div class="no-data">No resource quotas found</div>';
                return;
            }

            container.innerHTML = quotas.map(quota => {
                const items = quota.statusItems.map(item => {
                    let fillClass = '';
                    if (item.percentage >= 90) {
                        fillClass = 'critical';
                    } else if (item.percentage >= 70) {
                        fillClass = 'warning';
                    }

                    return \`
                        <div class="quota-item">
                            <div class="quota-resource">
                                <span>\${item.resource}</span>
                                <span class="quota-values">\${item.used} / \${item.hard}</span>
                            </div>
                            <div class="progress-bar">
                                <div class="progress-fill \${fillClass}" style="width: \${Math.min(item.percentage, 100)}%"></div>
                                <div class="progress-text">\${item.percentage}%</div>
                            </div>
                        </div>
                    \`;
                }).join('');

                return \`
                    <div class="card">
                        <div class="card-header">
                            <div>
                                <span class="card-title">\${quota.name}</span>
                                <span class="card-namespace">namespace: \${quota.namespace}</span>
                            </div>
                            <div class="card-actions">
                                <button onclick="viewYaml('quota', '\${quota.name}', '\${quota.namespace}')">View YAML</button>
                                <button onclick="deleteQuota('\${quota.name}', '\${quota.namespace}')">Delete</button>
                            </div>
                        </div>
                        \${items}
                    </div>
                \`;
            }).join('');
        }

        function renderLimitRanges(limitRanges) {
            const container = document.getElementById('limitRangesContainer');
            
            if (limitRanges.length === 0) {
                container.innerHTML = '<div class="no-data">No limit ranges found</div>';
                return;
            }

            container.innerHTML = limitRanges.map(lr => {
                const rows = lr.constraints.map(c => \`
                    <tr>
                        <td><span class="type-badge">\${c.type}</span></td>
                        <td>\${c.resource}</td>
                        <td>\${c.min || '-'}</td>
                        <td>\${c.max || '-'}</td>
                        <td>\${c.default || '-'}</td>
                        <td>\${c.defaultRequest || '-'}</td>
                        <td>\${c.maxLimitRequestRatio || '-'}</td>
                    </tr>
                \`).join('');

                return \`
                    <div class="card">
                        <div class="card-header">
                            <div>
                                <span class="card-title">\${lr.name}</span>
                                <span class="card-namespace">namespace: \${lr.namespace}</span>
                            </div>
                            <div class="card-actions">
                                <button onclick="viewYaml('limitrange', '\${lr.name}', '\${lr.namespace}')">View YAML</button>
                                <button onclick="deleteLimitRange('\${lr.name}', '\${lr.namespace}')">Delete</button>
                            </div>
                        </div>
                        <table class="constraint-table">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Resource</th>
                                    <th>Min</th>
                                    <th>Max</th>
                                    <th>Default</th>
                                    <th>Default Request</th>
                                    <th>Max Ratio</th>
                                </tr>
                            </thead>
                            <tbody>
                                \${rows}
                            </tbody>
                        </table>
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
        ResourceQuotaPanel.currentPanel = undefined;

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
