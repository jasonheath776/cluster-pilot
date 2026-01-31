import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

interface HPAStatus {
    name: string;
    namespace: string;
    targetRef: string;
    minReplicas: number;
    maxReplicas: number;
    currentReplicas: number;
    desiredReplicas: number;
    metrics: Array<{
        type: string;
        target: string;
        current: string;
    }>;
    conditions: Array<{
        type: string;
        status: string;
        reason?: string;
        message?: string;
    }>;
    lastScaleTime?: string;
}

export class HPAManagerPanel {
    public static currentPanel: HPAManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (HPAManagerPanel.currentPanel) {
            HPAManagerPanel.currentPanel.panel.reveal(column);
            HPAManagerPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'hpaManager',
            'HorizontalPodAutoscalers',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        HPAManagerPanel.currentPanel = new HPAManagerPanel(panel, extensionUri, k8sClient);
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
                        await this.deleteHPA(message.name, message.namespace);
                        break;
                    case 'viewYaml':
                        await this.viewYaml(message.name, message.namespace);
                        break;
                    case 'createTemplate':
                        await this.createTemplate();
                        break;
                    case 'scaleManually':
                        await this.scaleManually(message.name, message.namespace);
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
            const hpas = await this.k8sClient.getHPAs();
            const hpaStatuses: HPAStatus[] = hpas.map(hpa => {
                const targetRef = `${hpa.spec?.scaleTargetRef?.kind}/${hpa.spec?.scaleTargetRef?.name}`;
                const metrics = (hpa.spec?.metrics || []).map(metric => {
                    let type = 'Unknown';
                    let target = 'N/A';
                    let current = 'N/A';

                    if (metric.type === 'Resource') {
                        type = `Resource: ${metric.resource?.name}`;
                        if (metric.resource?.target?.type === 'Utilization') {
                            target = `${metric.resource?.target?.averageUtilization}%`;
                        } else if (metric.resource?.target?.type === 'AverageValue') {
                            target = metric.resource?.target?.averageValue || 'N/A';
                        }
                        
                        const currentMetric = hpa.status?.currentMetrics?.find(
                            m => m.type === 'Resource' && m.resource?.name === metric.resource?.name
                        );
                        if (currentMetric?.resource?.current?.averageUtilization) {
                            current = `${currentMetric.resource.current.averageUtilization}%`;
                        } else if (currentMetric?.resource?.current?.averageValue) {
                            current = currentMetric.resource.current.averageValue;
                        }
                    } else if (metric.type === 'Pods') {
                        type = 'Pods (custom)';
                        target = metric.pods?.target?.averageValue || 'N/A';
                        
                        const currentMetric = hpa.status?.currentMetrics?.find(m => m.type === 'Pods');
                        current = currentMetric?.pods?.current?.averageValue || 'N/A';
                    } else if (metric.type === 'Object') {
                        type = 'Object (custom)';
                        target = metric.object?.target?.value || 'N/A';
                        
                        const currentMetric = hpa.status?.currentMetrics?.find(m => m.type === 'Object');
                        current = currentMetric?.object?.current?.value || 'N/A';
                    }

                    return { type, target, current };
                });

                const conditions = (hpa.status?.conditions || []).map(c => ({
                    type: c.type || 'Unknown',
                    status: c.status || 'Unknown',
                    reason: c.reason,
                    message: c.message
                }));

                return {
                    name: hpa.metadata?.name || 'unknown',
                    namespace: hpa.metadata?.namespace || 'default',
                    targetRef,
                    minReplicas: hpa.spec?.minReplicas || 1,
                    maxReplicas: hpa.spec?.maxReplicas || 10,
                    currentReplicas: hpa.status?.currentReplicas || 0,
                    desiredReplicas: hpa.status?.desiredReplicas || 0,
                    metrics,
                    conditions,
                    lastScaleTime: hpa.status?.lastScaleTime?.toISOString()
                };
            });

            this.panel.webview.postMessage({
                command: 'updateData',
                hpas: hpaStatuses
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh HPAs: ${error}`);
        }
    }

    private async deleteHPA(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete HorizontalPodAutoscaler "${name}" in namespace "${namespace}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            await this.k8sClient.deleteHPA(name, namespace);
            vscode.window.showInformationMessage(`HPA ${name} deleted`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete HPA: ${error}`);
        }
    }

    private async viewYaml(name: string, namespace: string) {
        try {
            const hpas = await this.k8sClient.getHPAs(namespace);
            const hpa = hpas.find(h => h.metadata?.name === name);

            if (!hpa) {
                vscode.window.showErrorMessage(`HPA ${name} not found`);
                return;
            }

            const yaml = JSON.stringify(hpa, null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: yaml,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view HPA: ${error}`);
        }
    }

    private async createTemplate() {
        const template = `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: example-hpa
  namespace: default
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: example-deployment
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30
      - type: Pods
        value: 4
        periodSeconds: 30
      selectPolicy: Max`;

        const doc = await vscode.workspace.openTextDocument({
            content: template,
            language: 'yaml'
        });
        await vscode.window.showTextDocument(doc);
    }

    private async scaleManually(name: string, namespace: string) {
        const replicas = await vscode.window.showInputBox({
            prompt: 'Enter desired number of replicas',
            validateInput: (value) => {
                const num = parseInt(value);
                return isNaN(num) || num < 1 ? 'Please enter a valid number' : null;
            }
        });

        if (!replicas) {
            return;
        }

        try {
            // Get the HPA to find the target deployment
            const hpas = await this.k8sClient.getHPAs(namespace);
            const hpa = hpas.find(h => h.metadata?.name === name);
            
            if (!hpa) {
                vscode.window.showErrorMessage('HPA not found');
                return;
            }

            const targetName = hpa.spec?.scaleTargetRef?.name;
            const targetKind = hpa.spec?.scaleTargetRef?.kind;

            if (targetKind === 'Deployment' && targetName) {
                await this.k8sClient.scaleDeployment(targetName, namespace, parseInt(replicas));
                vscode.window.showInformationMessage(`Scaled ${targetName} to ${replicas} replicas`);
                this.refresh();
            } else {
                vscode.window.showWarningMessage('Manual scaling only supported for Deployments');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to scale: ${error}`);
        }
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HorizontalPodAutoscalers</title>
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
        .hpa-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-charts-blue);
        }
        .hpa-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .hpa-title {
            font-size: 18px;
            font-weight: bold;
        }
        .hpa-namespace {
            font-size: 12px;
            opacity: 0.8;
            margin-left: 10px;
        }
        .hpa-actions {
            display: flex;
            gap: 5px;
        }
        .hpa-actions button {
            padding: 4px 8px;
            font-size: 12px;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 15px;
        }
        .info-box {
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-radius: 3px;
        }
        .info-label {
            font-size: 11px;
            opacity: 0.8;
            margin-bottom: 5px;
        }
        .info-value {
            font-size: 16px;
            font-weight: bold;
        }
        .replicas-bar {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 15px 0;
        }
        .bar-container {
            flex: 1;
            height: 30px;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
            position: relative;
            overflow: hidden;
        }
        .bar-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--vscode-charts-green), var(--vscode-charts-blue));
            transition: width 0.3s;
        }
        .bar-label {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-weight: bold;
            font-size: 12px;
        }
        .metrics-table {
            width: 100%;
            border-collapse: collapse;
            margin: 15px 0;
        }
        .metrics-table th,
        .metrics-table td {
            text-align: left;
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 13px;
        }
        .metrics-table th {
            background-color: var(--vscode-editor-background);
            font-weight: 600;
        }
        .metric-progress {
            width: 100%;
            height: 8px;
            background-color: var(--vscode-editor-background);
            border-radius: 4px;
            overflow: hidden;
            margin-top: 3px;
        }
        .metric-progress-fill {
            height: 100%;
            background-color: var(--vscode-charts-blue);
            transition: width 0.3s;
        }
        .metric-progress-fill.warning {
            background-color: var(--vscode-charts-orange);
        }
        .metric-progress-fill.critical {
            background-color: var(--vscode-charts-red);
        }
        .conditions {
            margin-top: 15px;
        }
        .condition {
            padding: 8px;
            margin: 5px 0;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
            font-size: 12px;
        }
        .condition-status {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            margin-right: 5px;
        }
        .condition-status.true {
            background-color: var(--vscode-charts-green);
            color: white;
        }
        .condition-status.false {
            background-color: var(--vscode-charts-red);
            color: white;
        }
        .no-hpas {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
        .status-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 11px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .target-ref {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            opacity: 0.9;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>HorizontalPodAutoscalers</h1>
        <div class="actions">
            <button onclick="createTemplate()">Create HPA Template</button>
            <button onclick="refresh()">Refresh</button>
        </div>
    </div>

    <div id="hpasContainer">
        <div class="no-hpas">Loading HPAs...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function deleteHPA(name, namespace) {
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

        function createTemplate() {
            vscode.postMessage({ command: 'createTemplate' });
        }

        function scaleManually(name, namespace) {
            vscode.postMessage({
                command: 'scaleManually',
                name: name,
                namespace: namespace
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateData') {
                renderHPAs(message.hpas);
            }
        });

        function renderHPAs(hpas) {
            const container = document.getElementById('hpasContainer');
            
            if (hpas.length === 0) {
                container.innerHTML = '<div class="no-hpas">No HorizontalPodAutoscalers found</div>';
                return;
            }

            container.innerHTML = hpas.map(hpa => {
                const percentage = hpa.maxReplicas > 0 ? 
                    (hpa.currentReplicas / hpa.maxReplicas) * 100 : 0;
                
                const metricsRows = hpa.metrics.map(metric => {
                    // Try to extract percentage from current if it's a percentage
                    let currentNum = 0;
                    let targetNum = 0;
                    let showProgress = false;

                    if (metric.current.includes('%') && metric.target.includes('%')) {
                        currentNum = parseFloat(metric.current);
                        targetNum = parseFloat(metric.target);
                        showProgress = true;
                    }

                    let progressClass = '';
                    if (showProgress && currentNum > targetNum * 1.2) {
                        progressClass = 'critical';
                    } else if (showProgress && currentNum > targetNum) {
                        progressClass = 'warning';
                    }

                    const progressBar = showProgress ? \`
                        <div class="metric-progress">
                            <div class="metric-progress-fill \${progressClass}" 
                                 style="width: \${Math.min(currentNum, 100)}%"></div>
                        </div>
                    \` : '';

                    return \`
                        <tr>
                            <td>\${metric.type}</td>
                            <td>\${metric.target}</td>
                            <td>
                                \${metric.current}
                                \${progressBar}
                            </td>
                        </tr>
                    \`;
                }).join('');

                const conditionsHtml = hpa.conditions.map(c => \`
                    <div class="condition">
                        <span class="condition-status \${c.status.toLowerCase()}">\${c.status}</span>
                        <strong>\${c.type}</strong>
                        \${c.reason ? \` - \${c.reason}\` : ''}
                        \${c.message ? \`<br><small>\${c.message}</small>\` : ''}
                    </div>
                \`).join('');

                const lastScale = hpa.lastScaleTime ? 
                    new Date(hpa.lastScaleTime).toLocaleString() : 'Never';

                const scaling = hpa.currentReplicas !== hpa.desiredReplicas ? 
                    '<span class="status-badge">Scaling...</span>' : '';

                return \`
                    <div class="hpa-card">
                        <div class="hpa-header">
                            <div>
                                <span class="hpa-title">\${hpa.name}</span>
                                <span class="hpa-namespace">namespace: \${hpa.namespace}</span>
                                \${scaling}
                            </div>
                            <div class="hpa-actions">
                                <button onclick="scaleManually('\${hpa.name}', '\${hpa.namespace}')">Scale</button>
                                <button onclick="viewYaml('\${hpa.name}', '\${hpa.namespace}')">View YAML</button>
                                <button onclick="deleteHPA('\${hpa.name}', '\${hpa.namespace}')">Delete</button>
                            </div>
                        </div>

                        <div class="target-ref">Target: \${hpa.targetRef}</div>

                        <div class="info-grid">
                            <div class="info-box">
                                <div class="info-label">Min Replicas</div>
                                <div class="info-value">\${hpa.minReplicas}</div>
                            </div>
                            <div class="info-box">
                                <div class="info-label">Max Replicas</div>
                                <div class="info-value">\${hpa.maxReplicas}</div>
                            </div>
                            <div class="info-box">
                                <div class="info-label">Current Replicas</div>
                                <div class="info-value">\${hpa.currentReplicas}</div>
                            </div>
                            <div class="info-box">
                                <div class="info-label">Desired Replicas</div>
                                <div class="info-value">\${hpa.desiredReplicas}</div>
                            </div>
                        </div>

                        <div class="replicas-bar">
                            <span>Min</span>
                            <div class="bar-container">
                                <div class="bar-fill" style="width: \${percentage}%"></div>
                                <div class="bar-label">\${hpa.currentReplicas} / \${hpa.maxReplicas}</div>
                            </div>
                            <span>Max</span>
                        </div>

                        <h3>Metrics</h3>
                        <table class="metrics-table">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Target</th>
                                    <th>Current</th>
                                </tr>
                            </thead>
                            <tbody>
                                \${metricsRows}
                            </tbody>
                        </table>

                        <div class="info-grid">
                            <div class="info-box">
                                <div class="info-label">Last Scale Time</div>
                                <div class="info-value" style="font-size: 12px;">\${lastScale}</div>
                            </div>
                        </div>

                        \${hpa.conditions.length > 0 ? \`
                            <div class="conditions">
                                <h4>Conditions</h4>
                                \${conditionsHtml}
                            </div>
                        \` : ''}
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
        HPAManagerPanel.currentPanel = undefined;

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
