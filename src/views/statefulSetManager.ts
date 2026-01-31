import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

interface StatefulSetInfo {
    name: string;
    namespace: string;
    replicas: number;
    readyReplicas: number;
    currentReplicas: number;
    updatedReplicas: number;
    currentRevision: string;
    updateRevision: string;
    updateStrategy: string;
    partition?: number;
    serviceName: string;
    podManagementPolicy: string;
    volumeClaimTemplates: Array<{
        name: string;
        storageClass?: string;
        size: string;
        accessModes: string[];
    }>;
    orderedReady: boolean;
    conditions: Array<{
        type: string;
        status: string;
        reason?: string;
        message?: string;
    }>;
}

export class StatefulSetManagerPanel {
    public static currentPanel: StatefulSetManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (StatefulSetManagerPanel.currentPanel) {
            StatefulSetManagerPanel.currentPanel.panel.reveal(column);
            StatefulSetManagerPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'statefulSetManager',
            'StatefulSet Management',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        StatefulSetManagerPanel.currentPanel = new StatefulSetManagerPanel(panel, extensionUri, k8sClient);
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
                        await this.deleteStatefulSet(message.name, message.namespace);
                        break;
                    case 'scale':
                        await this.scaleStatefulSet(message.name, message.namespace);
                        break;
                    case 'restart':
                        await this.restartStatefulSet(message.name, message.namespace);
                        break;
                    case 'setPartition':
                        await this.setPartition(message.name, message.namespace);
                        break;
                    case 'viewYaml':
                        await this.viewYaml(message.name, message.namespace);
                        break;
                    case 'viewPods':
                        await this.viewPods(message.name, message.namespace);
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
        }, 5000); // Refresh every 5 seconds
    }

    private async refresh() {
        try {
            const statefulSets = await this.k8sClient.getStatefulSets();
            const statefulSetInfos: StatefulSetInfo[] = [];

            for (const sts of statefulSets) {
                const volumeClaimTemplates = (sts.spec?.volumeClaimTemplates || []).map(vct => ({
                    name: vct.metadata?.name || 'unknown',
                    storageClass: vct.spec?.storageClassName,
                    size: vct.spec?.resources?.requests?.storage || 'unknown',
                    accessModes: vct.spec?.accessModes || []
                }));

                statefulSetInfos.push({
                    name: sts.metadata?.name || 'unknown',
                    namespace: sts.metadata?.namespace || 'default',
                    replicas: sts.spec?.replicas || 0,
                    readyReplicas: sts.status?.readyReplicas || 0,
                    currentReplicas: sts.status?.currentReplicas || 0,
                    updatedReplicas: sts.status?.updatedReplicas || 0,
                    currentRevision: sts.status?.currentRevision || 'unknown',
                    updateRevision: sts.status?.updateRevision || 'unknown',
                    updateStrategy: sts.spec?.updateStrategy?.type || 'RollingUpdate',
                    partition: sts.spec?.updateStrategy?.rollingUpdate?.partition,
                    serviceName: sts.spec?.serviceName || 'unknown',
                    podManagementPolicy: sts.spec?.podManagementPolicy || 'OrderedReady',
                    volumeClaimTemplates,
                    orderedReady: sts.spec?.podManagementPolicy !== 'Parallel',
                    conditions: (sts.status?.conditions || []).map(c => ({
                        type: c.type || 'Unknown',
                        status: c.status || 'Unknown',
                        reason: c.reason,
                        message: c.message
                    }))
                });
            }

            this.panel.webview.postMessage({
                command: 'updateData',
                statefulSets: statefulSetInfos
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh StatefulSets: ${error}`);
        }
    }

    private async deleteStatefulSet(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete StatefulSet "${name}" in namespace "${namespace}"? This will delete all pods and may delete associated PVCs.`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            await this.k8sClient.deleteStatefulSet(name, namespace);
            vscode.window.showInformationMessage(`StatefulSet ${name} deleted`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete StatefulSet: ${error}`);
        }
    }

    private async scaleStatefulSet(name: string, namespace: string) {
        const replicas = await vscode.window.showInputBox({
            prompt: 'Enter desired number of replicas',
            validateInput: (value) => {
                const num = parseInt(value);
                return isNaN(num) || num < 0 ? 'Please enter a valid number >= 0' : null;
            }
        });

        if (!replicas) {
            return;
        }

        try {
            await this.k8sClient.scaleStatefulSet(name, namespace, parseInt(replicas));
            vscode.window.showInformationMessage(`StatefulSet ${name} scaled to ${replicas} replicas`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to scale StatefulSet: ${error}`);
        }
    }

    private async restartStatefulSet(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Restart StatefulSet "${name}"? This will recreate all pods in order.`,
            { modal: true },
            'Restart'
        );

        if (confirm !== 'Restart') {
            return;
        }

        try {
            await this.k8sClient.restartStatefulSet(name, namespace);
            vscode.window.showInformationMessage(`StatefulSet ${name} restarting`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to restart StatefulSet: ${error}`);
        }
    }

    private async setPartition(name: string, namespace: string) {
        const partition = await vscode.window.showInputBox({
            prompt: 'Enter partition number (pods with ordinal >= partition will be updated)',
            placeHolder: '0 = update all pods',
            validateInput: (value) => {
                const num = parseInt(value);
                return isNaN(num) || num < 0 ? 'Please enter a valid number >= 0' : null;
            }
        });

        if (partition === undefined) {
            return;
        }

        try {
            await this.k8sClient.setStatefulSetPartition(name, namespace, parseInt(partition));
            vscode.window.showInformationMessage(
                `Partition set to ${partition}. Pods with ordinal >= ${partition} will be updated.`
            );
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to set partition: ${error}`);
        }
    }

    private async viewYaml(name: string, namespace: string) {
        try {
            const statefulSets = await this.k8sClient.getStatefulSets(namespace);
            const sts = statefulSets.find(s => s.metadata?.name === name);

            if (!sts) {
                vscode.window.showErrorMessage(`StatefulSet ${name} not found`);
                return;
            }

            const yaml = JSON.stringify(sts, null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: yaml,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view StatefulSet: ${error}`);
        }
    }

    private async viewPods(name: string, namespace: string) {
        try {
            const pods = await this.k8sClient.getPods(namespace);
            const stsPods = pods.filter(pod => {
                const ownerRefs = pod.metadata?.ownerReferences || [];
                return ownerRefs.some(ref => ref.kind === 'StatefulSet' && ref.name === name);
            });

            if (stsPods.length === 0) {
                vscode.window.showInformationMessage(`No pods found for StatefulSet ${name}`);
                return;
            }

            const podInfo = stsPods.map(pod => {
                const status = pod.status?.phase || 'Unknown';
                const ready = pod.status?.containerStatuses?.every(c => c.ready) ? '✓' : '✗';
                return `${ready} ${pod.metadata?.name} - ${status}`;
            }).join('\n');

            const doc = await vscode.workspace.openTextDocument({
                content: `Pods for StatefulSet ${name}:\n\n${podInfo}`,
                language: 'plaintext'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view pods: ${error}`);
        }
    }

    private async createTemplate() {
        const template = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: example-statefulset
  namespace: default
spec:
  serviceName: example-service
  replicas: 3
  selector:
    matchLabels:
      app: example
  # Pod management policy
  podManagementPolicy: OrderedReady  # or Parallel
  # Update strategy
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0  # Update pods with ordinal >= partition
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
      - name: app
        image: nginx:1.21
        ports:
        - containerPort: 80
          name: web
        volumeMounts:
        - name: data
          mountPath: /usr/share/nginx/html
  # Volume claim templates
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: "standard"
      resources:
        requests:
          storage: 1Gi
---
# Headless service for StatefulSet
apiVersion: v1
kind: Service
metadata:
  name: example-service
  namespace: default
spec:
  clusterIP: None
  selector:
    app: example
  ports:
  - port: 80
    name: web`;

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
    <title>StatefulSet Management</title>
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
        button.danger {
            background-color: var(--vscode-errorForeground);
        }
        .sts-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-charts-purple);
        }
        .sts-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .sts-title {
            font-size: 18px;
            font-weight: bold;
        }
        .sts-namespace {
            font-size: 12px;
            opacity: 0.8;
            margin-left: 10px;
        }
        .sts-actions {
            display: flex;
            gap: 5px;
        }
        .sts-actions button {
            padding: 4px 8px;
            font-size: 12px;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin: 15px 0;
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
            font-size: 18px;
            font-weight: bold;
        }
        .replica-bar {
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
            background: linear-gradient(90deg, var(--vscode-charts-purple), var(--vscode-charts-blue));
            transition: width 0.3s;
        }
        .bar-fill.updating {
            background: linear-gradient(90deg, var(--vscode-charts-orange), var(--vscode-charts-yellow));
        }
        .bar-label {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-weight: bold;
            font-size: 12px;
        }
        .strategy-info {
            background-color: var(--vscode-editor-background);
            padding: 15px;
            border-radius: 3px;
            margin: 15px 0;
        }
        .strategy-info h3 {
            margin-top: 0;
        }
        .partition-control {
            margin-top: 10px;
        }
        .partition-control button {
            padding: 6px 12px;
            font-size: 13px;
        }
        .volume-claims {
            background-color: var(--vscode-editor-background);
            padding: 15px;
            border-radius: 3px;
            margin: 15px 0;
        }
        .volume-claim {
            padding: 8px;
            margin: 5px 0;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 3px;
            font-size: 12px;
        }
        .volume-claim-name {
            font-weight: bold;
            font-family: var(--vscode-editor-font-family);
        }
        .status-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 11px;
            margin-left: 10px;
        }
        .status-badge.ready {
            background-color: var(--vscode-charts-green);
            color: white;
        }
        .status-badge.updating {
            background-color: var(--vscode-charts-orange);
            color: white;
        }
        .status-badge.error {
            background-color: var(--vscode-charts-red);
            color: white;
        }
        .policy-badge {
            display: inline-block;
            padding: 3px 6px;
            border-radius: 3px;
            font-size: 10px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .no-sts {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
        .revision-info {
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
            margin: 5px 0;
        }
        .conditions {
            margin: 15px 0;
        }
        .condition {
            padding: 8px;
            margin: 5px 0;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>StatefulSet Management</h1>
        <div class="actions">
            <button onclick="createTemplate()">Create Template</button>
            <button onclick="refresh()">Refresh</button>
        </div>
    </div>

    <div id="stsContainer">
        <div class="no-sts">Loading StatefulSets...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function deleteSts(name, namespace) {
            vscode.postMessage({
                command: 'delete',
                name: name,
                namespace: namespace
            });
        }

        function scaleSts(name, namespace) {
            vscode.postMessage({
                command: 'scale',
                name: name,
                namespace: namespace
            });
        }

        function restartSts(name, namespace) {
            vscode.postMessage({
                command: 'restart',
                name: name,
                namespace: namespace
            });
        }

        function setPartition(name, namespace) {
            vscode.postMessage({
                command: 'setPartition',
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

        function createTemplate() {
            vscode.postMessage({ command: 'createTemplate' });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateData') {
                renderStatefulSets(message.statefulSets);
            }
        });

        function renderStatefulSets(statefulSets) {
            const container = document.getElementById('stsContainer');
            
            if (statefulSets.length === 0) {
                container.innerHTML = '<div class="no-sts">No StatefulSets found</div>';
                return;
            }

            container.innerHTML = statefulSets.map(sts => {
                const percentage = sts.replicas > 0 ? 
                    (sts.readyReplicas / sts.replicas) * 100 : 0;
                
                let statusBadge = '';
                let barClass = '';
                
                if (sts.readyReplicas === sts.replicas && sts.replicas > 0) {
                    statusBadge = '<span class="status-badge ready">READY</span>';
                } else if (sts.updatedReplicas !== sts.replicas || sts.currentReplicas !== sts.replicas) {
                    statusBadge = '<span class="status-badge updating">UPDATING</span>';
                    barClass = 'updating';
                } else if (sts.readyReplicas < sts.replicas) {
                    statusBadge = '<span class="status-badge error">NOT READY</span>';
                }

                const volumeClaimsHtml = sts.volumeClaimTemplates.length > 0 ? \`
                    <div class="volume-claims">
                        <h4>Volume Claim Templates</h4>
                        \${sts.volumeClaimTemplates.map(vct => \`
                            <div class="volume-claim">
                                <span class="volume-claim-name">\${vct.name}</span>
                                <div>Size: \${vct.size}, Access: \${vct.accessModes.join(', ')}</div>
                                \${vct.storageClass ? \`<div>Storage Class: \${vct.storageClass}</div>\` : ''}
                            </div>
                        \`).join('')}
                    </div>
                \` : '';

                const partitionInfo = sts.partition !== undefined ? \`
                    <div style="margin-top: 10px;">
                        Current Partition: <strong>\${sts.partition}</strong>
                        <div style="font-size: 11px; opacity: 0.8; margin-top: 3px;">
                            Pods with ordinal >= \${sts.partition} will be updated
                        </div>
                    </div>
                \` : '';

                const partitionControl = sts.updateStrategy === 'RollingUpdate' ? \`
                    <div class="partition-control">
                        <button onclick="setPartition('\${sts.name}', '\${sts.namespace}')">Set Partition</button>
                    </div>
                \` : '';

                const conditionsHtml = sts.conditions.length > 0 ? \`
                    <div class="conditions">
                        <h4>Conditions</h4>
                        \${sts.conditions.map(c => \`
                            <div class="condition">
                                <strong>\${c.type}:</strong> \${c.status}
                                \${c.reason ? \` - \${c.reason}\` : ''}
                                \${c.message ? \`<br><small>\${c.message}</small>\` : ''}
                            </div>
                        \`).join('')}
                    </div>
                \` : '';

                return \`
                    <div class="sts-card">
                        <div class="sts-header">
                            <div>
                                <span class="sts-title">\${sts.name}</span>
                                <span class="sts-namespace">namespace: \${sts.namespace}</span>
                                \${statusBadge}
                            </div>
                            <div class="sts-actions">
                                <button onclick="viewPods('\${sts.name}', '\${sts.namespace}')">View Pods</button>
                                <button onclick="scaleSts('\${sts.name}', '\${sts.namespace}')">Scale</button>
                                <button onclick="restartSts('\${sts.name}', '\${sts.namespace}')">Restart</button>
                                <button onclick="viewYaml('\${sts.name}', '\${sts.namespace}')">YAML</button>
                                <button class="danger" onclick="deleteSts('\${sts.name}', '\${sts.namespace}')">Delete</button>
                            </div>
                        </div>

                        <div>Service: <strong>\${sts.serviceName}</strong></div>
                        <div>
                            Pod Management: <span class="policy-badge">\${sts.podManagementPolicy}</span>
                            \${sts.orderedReady ? ' (Ordered startup/shutdown)' : ' (Parallel startup/shutdown)'}
                        </div>

                        <div class="info-grid">
                            <div class="info-box">
                                <div class="info-label">Desired</div>
                                <div class="info-value">\${sts.replicas}</div>
                            </div>
                            <div class="info-box">
                                <div class="info-label">Current</div>
                                <div class="info-value">\${sts.currentReplicas}</div>
                            </div>
                            <div class="info-box">
                                <div class="info-label">Ready</div>
                                <div class="info-value">\${sts.readyReplicas}</div>
                            </div>
                            <div class="info-box">
                                <div class="info-label">Updated</div>
                                <div class="info-value">\${sts.updatedReplicas}</div>
                            </div>
                        </div>

                        <div class="replica-bar">
                            <span>0</span>
                            <div class="bar-container">
                                <div class="bar-fill \${barClass}" style="width: \${percentage}%"></div>
                                <div class="bar-label">\${sts.readyReplicas} / \${sts.replicas} ready</div>
                            </div>
                            <span>\${sts.replicas}</span>
                        </div>

                        <div class="strategy-info">
                            <h3>Update Strategy: \${sts.updateStrategy}</h3>
                            <div class="revision-info">Current Revision: \${sts.currentRevision}</div>
                            <div class="revision-info">Update Revision: \${sts.updateRevision}</div>
                            \${partitionInfo}
                            \${partitionControl}
                        </div>

                        \${volumeClaimsHtml}
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
        StatefulSetManagerPanel.currentPanel = undefined;

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
