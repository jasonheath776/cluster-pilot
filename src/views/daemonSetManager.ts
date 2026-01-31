import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

interface DaemonSetInfo {
    name: string;
    namespace: string;
    desiredNumberScheduled: number;
    currentNumberScheduled: number;
    numberReady: number;
    numberAvailable: number;
    numberMisscheduled: number;
    updateStrategy: {
        type: string;
        maxUnavailable?: string | number;
        maxSurge?: string | number;
    };
    nodeSelector: { [key: string]: string };
    tolerations: Array<{
        key?: string;
        operator?: string;
        value?: string;
        effect?: string;
    }>;
    containerImages: string[];
    podStatus: Array<{
        nodeName: string;
        podName: string;
        ready: boolean;
        status: string;
    }>;
    minReadySeconds: number;
    revisionHistoryLimit: number;
}

export class DaemonSetManagerPanel {
    public static currentPanel: DaemonSetManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DaemonSetManagerPanel.currentPanel) {
            DaemonSetManagerPanel.currentPanel.panel.reveal(column);
            DaemonSetManagerPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'daemonSetManager',
            'DaemonSet Management',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        DaemonSetManagerPanel.currentPanel = new DaemonSetManagerPanel(panel, extensionUri, k8sClient);
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
                        await this.deleteDaemonSet(message.name, message.namespace);
                        break;
                    case 'viewYaml':
                        await this.viewYaml(message.name, message.namespace);
                        break;
                    case 'viewPods':
                        await this.viewPods(message.name, message.namespace);
                        break;
                    case 'restart':
                        await this.restartDaemonSet(message.name, message.namespace);
                        break;
                    case 'updateStrategy':
                        await this.updateStrategy(message.name, message.namespace, message.maxUnavailable);
                        break;
                    case 'createTemplate':
                        await this.createTemplate();
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
            const daemonSets = await this.k8sClient.getDaemonSets();
            const daemonSetInfos: DaemonSetInfo[] = [];

            for (const ds of daemonSets) {
                const namespace = ds.metadata?.namespace || 'default';
                const name = ds.metadata?.name || 'unknown';

                // Get pods for this DaemonSet
                const pods = await this.k8sClient.getPods(namespace);
                const dsPods = pods.filter(pod => {
                    const ownerRefs = pod.metadata?.ownerReferences || [];
                    return ownerRefs.some(ref => ref.kind === 'DaemonSet' && ref.name === name);
                });

                const podStatus = dsPods.map(pod => ({
                    nodeName: pod.spec?.nodeName || 'unscheduled',
                    podName: pod.metadata?.name || 'unknown',
                    ready: pod.status?.containerStatuses?.every(c => c.ready) || false,
                    status: pod.status?.phase || 'Unknown'
                }));

                const updateStrategy = ds.spec?.updateStrategy || {};
                const rollingUpdate = updateStrategy.rollingUpdate || {};

                const tolerations = (ds.spec?.template?.spec?.tolerations || []).map(t => ({
                    key: t.key,
                    operator: t.operator,
                    value: t.value,
                    effect: t.effect
                }));

                const containerImages = (ds.spec?.template?.spec?.containers || [])
                    .map(c => c.image || 'unknown')
                    .filter((v, i, a) => a.indexOf(v) === i); // unique

                daemonSetInfos.push({
                    name,
                    namespace,
                    desiredNumberScheduled: ds.status?.desiredNumberScheduled || 0,
                    currentNumberScheduled: ds.status?.currentNumberScheduled || 0,
                    numberReady: ds.status?.numberReady || 0,
                    numberAvailable: ds.status?.numberAvailable || 0,
                    numberMisscheduled: ds.status?.numberMisscheduled || 0,
                    updateStrategy: {
                        type: updateStrategy.type || 'RollingUpdate',
                        maxUnavailable: rollingUpdate.maxUnavailable,
                        maxSurge: rollingUpdate.maxSurge
                    },
                    nodeSelector: ds.spec?.template?.spec?.nodeSelector || {},
                    tolerations,
                    containerImages,
                    podStatus,
                    minReadySeconds: ds.spec?.minReadySeconds || 0,
                    revisionHistoryLimit: ds.spec?.revisionHistoryLimit || 10
                });
            }

            this.panel.webview.postMessage({
                command: 'updateData',
                daemonSets: daemonSetInfos
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh DaemonSets: ${error}`);
        }
    }

    private async deleteDaemonSet(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete DaemonSet "${name}" in namespace "${namespace}"? This will remove pods from all nodes.`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            await this.k8sClient.deleteDaemonSet(name, namespace);
            vscode.window.showInformationMessage(`DaemonSet ${name} deleted`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete DaemonSet: ${error}`);
        }
    }

    private async viewYaml(name: string, namespace: string) {
        try {
            const daemonSets = await this.k8sClient.getDaemonSets(namespace);
            const ds = daemonSets.find(d => d.metadata?.name === name);

            if (!ds) {
                vscode.window.showErrorMessage(`DaemonSet ${name} not found`);
                return;
            }

            const yaml = JSON.stringify(ds, null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: yaml,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view DaemonSet: ${error}`);
        }
    }

    private async viewPods(name: string, namespace: string) {
        try {
            const pods = await this.k8sClient.getPods(namespace);
            const dsPods = pods.filter(pod => {
                const ownerRefs = pod.metadata?.ownerReferences || [];
                return ownerRefs.some(ref => ref.kind === 'DaemonSet' && ref.name === name);
            });

            if (dsPods.length === 0) {
                vscode.window.showInformationMessage('No pods found for this DaemonSet');
                return;
            }

            const podInfo = dsPods.map(pod => {
                const status = pod.status?.phase || 'Unknown';
                const ready = pod.status?.containerStatuses?.every(c => c.ready) ? '✓' : '✗';
                const node = pod.spec?.nodeName || 'unscheduled';
                return `${ready} ${pod.metadata?.name} - ${status} (Node: ${node})`;
            }).join('\n');

            const doc = await vscode.workspace.openTextDocument({
                content: `Pods for DaemonSet "${name}":\n\n${podInfo}`,
                language: 'plaintext'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view pods: ${error}`);
        }
    }

    private async restartDaemonSet(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Restart DaemonSet "${name}"? This will recreate all pods.`,
            { modal: true },
            'Restart'
        );

        if (confirm !== 'Restart') {
            return;
        }

        try {
            await this.k8sClient.restartDaemonSet(name, namespace);
            vscode.window.showInformationMessage(`DaemonSet ${name} restart initiated`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to restart DaemonSet: ${error}`);
        }
    }

    private async updateStrategy(name: string, namespace: string, maxUnavailable: string) {
        try {
            const value = maxUnavailable.trim();
            if (!value) {
                vscode.window.showErrorMessage('Max unavailable value is required');
                return;
            }

            await this.k8sClient.updateDaemonSetStrategy(name, namespace, value);
            vscode.window.showInformationMessage(`DaemonSet ${name} update strategy updated`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update strategy: ${error}`);
        }
    }

    private async createTemplate() {
        const template = `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: example-daemonset
  namespace: default
  labels:
    app: example
spec:
  selector:
    matchLabels:
      app: example
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  minReadySeconds: 0
  revisionHistoryLimit: 10
  template:
    metadata:
      labels:
        app: example
    spec:
      # Run on all nodes (default)
      # nodeSelector:
      #   node-role: worker
      
      # Tolerations to run on master/tainted nodes
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      
      containers:
      - name: main
        image: nginx:latest
        ports:
        - containerPort: 80
          name: http
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 200m
            memory: 256Mi
        
        # Common DaemonSet patterns:
        # Host network access
        # hostNetwork: true
        
        # Host path volumes for node monitoring
        volumeMounts:
        - name: host-root
          mountPath: /host
          readOnly: true
      
      volumes:
      - name: host-root
        hostPath:
          path: /
          type: Directory
`;

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
    <title>DaemonSet Management</title>
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
        .daemonset-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-charts-blue);
        }
        .daemonset-card.healthy {
            border-left-color: var(--vscode-charts-green);
        }
        .daemonset-card.degraded {
            border-left-color: var(--vscode-charts-orange);
        }
        .daemonset-card.error {
            border-left-color: var(--vscode-charts-red);
        }
        .daemonset-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .daemonset-title {
            font-size: 18px;
            font-weight: bold;
        }
        .daemonset-namespace {
            font-size: 12px;
            opacity: 0.8;
            margin-left: 10px;
        }
        .daemonset-actions {
            display: flex;
            gap: 5px;
        }
        .daemonset-actions button {
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
        .status-value.error {
            color: var(--vscode-charts-red);
        }
        .progress-bar {
            height: 8px;
            background-color: var(--vscode-editor-background);
            border-radius: 4px;
            overflow: hidden;
            margin: 10px 0;
        }
        .progress-fill {
            height: 100%;
            background-color: var(--vscode-charts-green);
            transition: width 0.3s;
        }
        .progress-fill.warning {
            background-color: var(--vscode-charts-orange);
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
        .node-selector-tag {
            display: inline-block;
            padding: 4px 8px;
            margin: 3px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-size: 11px;
        }
        .toleration {
            padding: 8px;
            margin: 5px 0;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 3px;
            border-left: 3px solid var(--vscode-charts-purple);
        }
        .pod-table {
            width: 100%;
            border-collapse: collapse;
            margin: 10px 0;
        }
        .pod-table th {
            text-align: left;
            padding: 8px;
            background-color: var(--vscode-editor-background);
            font-size: 11px;
            text-transform: uppercase;
            opacity: 0.8;
        }
        .pod-table td {
            padding: 8px;
            border-top: 1px solid var(--vscode-editor-background);
        }
        .pod-table tr.ready {
            background-color: rgba(0, 255, 0, 0.05);
        }
        .pod-table tr.not-ready {
            background-color: rgba(255, 0, 0, 0.05);
        }
        .status-badge {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: bold;
        }
        .status-badge.running {
            background-color: var(--vscode-charts-green);
            color: white;
        }
        .status-badge.pending {
            background-color: var(--vscode-charts-orange);
            color: white;
        }
        .status-badge.failed {
            background-color: var(--vscode-charts-red);
            color: white;
        }
        .image-list {
            list-style: none;
            padding: 0;
            margin: 5px 0;
        }
        .image-list li {
            padding: 5px;
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
        }
        .strategy-editor {
            display: flex;
            gap: 10px;
            align-items: center;
            margin: 10px 0;
        }
        .strategy-editor input {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 6px;
            width: 100px;
            font-size: 12px;
        }
        .no-daemonsets {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>DaemonSet Management</h1>
        <div class="actions">
            <button onclick="createTemplate()">Create Template</button>
            <button onclick="refresh()">Refresh</button>
        </div>
    </div>

    <div id="daemonSetsContainer">
        <div class="no-daemonsets">Loading DaemonSets...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function deleteDaemonSet(name, namespace) {
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

        function viewPods(name, namespace) {
            vscode.postMessage({
                command: 'viewPods',
                name: name,
                namespace: namespace
            });
        }

        function restartDaemonSet(name, namespace) {
            vscode.postMessage({
                command: 'restart',
                name: name,
                namespace: namespace
            });
        }

        function updateStrategy(name, namespace) {
            const input = document.getElementById(\`maxUnavailable-\${name}-\${namespace}\`);
            vscode.postMessage({
                command: 'updateStrategy',
                name: name,
                namespace: namespace,
                maxUnavailable: input.value
            });
        }

        function createTemplate() {
            vscode.postMessage({ command: 'createTemplate' });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateData') {
                renderDaemonSets(message.daemonSets);
            }
        });

        function renderDaemonSets(daemonSets) {
            const container = document.getElementById('daemonSetsContainer');
            
            if (daemonSets.length === 0) {
                container.innerHTML = '<div class="no-daemonsets">No DaemonSets found</div>';
                return;
            }

            container.innerHTML = daemonSets.map(ds => {
                const isHealthy = ds.numberReady === ds.desiredNumberScheduled;
                const isDegraded = ds.numberReady > 0 && ds.numberReady < ds.desiredNumberScheduled;
                const cardClass = isHealthy ? 'healthy' : (isDegraded ? 'degraded' : 'error');
                
                const readyPercent = ds.desiredNumberScheduled > 0 
                    ? (ds.numberReady / ds.desiredNumberScheduled * 100).toFixed(0) 
                    : 0;
                
                const progressClass = readyPercent >= 100 ? '' : 'warning';

                const nodeSelectorTags = Object.entries(ds.nodeSelector).map(([key, value]) => 
                    \`<span class="node-selector-tag">\${key}=\${value}</span>\`
                ).join('');

                const nodeSelectorHtml = Object.keys(ds.nodeSelector).length > 0 ? \`
                    <div class="info-section">
                        <div class="info-label">Node Selector</div>
                        <div class="info-content">
                            \${nodeSelectorTags}
                        </div>
                    </div>
                \` : '';

                const tolerationsHtml = ds.tolerations.length > 0 ? \`
                    <div class="info-section">
                        <div class="info-label">Tolerations (\${ds.tolerations.length})</div>
                        <div class="info-content">
                            \${ds.tolerations.map(t => {
                                const parts = [];
                                if (t.key) parts.push(\`Key: \${t.key}\`);
                                if (t.operator) parts.push(\`Op: \${t.operator}\`);
                                if (t.value) parts.push(\`Value: \${t.value}\`);
                                if (t.effect) parts.push(\`Effect: \${t.effect}\`);
                                return \`<div class="toleration">\${parts.join(' | ')}</div>\`;
                            }).join('')}
                        </div>
                    </div>
                \` : '';

                const imagesHtml = \`
                    <div class="info-section">
                        <div class="info-label">Container Images</div>
                        <div class="info-content">
                            <ul class="image-list">
                                \${ds.containerImages.map(img => \`<li>\${img}</li>\`).join('')}
                            </ul>
                        </div>
                    </div>
                \`;

                const podTableHtml = ds.podStatus.length > 0 ? \`
                    <div class="info-section">
                        <div class="info-label">Pods by Node (\${ds.podStatus.length})</div>
                        <table class="pod-table">
                            <thead>
                                <tr>
                                    <th>Status</th>
                                    <th>Pod Name</th>
                                    <th>Node</th>
                                    <th>Phase</th>
                                </tr>
                            </thead>
                            <tbody>
                                \${ds.podStatus.map(pod => \`
                                    <tr class="\${pod.ready ? 'ready' : 'not-ready'}">
                                        <td>\${pod.ready ? '✓' : '✗'}</td>
                                        <td>\${pod.podName}</td>
                                        <td>\${pod.nodeName}</td>
                                        <td><span class="status-badge \${pod.status.toLowerCase()}">\${pod.status}</span></td>
                                    </tr>
                                \`).join('')}
                            </tbody>
                        </table>
                    </div>
                \` : '<div class="info-section"><div class="info-label">No Pods Scheduled</div></div>';

                const strategyHtml = \`
                    <div class="info-section">
                        <div class="info-label">Update Strategy</div>
                        <div class="info-content">
                            <div>Type: <strong>\${ds.updateStrategy.type}</strong></div>
                            \${ds.updateStrategy.type === 'RollingUpdate' ? \`
                                <div class="strategy-editor">
                                    <label>Max Unavailable:</label>
                                    <input type="text" 
                                           id="maxUnavailable-\${ds.name}-\${ds.namespace}" 
                                           value="\${ds.updateStrategy.maxUnavailable || 1}"
                                           placeholder="1 or 10%">
                                    <button onclick="updateStrategy('\${ds.name}', '\${ds.namespace}')">Update</button>
                                </div>
                                \${ds.updateStrategy.maxSurge ? \`<div>Max Surge: \${ds.updateStrategy.maxSurge}</div>\` : ''}
                            \` : ''}
                            <div style="margin-top: 10px;">
                                Min Ready Seconds: \${ds.minReadySeconds} | 
                                Revision History Limit: \${ds.revisionHistoryLimit}
                            </div>
                        </div>
                    </div>
                \`;

                return \`
                    <div class="daemonset-card \${cardClass}">
                        <div class="daemonset-header">
                            <div>
                                <span class="daemonset-title">\${ds.name}</span>
                                <span class="daemonset-namespace">namespace: \${ds.namespace}</span>
                            </div>
                            <div class="daemonset-actions">
                                <button onclick="viewPods('\${ds.name}', '\${ds.namespace}')">View Pods</button>
                                <button onclick="restartDaemonSet('\${ds.name}', '\${ds.namespace}')">Restart</button>
                                <button onclick="viewYaml('\${ds.name}', '\${ds.namespace}')">View YAML</button>
                                <button onclick="deleteDaemonSet('\${ds.name}', '\${ds.namespace}')">Delete</button>
                            </div>
                        </div>

                        <div class="status-grid">
                            <div class="status-box">
                                <div class="status-label">Desired</div>
                                <div class="status-value">\${ds.desiredNumberScheduled}</div>
                            </div>
                            <div class="status-box">
                                <div class="status-label">Current</div>
                                <div class="status-value">\${ds.currentNumberScheduled}</div>
                            </div>
                            <div class="status-box">
                                <div class="status-label">Ready</div>
                                <div class="status-value \${isHealthy ? 'good' : (isDegraded ? 'warning' : 'error')}">
                                    \${ds.numberReady}
                                </div>
                            </div>
                            <div class="status-box">
                                <div class="status-label">Available</div>
                                <div class="status-value \${ds.numberAvailable === ds.desiredNumberScheduled ? 'good' : 'warning'}">
                                    \${ds.numberAvailable}
                                </div>
                            </div>
                            \${ds.numberMisscheduled > 0 ? \`
                                <div class="status-box">
                                    <div class="status-label">Misscheduled</div>
                                    <div class="status-value error">\${ds.numberMisscheduled}</div>
                                </div>
                            \` : ''}
                        </div>

                        <div class="progress-bar">
                            <div class="progress-fill \${progressClass}" style="width: \${readyPercent}%"></div>
                        </div>
                        <div style="text-align: center; font-size: 11px; opacity: 0.8; margin-top: 5px;">
                            \${readyPercent}% Ready (\${ds.numberReady}/\${ds.desiredNumberScheduled} nodes)
                        </div>

                        \${strategyHtml}
                        \${nodeSelectorHtml}
                        \${tolerationsHtml}
                        \${imagesHtml}
                        \${podTableHtml}
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
        DaemonSetManagerPanel.currentPanel = undefined;

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
