import * as vscode from 'vscode';
import { KubeconfigManager } from '../utils/kubeconfig';
import { K8sClient } from '../utils/k8sClient';
import { ClusterProvider } from '../providers/clusterProvider';
import { ResourceProvider, ResourceItem } from '../providers/resourceProvider';
import { CRDProvider } from '../providers/crdProvider';
import { ResourceDetailsPanel } from '../views/resourceDetails';
import { EventsPanel } from '../views/eventsPanel';
import { PortForwardManager } from '../utils/portForwardManager';
import { TerminalManager } from '../utils/terminalManager';
import { HelmManager } from '../utils/helmManager';
import { HelmProvider, HelmItem } from '../providers/helmProvider';
import { RBACProvider, RBACItem } from '../providers/rbacProvider';
import { RBACViewerPanel } from '../views/rbacViewer';
import { AlertsPanel } from '../views/alertsPanel';
import { PVManagerPanel } from '../views/pvManager';
import { AlertManager } from '../utils/alertManager';
import { HealthMonitor } from '../utils/healthMonitor';
import { TemplateSelectorPanel } from '../views/templateSelector';
import { JobManagerPanel } from '../views/jobManager';
import { JobProvider } from '../providers/jobProvider';
import { AdvancedLogViewer } from '../views/advancedLogViewer';
import { NamespaceManagerPanel } from '../views/namespaceManager';
import { NamespaceProvider } from '../providers/namespaceProvider';
import { CRDManagerPanel } from '../views/crdManager';
import { EventStreamViewerPanel } from '../views/eventStreamViewer';
import { HelmManagerPanel } from '../views/helmManagerPanel';
import { PortForwardPanel } from '../views/portForwardPanel';
import { SecurityScanningPanel } from '../views/securityScanningPanel';
import * as YAML from 'yaml';

export async function addCluster(
    kubeconfigManager: KubeconfigManager,
    clusterProvider: ClusterProvider
): Promise<void> {
    const clusterName = await vscode.window.showInputBox({
        prompt: 'Enter cluster name',
        placeHolder: 'my-cluster'
    });
    
    if (!clusterName) {
        return;
    }

    const serverUrl = await vscode.window.showInputBox({
        prompt: 'Enter server URL',
        placeHolder: 'https://kubernetes.example.com:6443'
    });
    
    if (!serverUrl) {
        return;
    }

    try {
        await kubeconfigManager.addCluster({
            name: clusterName,
            server: serverUrl,
            skipTLSVerify: true
        });

        vscode.window.showInformationMessage(`Cluster ${clusterName} added successfully`);
        clusterProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to add cluster: ${error}`);
    }
}

export async function removeCluster(
    kubeconfigManager: KubeconfigManager,
    clusterProvider: ClusterProvider,
    item: any
): Promise<void> {
    if (!item || !item.id) {
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Remove cluster context "${item.id}"?`,
        { modal: true },
        'Remove'
    );

    if (confirm === 'Remove') {
        try {
            kubeconfigManager.removeContext(item.id);
            vscode.window.showInformationMessage(`Context ${item.id} removed`);
            clusterProvider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to remove context: ${error}`);
        }
    }
}

export async function switchContext(
    kubeconfigManager: KubeconfigManager,
    k8sClient: K8sClient,
    clusterProvider: ClusterProvider
): Promise<void> {
    const contexts = kubeconfigManager.getContexts();
    
    if (contexts.length === 0) {
        vscode.window.showWarningMessage('No contexts available');
        return;
    }

    const items = contexts.map(ctx => ({
        label: ctx.name,
        description: ctx.cluster,
        context: ctx
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a context'
    });

    if (selected) {
        kubeconfigManager.setCurrentContext(selected.context.name);
        k8sClient.refresh();
        clusterProvider.refresh();
        vscode.window.showInformationMessage(`Switched to context: ${selected.label}`);
    }
}

export function refreshAll(
    clusterProvider: ClusterProvider,
    workloadsProvider: ResourceProvider,
    configProvider: ResourceProvider,
    networkProvider: ResourceProvider,
    storageProvider: ResourceProvider,
    crdProvider?: CRDProvider
): void {
    clusterProvider.refresh();
    workloadsProvider.refresh();
    configProvider.refresh();
    networkProvider.refresh();
    storageProvider.refresh();
    if (crdProvider) {
        crdProvider.refresh();
    }
}

export async function viewLogs(k8sClient: K8sClient, item: ResourceItem): Promise<void> {
    if (!item || !item.resource) {
        return;
    }

    const pod = item.resource;
    const podName = pod.metadata?.name;
    const namespace = pod.metadata?.namespace;

    if (!podName || !namespace) {
        vscode.window.showErrorMessage('Invalid pod resource');
        return;
    }

    try {
        const config = vscode.workspace.getConfiguration('clusterPilot');
        const tailLines = config.get<number>('logLines', 1000);
        
        const logs = await k8sClient.getLogs(namespace, podName, undefined, tailLines);
        
        const doc = await vscode.workspace.openTextDocument({
            content: logs,
            language: 'log'
        });
        
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to fetch logs: ${error}`);
    }
}

export async function viewYaml(k8sClient: K8sClient, item: ResourceItem): Promise<void> {
    if (!item || !item.resource) {
        return;
    }

    try {
        const yamlContent = YAML.stringify(item.resource);
        
        const doc = await vscode.workspace.openTextDocument({
            content: yamlContent,
            language: 'yaml'
        });
        
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to view YAML: ${error}`);
    }
}

export async function showResourceDetails(
    context: vscode.ExtensionContext,
    item: ResourceItem | { resource?: any; resourceKind?: string },
    k8sClient: K8sClient
): Promise<void> {
    if (!item || !item.resource) {
        return;
    }

    ResourceDetailsPanel.show(
        context.extensionUri,
        context,
        item.resource,
        item.resourceKind || 'resource',
        k8sClient
    );
}

export async function editResource(k8sClient: K8sClient, item: ResourceItem): Promise<void> {
    if (!item || !item.resource) {
        return;
    }

    try {
        const yamlContent = YAML.stringify(item.resource);
        
        const doc = await vscode.workspace.openTextDocument({
            content: yamlContent,
            language: 'yaml'
        });
        
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage('Edit the YAML and apply changes manually using kubectl');
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to edit resource: ${error}`);
    }
}

export async function deleteResource(
    k8sClient: K8sClient,
    item: ResourceItem,
    workloadsProvider: ResourceProvider,
    configProvider: ResourceProvider,
    networkProvider: ResourceProvider,
    storageProvider: ResourceProvider
): Promise<void> {
    if (!item || !item.resource) {
        return;
    }

    const name = item.resource.metadata?.name;
    const namespace = item.resource.metadata?.namespace;
    const kind = item.resourceKind;
    
    if (!name || !kind) {
        vscode.window.showErrorMessage('Cannot delete resource: missing name or kind');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Delete ${kind} "${name}"${namespace ? ` in namespace "${namespace}"` : ''}?`,
        { modal: true },
        'Delete'
    );

    if (confirm === 'Delete') {
        try {
            if (!namespace) {
                vscode.window.showErrorMessage('Cannot delete resource: namespace is required');
                return;
            }
            await k8sClient.deleteResource(kind, name, namespace);
            vscode.window.showInformationMessage(`${kind} ${name} deleted`);
            
            // Refresh appropriate views
            refreshAll(
                workloadsProvider as any,
                workloadsProvider,
                configProvider,
                networkProvider,
                storageProvider
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete resource: ${error}`);
        }
    }
}

export async function describeResource(k8sClient: K8sClient, item: ResourceItem): Promise<void> {
    if (!item || !item.resource) {
        return;
    }

    const name = item.resource.metadata?.name;
    const namespace = item.resource.metadata?.namespace;
    const kind = item.resourceKind;

    const terminal = vscode.window.createTerminal('kubectl describe');
    const nsFlag = namespace ? `-n ${namespace}` : '';
    terminal.sendText(`kubectl describe ${kind} ${name} ${nsFlag}`);
    terminal.show();
}

export async function portForward(k8sClient: K8sClient, item: ResourceItem): Promise<void> {
    if (!item || !item.resource) {
        return;
    }

    const name = item.resource.metadata?.name;
    const namespace = item.resource.metadata?.namespace;
    const kind = item.resourceKind;

    const localPort = await vscode.window.showInputBox({
        prompt: 'Enter local port',
        placeHolder: '8080'
    });

    if (!localPort) {
        return;
    }

    const remotePort = await vscode.window.showInputBox({
        prompt: 'Enter remote port',
        placeHolder: '80'
    });

    if (!remotePort) {
        return;
    }

    const terminal = vscode.window.createTerminal('Port Forward');
    const nsFlag = namespace ? `-n ${namespace}` : '';
    
    if (kind === 'pod') {
        terminal.sendText(`kubectl port-forward ${nsFlag} pod/${name} ${localPort}:${remotePort}`);
    } else if (kind === 'service') {
        terminal.sendText(`kubectl port-forward ${nsFlag} service/${name} ${localPort}:${remotePort}`);
    }
    
    terminal.show();
    vscode.window.showInformationMessage(`Port forwarding started: localhost:${localPort} -> ${name}:${remotePort}`);
}

export async function execShell(k8sClient: K8sClient, item: ResourceItem): Promise<void> {
    if (!item || !item.resource) {
        return;
    }

    const name = item.resource.metadata?.name;
    const namespace = item.resource.metadata?.namespace;

    const terminal = vscode.window.createTerminal(`Shell: ${name}`);
    const nsFlag = namespace ? `-n ${namespace}` : '';
    terminal.sendText(`kubectl exec ${nsFlag} -it ${name} -- /bin/sh`);
    terminal.show();
}

export async function scaleDeployment(k8sClient: K8sClient, item: ResourceItem): Promise<void> {
    if (!item || !item.resource) {
        return;
    }

    const name = item.resource.metadata?.name;
    const namespace = item.resource.metadata?.namespace;
    const resource = item.resource as any;
    const currentReplicas = resource.spec?.replicas || 0;

    const replicasStr = await vscode.window.showInputBox({
        prompt: `Scale deployment ${name}`,
        placeHolder: `Current replicas: ${currentReplicas}`,
        value: currentReplicas.toString()
    });

    if (!replicasStr) {
        return;
    }

    const replicas = parseInt(replicasStr, 10);
    if (isNaN(replicas) || replicas < 0) {
        vscode.window.showErrorMessage('Invalid replica count');
        return;
    }

    if (!namespace) {
        vscode.window.showErrorMessage('Namespace is required for scaling');
        return;
    }

    try {
        await k8sClient.scaleDeployment(name!, namespace, replicas);
        vscode.window.showInformationMessage(`Deployment ${name} scaled to ${replicas} replicas`);
        vscode.commands.executeCommand('clusterPilot.refresh');
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to scale deployment: ${error}`);
    }
}

export async function restartDeployment(k8sClient: K8sClient, item: ResourceItem): Promise<void> {
    if (!item || !item.resource || item.resourceKind !== 'deployment') {
        vscode.window.showErrorMessage('Please select a deployment');
        return;
    }

    const name = item.resource.metadata?.name;
    const namespace = item.resource.metadata?.namespace;

    if (!name || !namespace) {
        vscode.window.showErrorMessage('Invalid deployment');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Restart deployment "${name}"? This will recreate all pods.`,
        { modal: true },
        'Restart'
    );

    if (confirm === 'Restart') {
        try {
            await k8sClient.restartDeployment(name, namespace);
            vscode.window.showInformationMessage(`Deployment ${name} restart initiated`);
            vscode.commands.executeCommand('clusterPilot.refresh');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to restart deployment: ${error}`);
        }
    }
}

export async function showMetrics(context: vscode.ExtensionContext, k8sClient: K8sClient): Promise<void> {
    const enableMetrics = vscode.workspace.getConfiguration('clusterPilot').get<boolean>('enableMetrics', true);
    
    if (!enableMetrics) {
        vscode.window.showWarningMessage(
            'Metrics are disabled. Enable them in settings: clusterPilot.enableMetrics',
            'Open Settings'
        ).then(selection => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'clusterPilot.enableMetrics');
            }
        });
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'clusterPilotMetrics',
        'Cluster Metrics',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.type === 'requestMetrics') {
            try {
                const metrics = await k8sClient.getClusterMetrics();
                const nodeMetrics = await k8sClient.getNodeMetrics();
                const podMetrics = await k8sClient.getPodMetrics();

                panel.webview.postMessage({
                    type: 'updateMetrics',
                    data: {
                        ...metrics,
                        nodeMetrics,
                        podMetrics
                    }
                });
            } catch (error) {
                panel.webview.postMessage({
                    type: 'metricsError',
                    error: error instanceof Error ? error.message : 'Failed to fetch metrics'
                });
            }
        }
    });

    panel.webview.html = getMetricsHtml();

    // Auto-refresh every 10 seconds
    const refreshInterval = setInterval(async () => {
        try {
            const metrics = await k8sClient.getClusterMetrics();
            const nodeMetrics = await k8sClient.getNodeMetrics();
            const podMetrics = await k8sClient.getPodMetrics();

            panel.webview.postMessage({
                type: 'updateMetrics',
                data: {
                    ...metrics,
                    nodeMetrics,
                    podMetrics
                }
            });
        } catch (error) {
            console.error('Failed to refresh metrics:', error);
        }
    }, 10000);

    panel.onDidDispose(() => {
        clearInterval(refreshInterval);
    });
}

function getMetricsHtml(): string {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
            <title>Cluster Metrics</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-foreground);
                    line-height: 1.6;
                }
                
                h1 {
                    color: var(--vscode-foreground);
                    margin-bottom: 24px;
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .refresh-indicator {
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                }

                .metrics-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                    gap: 16px;
                    margin-bottom: 32px;
                }
                
                .metric-card {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    padding: 20px;
                    transition: transform 0.2s;
                }

                .metric-card:hover {
                    transform: translateY(-2px);
                    border-color: var(--vscode-focusBorder);
                }

                .metric-card h2 {
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 8px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .metric-value {
                    font-size: 36px;
                    font-weight: bold;
                    color: var(--vscode-textLink-foreground);
                    margin-bottom: 4px;
                }

                .metric-label {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }

                .metric-secondary {
                    font-size: 14px;
                    color: var(--vscode-foreground);
                    margin-top: 8px;
                    padding-top: 8px;
                    border-top: 1px solid var(--vscode-panel-border);
                }

                .section {
                    margin-top: 32px;
                }

                .section h2 {
                    font-size: 20px;
                    margin-bottom: 16px;
                    color: var(--vscode-textLink-foreground);
                }

                .table {
                    width: 100%;
                    border-collapse: collapse;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 6px;
                    overflow: hidden;
                }

                .table th {
                    background: var(--vscode-editor-background);
                    padding: 12px;
                    text-align: left;
                    font-weight: 600;
                    border-bottom: 2px solid var(--vscode-panel-border);
                }

                .table td {
                    padding: 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }

                .table tr:last-child td {
                    border-bottom: none;
                }

                .table tr:hover {
                    background: var(--vscode-list-hoverBackground);
                }

                .progress-bar {
                    width: 100%;
                    height: 8px;
                    background: var(--vscode-editor-background);
                    border-radius: 4px;
                    overflow: hidden;
                    margin-top: 4px;
                }

                .progress-fill {
                    height: 100%;
                    background: var(--vscode-progressBar-background);
                    transition: width 0.3s ease;
                }

                .progress-fill.high {
                    background: #f44336;
                }

                .progress-fill.medium {
                    background: #ff9800;
                }

                .progress-fill.low {
                    background: #4caf50;
                }

                .error-message {
                    background: var(--vscode-inputValidation-errorBackground);
                    border: 1px solid var(--vscode-inputValidation-errorBorder);
                    color: var(--vscode-errorForeground);
                    padding: 16px;
                    border-radius: 6px;
                    margin-bottom: 16px;
                }

                .loading {
                    text-align: center;
                    padding: 40px;
                    color: var(--vscode-descriptionForeground);
                }

                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }

                .pulse {
                    animation: pulse 2s infinite;
                }
            </style>
        </head>
        <body>
            <h1>
                📊 Cluster Metrics
                <span class="refresh-indicator">🔄 Auto-refreshing every 10s</span>
            </h1>

            <div id="error-container"></div>
            <div id="loading" class="loading pulse">Loading metrics...</div>

            <div id="metrics-content" style="display: none;">
                <div class="metrics-grid">
                    <div class="metric-card">
                        <h2>Nodes</h2>
                        <div class="metric-value" id="nodeCount">-</div>
                        <div class="metric-label">Active cluster nodes</div>
                    </div>
                    
                    <div class="metric-card">
                        <h2>Pods</h2>
                        <div class="metric-value" id="podCount">-</div>
                        <div class="metric-label">Running across all namespaces</div>
                    </div>
                    
                    <div class="metric-card">
                        <h2>Deployments</h2>
                        <div class="metric-value" id="deploymentCount">-</div>
                        <div class="metric-label">Active deployments</div>
                    </div>

                    <div class="metric-card">
                        <h2>Services</h2>
                        <div class="metric-value" id="serviceCount">-</div>
                        <div class="metric-label">Network services</div>
                    </div>

                    <div class="metric-card">
                        <h2>Namespaces</h2>
                        <div class="metric-value" id="namespaceCount">-</div>
                        <div class="metric-label">Active namespaces</div>
                    </div>

                    <div class="metric-card">
                        <h2>CPU Usage</h2>
                        <div class="metric-value" id="cpuUsed">-</div>
                        <div class="metric-secondary">Total: <span id="cpuTotal">-</span></div>
                        <div class="progress-bar">
                            <div class="progress-fill" id="cpuProgress" style="width: 0%"></div>
                        </div>
                    </div>

                    <div class="metric-card">
                        <h2>Memory Usage</h2>
                        <div class="metric-value" id="memoryUsed">-</div>
                        <div class="metric-secondary">Total: <span id="memoryTotal">-</span></div>
                        <div class="progress-bar">
                            <div class="progress-fill" id="memoryProgress" style="width: 0%"></div>
                        </div>
                    </div>
                </div>

                <div class="section">
                    <h2>Node Metrics</h2>
                    <table class="table" id="nodeMetricsTable">
                        <thead>
                            <tr>
                                <th>Node</th>
                                <th>CPU Usage</th>
                                <th>Memory Usage</th>
                            </tr>
                        </thead>
                        <tbody id="nodeMetricsBody">
                            <tr><td colspan="3" style="text-align: center;">No data available</td></tr>
                        </tbody>
                    </table>
                </div>

                <div class="section">
                    <h2>Top Pods by Resource Usage</h2>
                    <table class="table" id="podMetricsTable">
                        <thead>
                            <tr>
                                <th>Pod</th>
                                <th>Namespace</th>
                                <th>CPU Usage</th>
                                <th>Memory Usage</th>
                            </tr>
                        </thead>
                        <tbody id="podMetricsBody">
                            <tr><td colspan="4" style="text-align: center;">No data available</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'updateMetrics') {
                        updateMetrics(message.data);
                    } else if (message.type === 'metricsError') {
                        showError(message.error);
                    }
                });
                
                function updateMetrics(data) {
                    document.getElementById('loading').style.display = 'none';
                    document.getElementById('metrics-content').style.display = 'block';
                    document.getElementById('error-container').innerHTML = '';

                    // Update summary metrics
                    document.getElementById('nodeCount').textContent = data.nodeCount || 0;
                    document.getElementById('podCount').textContent = data.podCount || 0;
                    document.getElementById('deploymentCount').textContent = data.deploymentCount || 0;
                    document.getElementById('serviceCount').textContent = data.serviceCount || 0;
                    document.getElementById('namespaceCount').textContent = data.namespaceCount || 0;
                    
                    // Update resource usage
                    document.getElementById('cpuUsed').textContent = data.usedCpu || '-';
                    document.getElementById('cpuTotal').textContent = data.totalCpu || '-';
                    document.getElementById('memoryUsed').textContent = data.usedMemory || '-';
                    document.getElementById('memoryTotal').textContent = data.totalMemory || '-';

                    // Calculate and update progress bars
                    if (data.usedCpu && data.totalCpu) {
                        const cpuUsed = parseFloat(data.usedCpu);
                        const cpuTotal = parseFloat(data.totalCpu);
                        const cpuPercent = (cpuUsed / cpuTotal) * 100;
                        updateProgressBar('cpuProgress', cpuPercent);
                    }

                    if (data.usedMemory && data.totalMemory) {
                        const memUsedBytes = parseMemoryToBytes(data.usedMemory);
                        const memTotalBytes = parseMemoryToBytes(data.totalMemory);
                        const memPercent = (memUsedBytes / memTotalBytes) * 100;
                        updateProgressBar('memoryProgress', memPercent);
                    }

                    // Update node metrics table
                    if (data.nodeMetrics && data.nodeMetrics.length > 0) {
                        const tbody = document.getElementById('nodeMetricsBody');
                        tbody.innerHTML = data.nodeMetrics.map(node => \`
                            <tr>
                                <td>\${node.metadata.name}</td>
                                <td>\${node.usage?.cpu || 'N/A'}</td>
                                <td>\${node.usage?.memory || 'N/A'}</td>
                            </tr>
                        \`).join('');
                    }

                    // Update pod metrics table (top 20)
                    if (data.podMetrics && data.podMetrics.length > 0) {
                        const sortedPods = [...data.podMetrics]
                            .sort((a, b) => {
                                const aCpu = parseCpuToNumber(a.containers?.[0]?.usage?.cpu || '0');
                                const bCpu = parseCpuToNumber(b.containers?.[0]?.usage?.cpu || '0');
                                return bCpu - aCpu;
                            })
                            .slice(0, 20);

                        const tbody = document.getElementById('podMetricsBody');
                        tbody.innerHTML = sortedPods.map(pod => {
                            const cpu = pod.containers?.reduce((sum, c) => sum + parseCpuToNumber(c.usage?.cpu || '0'), 0) || 0;
                            const memory = pod.containers?.reduce((sum, c) => sum + parseMemoryToBytes(c.usage?.memory || '0'), 0) || 0;
                            return \`
                                <tr>
                                    <td>\${pod.metadata.name}</td>
                                    <td>\${pod.metadata.namespace}</td>
                                    <td>\${formatCpu(cpu)}</td>
                                    <td>\${formatMemory(memory)}</td>
                                </tr>
                            \`;
                        }).join('');
                    }
                }

                function updateProgressBar(id, percent) {
                    const progressBar = document.getElementById(id);
                    progressBar.style.width = Math.min(percent, 100) + '%';
                    progressBar.className = 'progress-fill';
                    if (percent >= 80) {
                        progressBar.classList.add('high');
                    } else if (percent >= 60) {
                        progressBar.classList.add('medium');
                    } else {
                        progressBar.classList.add('low');
                    }
                }

                function parseCpuToNumber(cpu) {
                    if (!cpu) return 0;
                    if (cpu.endsWith('n')) return parseFloat(cpu) / 1000000000;
                    if (cpu.endsWith('u')) return parseFloat(cpu) / 1000000;
                    if (cpu.endsWith('m')) return parseFloat(cpu) / 1000;
                    return parseFloat(cpu);
                }

                function parseMemoryToBytes(memory) {
                    if (!memory) return 0;
                    const units = {
                        'Ki': 1024,
                        'Mi': 1024 * 1024,
                        'Gi': 1024 * 1024 * 1024,
                        'Ti': 1024 * 1024 * 1024 * 1024,
                        'KB': 1024,
                        'MB': 1024 * 1024,
                        'GB': 1024 * 1024 * 1024,
                        'TB': 1024 * 1024 * 1024 * 1024
                    };
                    
                    for (const [suffix, multiplier] of Object.entries(units)) {
                        if (memory.endsWith(suffix)) {
                            return parseFloat(memory) * multiplier;
                        }
                    }
                    return parseFloat(memory);
                }

                function formatCpu(cores) {
                    if (cores < 0.001) return (cores * 1000000).toFixed(0) + 'µ';
                    if (cores < 1) return (cores * 1000).toFixed(0) + 'm';
                    return cores.toFixed(2);
                }

                function formatMemory(bytes) {
                    if (bytes === 0) return '0 B';
                    const k = 1024;
                    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
                }

                function showError(error) {
                    document.getElementById('loading').style.display = 'none';
                    document.getElementById('error-container').innerHTML = \`
                        <div class="error-message">
                            <strong>Error:</strong> \${error}<br><br>
                            Make sure metrics-server is installed in your cluster:<br>
                            <code>kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml</code>
                        </div>
                    \`;
                }
                
                // Request initial data
                vscode.postMessage({ type: 'requestMetrics' });
            </script>
        </body>
        </html>
    `;
}

export async function enableClusterMetrics(context: vscode.ExtensionContext, item: any): Promise<void> {
    if (!item || !item.id) {
        vscode.window.showErrorMessage('No cluster selected');
        return;
    }

    const clusterName = item.id;
    const metricsState = context.globalState.get<Record<string, boolean>>('clusterMetricsEnabled', {});
    metricsState[clusterName] = true;
    await context.globalState.update('clusterMetricsEnabled', metricsState);

    vscode.window.showInformationMessage(`Metrics enabled for cluster: ${clusterName}`);
}

export async function disableClusterMetrics(context: vscode.ExtensionContext, item: any): Promise<void> {
    if (!item || !item.id) {
        vscode.window.showErrorMessage('No cluster selected');
        return;
    }

    const clusterName = item.id;
    const metricsState = context.globalState.get<Record<string, boolean>>('clusterMetricsEnabled', {});
    metricsState[clusterName] = false;
    await context.globalState.update('clusterMetricsEnabled', metricsState);

    vscode.window.showInformationMessage(`Metrics disabled for cluster: ${clusterName}`);
}

export function isClusterMetricsEnabled(context: vscode.ExtensionContext, clusterName: string): boolean {
    const globalSetting = vscode.workspace.getConfiguration('clusterPilot').get<boolean>('enableMetrics', true);
    if (!globalSetting) {
        return false;
    }

    const metricsState = context.globalState.get<Record<string, boolean>>('clusterMetricsEnabled', {});
    // If not explicitly set for this cluster, default to true (enabled)
    return metricsState[clusterName] !== false;
}

export async function showEvents(context: vscode.ExtensionContext, k8sClient: K8sClient, namespace?: string): Promise<void> {
    EventsPanel.show(context.extensionUri, k8sClient, namespace);
}

export async function exportResourceToYaml(item: ResourceItem): Promise<void> {
    if (!item || !item.resource) {
        vscode.window.showErrorMessage('No resource selected');
        return;
    }

    try {
        const yaml = YAML.stringify(item.resource);
        const fileName = `${item.resource.metadata?.name || 'resource'}.yaml`;
        
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(fileName),
            filters: {
                'YAML files': ['yaml', 'yml'],
                'All files': ['*']
            }
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(yaml, 'utf8'));
            vscode.window.showInformationMessage(`Resource exported to ${uri.fsPath}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to export resource: ${error}`);
    }
}

export async function rollbackDeployment(k8sClient: K8sClient, item: ResourceItem): Promise<void> {
    if (!item || !item.resource || item.resourceKind !== 'deployment') {
        vscode.window.showErrorMessage('Please select a deployment');
        return;
    }

    const name = item.resource.metadata?.name;
    const namespace = item.resource.metadata?.namespace;

    if (!name || !namespace) {
        vscode.window.showErrorMessage('Invalid deployment');
        return;
    }

    // Get revision history
    try {
        const replicaSets = await k8sClient.getReplicaSets(namespace);
        const deploymentRS = replicaSets.filter(rs => 
            rs.metadata?.ownerReferences?.some((ref: any) => ref.name === name && ref.kind === 'Deployment')
        );

        if (deploymentRS.length < 2) {
            vscode.window.showWarningMessage('No previous revision available for rollback');
            return;
        }

        const revisions = deploymentRS
            .map(rs => ({
                revision: rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '0',
                name: rs.metadata?.name,
                replicas: rs.spec?.replicas || 0
            }))
            .sort((a, b) => parseInt(b.revision) - parseInt(a.revision));

        const items = revisions.map(r => `Revision ${r.revision} (${r.name})`);
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select revision to rollback to'
        });

        if (!selected) {
            return;
        }

        const revision = selected.match(/Revision (\d+)/)?.[1];
        if (!revision) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Rollback deployment "${name}" to revision ${revision}?`,
            { modal: true },
            'Rollback'
        );

        if (confirm === 'Rollback') {
            await k8sClient.rollbackDeployment(name, namespace, parseInt(revision));
            vscode.window.showInformationMessage(`Deployment rollback initiated to revision ${revision}`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to rollback deployment: ${error}`);
    }
}
export async function setResourceNamespaceFilter(resourceProvider: ResourceProvider): Promise<void> {
    const currentFilter = resourceProvider.getNamespaceFilter();
    
    const options = [
        { label: 'All Namespaces', description: 'Show resources from all namespaces', value: undefined },
        { label: 'Enter Custom Namespace', description: 'Type a specific namespace name', value: 'custom' }
    ];

    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: currentFilter ? `Current: ${currentFilter}` : 'Filter resources by namespace'
    });

    if (!selected) {
        return;
    }

    if (selected.value === 'custom') {
        const namespace = await vscode.window.showInputBox({
            prompt: 'Enter namespace name',
            placeHolder: 'default',
            value: currentFilter || ''
        });

        if (namespace !== undefined) {
            resourceProvider.setNamespaceFilter(namespace || undefined);
            vscode.window.showInformationMessage(
                namespace ? `Filtering resources by namespace: ${namespace}` : 'Showing all namespaces'
            );
        }
    } else {
        resourceProvider.setNamespaceFilter(undefined);
        vscode.window.showInformationMessage('Showing all namespaces');
    }
}

export async function startPortForward(
    portForwardManager: PortForwardManager,
    item: any
): Promise<void> {
    if (!item || !item.resource) {
        vscode.window.showErrorMessage('Invalid resource selected');
        return;
    }

    const resource = item.resource;
    const namespace = resource.metadata?.namespace;
    const podName = resource.metadata?.name;
    let ports: number[] = [];

    // Extract ports based on resource type
    if (resource.kind === 'Pod' && resource.spec?.containers) {
        // Get all container ports from pod
        for (const container of resource.spec.containers) {
            if (container.ports) {
                ports.push(...container.ports.map((p: any) => p.containerPort));
            }
        }
    } else if (resource.kind === 'Service' && resource.spec?.ports) {
        // Get service ports
        ports = resource.spec.ports.map((p: any) => p.targetPort || p.port);
    }

    if (ports.length === 0) {
        // Manual port entry
        const portInput = await vscode.window.showInputBox({
            prompt: 'Enter remote port number',
            placeHolder: '8080',
            validateInput: (value) => {
                const port = parseInt(value);
                return port > 0 && port <= 65535 ? null : 'Invalid port number';
            }
        });

        if (!portInput) {
            return;
        }
        ports = [parseInt(portInput)];
    }

    // Select port if multiple available
    let remotePort: number;
    if (ports.length === 1) {
        remotePort = ports[0];
    } else {
        const selected = await vscode.window.showQuickPick(
            ports.map(p => ({ label: `Port ${p}`, port: p })),
            { placeHolder: 'Select port to forward' }
        );
        if (!selected) {
            return;
        }
        remotePort = selected.port;
    }

    // Ask for local port
    const localPortInput = await vscode.window.showInputBox({
        prompt: 'Enter local port (leave empty for auto)',
        placeHolder: remotePort.toString(),
        validateInput: (value) => {
            if (!value) {
                return null;
            }
            const port = parseInt(value);
            return port > 0 && port <= 65535 ? null : 'Invalid port number';
        }
    });

    const localPort = localPortInput ? parseInt(localPortInput) : undefined;

    try {
        await portForwardManager.startPortForward(namespace, podName, remotePort, localPort);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to start port forward: ${error}`);
    }
}

export async function stopPortForward(
    portForwardManager: PortForwardManager,
    id: string
): Promise<void> {
    try {
        await portForwardManager.stopPortForward(id);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to stop port forward: ${error}`);
    }
}

export async function listPortForwards(portForwardManager: PortForwardManager): Promise<void> {
    const forwards = portForwardManager.getActiveForwards();
    
    if (forwards.length === 0) {
        vscode.window.showInformationMessage('No active port forwards');
        return;
    }

    const selected = await vscode.window.showQuickPick(
        forwards.map(f => ({
            label: `${f.podName}:${f.localPort}→${f.remotePort}`,
            description: f.namespace,
            id: f.id
        })),
        { placeHolder: 'Select port forward to stop' }
    );

    if (selected) {
        await stopPortForward(portForwardManager, selected.id);
    }
}

export async function execInPod(
    terminalManager: TerminalManager,
    item: any
): Promise<void> {
    if (!item || !item.resource) {
        vscode.window.showErrorMessage('Invalid pod selected');
        return;
    }

    const pod = item.resource;
    const namespace = pod.metadata?.namespace;
    const name = pod.metadata?.name;

    if (!namespace || !name) {
        vscode.window.showErrorMessage('Invalid pod resource');
        return;
    }

    try {
        await terminalManager.execInPod(namespace, name);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to execute in pod: ${error}`);
    }
}

// Helm commands

export async function installHelmChart(
    helmManager: HelmManager,
    helmProvider: HelmProvider
): Promise<void> {
    // Search for chart
    const searchTerm = await vscode.window.showInputBox({
        prompt: 'Search for Helm chart',
        placeHolder: 'nginx, mysql, wordpress, etc.'
    });

    if (!searchTerm) {
        return;
    }

    try {
        const charts = await helmManager.searchCharts(searchTerm);

        if (charts.length === 0) {
            vscode.window.showWarningMessage('No charts found. Try updating repositories first.');
            return;
        }

        const selectedChart = await vscode.window.showQuickPick(
            charts.map(c => ({
                label: c.name,
                description: c.version,
                detail: c.description,
                chart: c
            })),
            { placeHolder: 'Select chart to install' }
        );

        if (!selectedChart) {
            return;
        }

        // Get release name
        const releaseName = await vscode.window.showInputBox({
            prompt: 'Enter release name',
            placeHolder: 'my-release',
            validateInput: (value) => {
                return value && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) 
                    ? null 
                    : 'Invalid release name (lowercase alphanumeric and hyphens only)';
            }
        });

        if (!releaseName) {
            return;
        }

        // Get namespace
        const namespace = await vscode.window.showInputBox({
            prompt: 'Enter namespace',
            placeHolder: 'default',
            value: 'default'
        });

        if (!namespace) {
            return;
        }

        // Ask if user wants to provide custom values
        const customValues = await vscode.window.showQuickPick(
            ['No', 'Yes - Edit values'],
            { placeHolder: 'Do you want to customize values?' }
        );

        let values: string | undefined;
        if (customValues === 'Yes - Edit values') {
            const doc = await vscode.workspace.openTextDocument({
                content: '# Enter custom Helm values (YAML format)\n',
                language: 'yaml'
            });
            await vscode.window.showTextDocument(doc);
            
            const confirmed = await vscode.window.showInformationMessage(
                'Edit values, then click Install',
                'Install',
                'Cancel'
            );

            if (confirmed !== 'Install') {
                return;
            }

            values = doc.getText();
        }

        // Install
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Installing ${releaseName}...`,
                cancellable: false
            },
            async () => {
                await helmManager.installChart(
                    releaseName,
                    selectedChart.chart.name,
                    namespace,
                    values,
                    selectedChart.chart.version
                );
            }
        );

        vscode.window.showInformationMessage(`Helm release ${releaseName} installed successfully`);
        helmProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to install chart: ${error}`);
    }
}

export async function uninstallHelmRelease(
    helmManager: HelmManager,
    helmProvider: HelmProvider,
    item: HelmItem
): Promise<void> {
    if (!item.release) {
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Uninstall Helm release "${item.release.name}" from namespace "${item.release.namespace}"?`,
        { modal: true },
        'Uninstall'
    );

    if (confirm !== 'Uninstall') {
        return;
    }

    try {
        await helmManager.uninstallRelease(item.release.name, item.release.namespace);
        vscode.window.showInformationMessage(`Helm release ${item.release.name} uninstalled`);
        helmProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to uninstall release: ${error}`);
    }
}

export async function upgradeHelmRelease(
    helmManager: HelmManager,
    helmProvider: HelmProvider,
    item: HelmItem
): Promise<void> {
    if (!item.release) {
        return;
    }

    try {
        // Get current values
        const currentValues = await helmManager.getReleaseValues(
            item.release.name,
            item.release.namespace
        );

        // Open values for editing
        const doc = await vscode.workspace.openTextDocument({
            content: currentValues,
            language: 'yaml'
        });
        await vscode.window.showTextDocument(doc);

        const confirmed = await vscode.window.showInformationMessage(
            'Edit values, then click Upgrade',
            'Upgrade',
            'Cancel'
        );

        if (confirmed !== 'Upgrade') {
            return;
        }

        const newValues = doc.getText();

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Upgrading ${item.release.name}...`,
                cancellable: false
            },
            async () => {
                await helmManager.upgradeRelease(
                    item.release!.name,
                    item.release!.chart,
                    item.release!.namespace,
                    newValues
                );
            }
        );

        vscode.window.showInformationMessage(`Helm release ${item.release.name} upgraded`);
        helmProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to upgrade release: ${error}`);
    }
}

export async function rollbackHelmRelease(
    helmManager: HelmManager,
    helmProvider: HelmProvider,
    item: HelmItem
): Promise<void> {
    if (!item.release) {
        return;
    }

    try {
        const history = await helmManager.getReleaseHistory(
            item.release.name,
            item.release.namespace
        );

        const selected = await vscode.window.showQuickPick(
            history.map(h => ({
                label: `Revision ${h.revision}`,
                description: h.status,
                detail: `Updated: ${h.updated} | Chart: ${h.chart}`,
                revision: h.revision
            })),
            { placeHolder: 'Select revision to rollback to' }
        );

        if (!selected) {
            return;
        }

        await helmManager.rollbackRelease(
            item.release.name,
            item.release.namespace,
            selected.revision
        );

        vscode.window.showInformationMessage(
            `Rolled back ${item.release.name} to revision ${selected.revision}`
        );
        helmProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to rollback release: ${error}`);
    }
}

export async function viewHelmReleaseDetails(
    helmManager: HelmManager,
    item: HelmItem
): Promise<void> {
    if (!item.release) {
        return;
    }

    try {
        const details = await helmManager.getReleaseDetails(
            item.release.name,
            item.release.namespace
        );

        const doc = await vscode.workspace.openTextDocument({
            content: details,
            language: 'yaml'
        });
        await vscode.window.showTextDocument(doc, { preview: true });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to get release details: ${error}`);
    }
}

export async function addHelmRepo(
    helmManager: HelmManager,
    helmProvider: HelmProvider
): Promise<void> {
    const name = await vscode.window.showInputBox({
        prompt: 'Enter repository name',
        placeHolder: 'bitnami',
        validateInput: (value) => {
            return value && /^[a-z0-9-]+$/.test(value) 
                ? null 
                : 'Invalid name (lowercase alphanumeric and hyphens only)';
        }
    });

    if (!name) {
        return;
    }

    const url = await vscode.window.showInputBox({
        prompt: 'Enter repository URL',
        placeHolder: 'https://charts.bitnami.com/bitnami',
        validateInput: (value) => {
            return value && value.startsWith('http') 
                ? null 
                : 'Invalid URL';
        }
    });

    if (!url) {
        return;
    }

    try {
        await helmManager.addRepo(name, url);
        await helmManager.updateRepos();
        vscode.window.showInformationMessage(`Helm repository ${name} added`);
        helmProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to add repository: ${error}`);
    }
}

export async function removeHelmRepo(
    helmManager: HelmManager,
    helmProvider: HelmProvider,
    item: HelmItem
): Promise<void> {
    if (!item.repo) {
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Remove Helm repository "${item.repo.name}"?`,
        { modal: true },
        'Remove'
    );

    if (confirm !== 'Remove') {
        return;
    }

    try {
        await helmManager.removeRepo(item.repo.name);
        vscode.window.showInformationMessage(`Helm repository ${item.repo.name} removed`);
        helmProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to remove repository: ${error}`);
    }
}

export async function updateHelmRepos(
    helmManager: HelmManager,
    helmProvider: HelmProvider
): Promise<void> {
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Updating Helm repositories...',
                cancellable: false
            },
            async () => {
                await helmManager.updateRepos();
            }
        );

        vscode.window.showInformationMessage('Helm repositories updated');
        helmProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to update repositories: ${error}`);
    }
}

// RBAC commands

export function viewRBACDetails(
    context: vscode.ExtensionContext,
    item: RBACItem
): void {
    if (!item.resource) {
        return;
    }

    new RBACViewerPanel(context, item.resource, item.itemType);
}

// Health and Alert commands

export function showAlerts(
    context: vscode.ExtensionContext,
    alertManager: AlertManager
): void {
    new AlertsPanel(context, alertManager);
}

export async function configureHealthThresholds(
    healthMonitor: HealthMonitor
): Promise<void> {
    const thresholds = healthMonitor.getThresholds();

    const cpuWarning = await vscode.window.showInputBox({
        prompt: 'CPU Warning Threshold (%)',
        value: thresholds.cpuWarning.toString(),
        validateInput: (value) => {
            const num = parseInt(value);
            return num > 0 && num <= 100 ? null : 'Enter a value between 1 and 100';
        }
    });

    if (!cpuWarning) {
        return;
    }

    const cpuCritical = await vscode.window.showInputBox({
        prompt: 'CPU Critical Threshold (%)',
        value: thresholds.cpuCritical.toString(),
        validateInput: (value) => {
            const num = parseInt(value);
            return num > 0 && num <= 100 ? null : 'Enter a value between 1 and 100';
        }
    });

    if (!cpuCritical) {
        return;
    }

    const memoryWarning = await vscode.window.showInputBox({
        prompt: 'Memory Warning Threshold (%)',
        value: thresholds.memoryWarning.toString(),
        validateInput: (value) => {
            const num = parseInt(value);
            return num > 0 && num <= 100 ? null : 'Enter a value between 1 and 100';
        }
    });

    if (!memoryWarning) {
        return;
    }

    const memoryCritical = await vscode.window.showInputBox({
        prompt: 'Memory Critical Threshold (%)',
        value: thresholds.memoryCritical.toString(),
        validateInput: (value) => {
            const num = parseInt(value);
            return num > 0 && num <= 100 ? null : 'Enter a value between 1 and 100';
        }
    });

    if (!memoryCritical) {
        return;
    }

    await healthMonitor.setThresholds({
        cpuWarning: parseInt(cpuWarning),
        cpuCritical: parseInt(cpuCritical),
        memoryWarning: parseInt(memoryWarning),
        memoryCritical: parseInt(memoryCritical)
    });

    vscode.window.showInformationMessage('Health thresholds updated');
}

// PV Manager command

export function showPVManager(
    context: vscode.ExtensionContext,
    k8sClient: K8sClient
): void {
    new PVManagerPanel(context, k8sClient);
}

// Template commands

export function showResourceTemplates(context: vscode.ExtensionContext): void {
    new TemplateSelectorPanel(context);
}

// Job management commands

export function showJobManager(
    context: vscode.ExtensionContext,
    k8sClient: K8sClient
): void {
    new JobManagerPanel(context, k8sClient);
}

export async function deleteJob(
    k8sClient: K8sClient,
    jobProvider: JobProvider,
    item: { job: { metadata?: { name?: string; namespace?: string } } }
): Promise<void> {
    const name = item.job.metadata?.name;
    const namespace = item.job.metadata?.namespace;

    if (!name || !namespace) {
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Delete job ${name}?`,
        { modal: true },
        'Delete'
    );

    if (confirm === 'Delete') {
        try {
            await k8sClient.deleteJob(name, namespace);
            vscode.window.showInformationMessage(`Job ${name} deleted`);
            jobProvider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete job: ${error}`);
        }
    }
}

export async function triggerCronJob(
    k8sClient: K8sClient,
    jobProvider: JobProvider,
    item: { job: { metadata?: { name?: string; namespace?: string } } }
): Promise<void> {
    const name = item.job.metadata?.name;
    const namespace = item.job.metadata?.namespace;

    if (!name || !namespace) {
        return;
    }

    try {
        await k8sClient.triggerCronJob(name, namespace);
        vscode.window.showInformationMessage(`CronJob ${name} triggered`);
        jobProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to trigger CronJob: ${error}`);
    }
}

export async function suspendCronJob(
    k8sClient: K8sClient,
    jobProvider: JobProvider,
    item: { job: { metadata?: { name?: string; namespace?: string } } }
): Promise<void> {
    const name = item.job.metadata?.name;
    const namespace = item.job.metadata?.namespace;

    if (!name || !namespace) {
        return;
    }

    try {
        await k8sClient.toggleCronJobSuspend(name, namespace, true);
        vscode.window.showInformationMessage(`CronJob ${name} suspended`);
        jobProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to suspend CronJob: ${error}`);
    }
}

export async function resumeCronJob(
    k8sClient: K8sClient,
    jobProvider: JobProvider,
    item: { job: { metadata?: { name?: string; namespace?: string } } }
): Promise<void> {
    const name = item.job.metadata?.name;
    const namespace = item.job.metadata?.namespace;

    if (!name || !namespace) {
        return;
    }

    try {
        await k8sClient.toggleCronJobSuspend(name, namespace, false);
        vscode.window.showInformationMessage(`CronJob ${name} resumed`);
        jobProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to resume CronJob: ${error}`);
    }
}

// Advanced log viewer command

export function showAdvancedLogs(
    context: vscode.ExtensionContext,
    k8sClient: K8sClient,
    item: ResourceItem
): void {
    if (!item.resource) {
        vscode.window.showErrorMessage('Invalid pod information');
        return;
    }
    
    const podName = item.resource.metadata?.name;
    const namespace = item.resource.metadata?.namespace;
    
    if (!podName || !namespace) {
        vscode.window.showErrorMessage('Invalid pod information');
        return;
    }

    // Get container name if multi-container pod
    const containers = (item.resource as any).spec?.containers || [];
    const containerName = containers.length === 1 ? containers[0].name : undefined;

    new AdvancedLogViewer(context, k8sClient, podName, namespace, containerName);
}

// Namespace management commands

export function showNamespaceManager(
    context: vscode.ExtensionContext,
    k8sClient: K8sClient
): void {
    new NamespaceManagerPanel(context, k8sClient);
}

export async function createNamespace(
    k8sClient: K8sClient,
    namespaceProvider: NamespaceProvider
): Promise<void> {
    const name = await vscode.window.showInputBox({
        prompt: 'Enter namespace name',
        placeHolder: 'my-namespace',
        validateInput: (value) => {
            if (!value) {
                return 'Namespace name is required';
            }
            if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) {
                return 'Invalid namespace name. Must be lowercase alphanumeric with hyphens.';
            }
            return null;
        }
    });

    if (!name) {
        return;
    }

    const labelsInput = await vscode.window.showInputBox({
        prompt: 'Enter labels (optional)',
        placeHolder: 'env=prod,team=backend'
    });

    try {
        const labels: { [key: string]: string } = {};
        if (labelsInput) {
            const pairs = labelsInput.split(',');
            for (const pair of pairs) {
                const [key, value] = pair.split('=').map(s => s.trim());
                if (key && value) {
                    labels[key] = value;
                }
            }
        }

        await k8sClient.createNamespace(name, labels);
        vscode.window.showInformationMessage(`Namespace ${name} created`);
        namespaceProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create namespace: ${error}`);
    }
}

export async function deleteNamespace(
    k8sClient: K8sClient,
    namespaceProvider: NamespaceProvider,
    item: { namespace: { metadata?: { name?: string } } }
): Promise<void> {
    const name = item.namespace.metadata?.name;

    if (!name) {
        return;
    }

    // Prevent deletion of system namespaces
    const systemNamespaces = ['default', 'kube-system', 'kube-public', 'kube-node-lease'];
    if (systemNamespaces.includes(name)) {
        vscode.window.showErrorMessage(`Cannot delete system namespace: ${name}`);
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Delete namespace "${name}"? This will delete all resources in the namespace.`,
        { modal: true },
        'Delete'
    );

    if (confirm === 'Delete') {
        try {
            await k8sClient.deleteNamespace(name);
            vscode.window.showInformationMessage(`Namespace ${name} deleted`);
            namespaceProvider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete namespace: ${error}`);
        }
    }
}

export async function showNodeManager(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { NodeManagerPanel } = await import('../views/nodeManager');
    NodeManagerPanel.createOrShow(extensionUri, k8sClient);
}

export async function cordonNode(
    k8sClient: K8sClient,
    nodeProvider: any,
    item: { node: { metadata?: { name?: string } } }
): Promise<void> {
    const nodeName = item.node.metadata?.name;

    if (!nodeName) {
        return;
    }

    try {
        await k8sClient.cordonNode(nodeName);
        vscode.window.showInformationMessage(`Node ${nodeName} cordoned successfully`);
        nodeProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to cordon node: ${error}`);
    }
}

export async function uncordonNode(
    k8sClient: K8sClient,
    nodeProvider: any,
    item: { node: { metadata?: { name?: string } } }
): Promise<void> {
    const nodeName = item.node.metadata?.name;

    if (!nodeName) {
        return;
    }

    try {
        await k8sClient.uncordonNode(nodeName);
        vscode.window.showInformationMessage(`Node ${nodeName} uncordoned successfully`);
        nodeProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to uncordon node: ${error}`);
    }
}

export async function drainNode(
    k8sClient: K8sClient,
    nodeProvider: any,
    item: { node: { metadata?: { name?: string } } }
): Promise<void> {
    const nodeName = item.node.metadata?.name;

    if (!nodeName) {
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to drain node ${nodeName}? This will evict all pods from the node.`,
        { modal: true },
        'Drain'
    );

    if (confirm !== 'Drain') {
        return;
    }

    try {
        await k8sClient.drainNode(nodeName);
        vscode.window.showInformationMessage(`Node ${nodeName} drained successfully`);
        nodeProvider.refresh();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to drain node: ${error}`);
    }
}

export async function showGlobalSearch(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { GlobalSearchPanel } = await import('../views/globalSearch');
    GlobalSearchPanel.createOrShow(extensionUri, k8sClient);
}

export async function editConfigMap(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient,
    item: { resource: { metadata?: { name?: string; namespace?: string } } }
): Promise<void> {
    const name = item.resource.metadata?.name;
    const namespace = item.resource.metadata?.namespace;

    if (!name || !namespace) {
        return;
    }

    const { ConfigSecretEditorPanel } = await import('../views/configSecretEditor');
    ConfigSecretEditorPanel.createOrShow(extensionUri, k8sClient, 'ConfigMap', name, namespace);
}

export async function editSecret(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient,
    item: { resource: { metadata?: { name?: string; namespace?: string } } }
): Promise<void> {
    const name = item.resource.metadata?.name;
    const namespace = item.resource.metadata?.namespace;

    if (!name || !namespace) {
        return;
    }

    const { ConfigSecretEditorPanel } = await import('../views/configSecretEditor');
    ConfigSecretEditorPanel.createOrShow(extensionUri, k8sClient, 'Secret', name, namespace);
}

export async function showNetworkPolicies(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { NetworkPolicyViewerPanel } = await import('../views/networkPolicyViewer');
    NetworkPolicyViewerPanel.createOrShow(extensionUri, k8sClient);
}

export async function showResourceQuotas(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { ResourceQuotaPanel } = await import('../views/resourceQuotaPanel');
    ResourceQuotaPanel.createOrShow(extensionUri, k8sClient);
}

export async function showHPAManager(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { HPAManagerPanel } = await import('../views/hpaManager');
    HPAManagerPanel.createOrShow(extensionUri, k8sClient);
}

export async function showRolloutManager(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient,
    item?: { resource: { metadata?: { name?: string; namespace?: string } } }
): Promise<void> {
    const { RolloutManagerPanel } = await import('../views/rolloutManager');
    
    if (item) {
        const name = item.resource.metadata?.name;
        const namespace = item.resource.metadata?.namespace;
        if (name && namespace) {
            RolloutManagerPanel.createOrShow(extensionUri, k8sClient, name, namespace);
            return;
        }
    }
    
    RolloutManagerPanel.createOrShow(extensionUri, k8sClient);
}

export async function showIngressManager(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { IngressManagerPanel } = await import('../views/ingressManager');
    IngressManagerPanel.createOrShow(extensionUri, k8sClient);
}

export async function showStatefulSetManager(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { StatefulSetManagerPanel } = await import('../views/statefulSetManager');
    StatefulSetManagerPanel.createOrShow(extensionUri, k8sClient);
}

export async function showServiceManager(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { ServiceManagerPanel } = await import('../views/serviceManager');
    ServiceManagerPanel.createOrShow(extensionUri, k8sClient);
}

export async function showDaemonSetManager(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { DaemonSetManagerPanel } = await import('../views/daemonSetManager');
    DaemonSetManagerPanel.createOrShow(extensionUri, k8sClient);
}

export async function showPDBManager(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { PDBManagerPanel } = await import('../views/pdbManager');
    PDBManagerPanel.createOrShow(extensionUri, k8sClient);
}

export async function showResourceUsageDashboard(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { ResourceUsageDashboardPanel } = await import('../views/resourceUsageDashboard');
    ResourceUsageDashboardPanel.createOrShow(extensionUri, k8sClient);
}

export async function showCapacityPlanningPanel(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { CapacityPlanningPanel } = await import('../views/capacityPlanningPanel');
    CapacityPlanningPanel.createOrShow(extensionUri, k8sClient);
}

export async function showCostEstimationPanel(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    const { CostEstimationPanel } = await import('../views/costEstimationPanel');
    CostEstimationPanel.createOrShow(extensionUri, k8sClient);
}

export async function compareResources(
    k8sClient: K8sClient,
    kubeconfigManager: KubeconfigManager,
    item?: { resource: { metadata?: { name?: string; namespace?: string }; kind?: string } }
): Promise<void> {
    const { ResourceComparisonPanel } = await import('../views/resourceComparisonPanel');
    
    // Get first resource (from context menu or manual selection)
    let leftResource: any;
    
    if (item && item.resource.metadata) {
        leftResource = {
            name: item.resource.metadata.name || '',
            namespace: item.resource.metadata.namespace || 'default',
            kind: item.resource.kind || ''
        };
    } else {
        // Manual selection
        const kindInput = await vscode.window.showInputBox({
            prompt: 'Enter resource kind (e.g., Deployment, Service)',
            placeHolder: 'Deployment'
        });
        if (!kindInput) { return; }

        const nameInput = await vscode.window.showInputBox({
            prompt: 'Enter resource name',
            placeHolder: 'my-app'
        });
        if (!nameInput) { return; }

        const namespaceInput = await vscode.window.showInputBox({
            prompt: 'Enter namespace',
            placeHolder: 'default',
            value: 'default'
        });
        if (!namespaceInput) { return; }

        leftResource = {
            name: nameInput,
            namespace: namespaceInput,
            kind: kindInput
        };
    }

    // Get second resource to compare with
    const nameInput = await vscode.window.showInputBox({
        prompt: 'Enter second resource name',
        placeHolder: leftResource.name
    });
    if (!nameInput) { return; }

    const namespaceInput = await vscode.window.showInputBox({
        prompt: 'Enter second resource namespace',
        placeHolder: leftResource.namespace,
        value: leftResource.namespace
    });
    if (!namespaceInput) { return; }

    const rightResource = {
        name: nameInput,
        namespace: namespaceInput,
        kind: leftResource.kind
    };

    await ResourceComparisonPanel.show(k8sClient, kubeconfigManager, 'resources', {
        left: leftResource,
        right: rightResource
    });
}

export async function compareWithRevision(
    k8sClient: K8sClient,
    kubeconfigManager: KubeconfigManager,
    item?: { resource: { metadata?: { name?: string; namespace?: string }; kind?: string } }
): Promise<void> {
    const { ResourceComparisonPanel } = await import('../views/resourceComparisonPanel');
    
    if (!item || !item.resource.metadata) {
        vscode.window.showWarningMessage('Please select a resource from the tree view');
        return;
    }

    const name = item.resource.metadata.name;
    const namespace = item.resource.metadata.namespace;
    const kind = item.resource.kind;

    if (!name || !namespace || !kind) {
        vscode.window.showErrorMessage('Invalid resource selection');
        return;
    }

    // Only supported for certain resource types
    const supportedKinds = ['Deployment', 'StatefulSet', 'DaemonSet'];
    if (!supportedKinds.includes(kind)) {
        vscode.window.showWarningMessage(`Revision comparison is only supported for ${supportedKinds.join(', ')}`);
        return;
    }

    const revisionInput = await vscode.window.showInputBox({
        prompt: 'Enter revision number (leave empty for previous revision)',
        placeHolder: 'auto'
    });

    const revision = revisionInput ? parseInt(revisionInput) : undefined;

    await ResourceComparisonPanel.show(k8sClient, kubeconfigManager, 'revision', {
        kind,
        name,
        namespace,
        revision
    });
}

export async function compareAcrossNamespaces(
    k8sClient: K8sClient,
    kubeconfigManager: KubeconfigManager,
    item?: { resource: { metadata?: { name?: string; namespace?: string }; kind?: string } } | { id: string; type: string }
): Promise<void> {
    const { ResourceComparisonPanel } = await import('../views/resourceComparisonPanel');
    
    let name: string, kind: string, namespaceLeft: string;

    // Check if invoked from cluster panel (namespace item)
    if (item && 'type' in item && item.type === 'namespace') {
        // Invoked from cluster panel namespace - prompt for resource details
        const kindInput = await vscode.window.showInputBox({
            prompt: 'Enter resource kind to compare',
            placeHolder: 'Deployment, Service, ConfigMap, etc.'
        });
        if (!kindInput) { return; }

        const nameInput = await vscode.window.showInputBox({
            prompt: 'Enter resource name',
            placeHolder: 'my-app'
        });
        if (!nameInput) { return; }

        kind = kindInput;
        name = nameInput;
        namespaceLeft = item.id; // Use the namespace from the cluster item
    } else if (item && 'resource' in item && item.resource.metadata) {
        // Invoked from resource item
        name = item.resource.metadata.name || '';
        kind = item.resource.kind || '';
        namespaceLeft = item.resource.metadata.namespace || 'default';
    } else {
        // Invoked from command palette
        const kindInput = await vscode.window.showInputBox({
            prompt: 'Enter resource kind',
            placeHolder: 'Deployment'
        });
        if (!kindInput) { return; }

        const nameInput = await vscode.window.showInputBox({
            prompt: 'Enter resource name',
            placeHolder: 'my-app'
        });
        if (!nameInput) { return; }

        const namespaceInput = await vscode.window.showInputBox({
            prompt: 'Enter first namespace',
            placeHolder: 'default'
        });
        if (!namespaceInput) { return; }

        name = nameInput;
        kind = kindInput;
        namespaceLeft = namespaceInput;
    }

    const namespaceRight = await vscode.window.showInputBox({
        prompt: 'Enter second namespace to compare with',
        placeHolder: 'production',
        value: namespaceLeft === 'default' ? 'production' : 'default'
    });

    if (!namespaceRight) { return; }

    await ResourceComparisonPanel.show(k8sClient, kubeconfigManager, 'namespace', {
        kind,
        name,
        namespaceLeft,
        namespaceRight
    });
}

export async function compareAcrossClusters(
    k8sClient: K8sClient,
    kubeconfigManager: KubeconfigManager,
    item?: { resource: { metadata?: { name?: string; namespace?: string }; kind?: string } } | { id: string; type: string }
): Promise<void> {
    const { ResourceComparisonPanel } = await import('../views/resourceComparisonPanel');
    
    const contexts = kubeconfigManager.getContexts();
    if (contexts.length < 2) {
        vscode.window.showWarningMessage('You need at least 2 cluster contexts configured to compare across clusters');
        return;
    }

    let name: string, kind: string, namespace: string;

    // Check if invoked from cluster panel (namespace item)
    if (item && 'type' in item && item.type === 'namespace') {
        // Invoked from cluster panel namespace - prompt for resource details
        const kindInput = await vscode.window.showInputBox({
            prompt: 'Enter resource kind to compare',
            placeHolder: 'Deployment, Service, ConfigMap, etc.'
        });
        if (!kindInput) { return; }

        const nameInput = await vscode.window.showInputBox({
            prompt: 'Enter resource name',
            placeHolder: 'my-app'
        });
        if (!nameInput) { return; }

        kind = kindInput;
        name = nameInput;
        namespace = item.id; // Use the namespace from the cluster item
    } else if (item && 'resource' in item && item.resource.metadata) {
        // Invoked from resource item
        name = item.resource.metadata.name || '';
        kind = item.resource.kind || '';
        namespace = item.resource.metadata.namespace || 'default';
    } else {
        // Invoked from command palette
        const kindInput = await vscode.window.showInputBox({
            prompt: 'Enter resource kind',
            placeHolder: 'Deployment'
        });
        if (!kindInput) { return; }

        const nameInput = await vscode.window.showInputBox({
            prompt: 'Enter resource name',
            placeHolder: 'my-app'
        });
        if (!nameInput) { return; }

        const namespaceInput = await vscode.window.showInputBox({
            prompt: 'Enter namespace',
            placeHolder: 'default',
            value: 'default'
        });
        if (!namespaceInput) { return; }

        name = nameInput;
        kind = kindInput;
        namespace = namespaceInput;
    }

    const contextNames = contexts.map(c => c.name);
    const currentContext = kubeconfigManager.getCurrentContext();
    
    const contextLeft = await vscode.window.showQuickPick(contextNames, {
        placeHolder: 'Select first cluster context'
    });
    if (!contextLeft) { return; }

    const contextRight = await vscode.window.showQuickPick(
        contextNames.filter((c: string) => c !== contextLeft), 
        { placeHolder: 'Select second cluster context' }
    );
    if (!contextRight) { return; }

    await ResourceComparisonPanel.show(k8sClient, kubeconfigManager, 'cluster', {
        kind,
        name,
        namespace,
        contextLeft,
        contextRight
    });
}

export async function showMultiClusterManager(
    k8sClient: K8sClient,
    kubeconfigManager: KubeconfigManager
): Promise<void> {
    const { MultiClusterManagerPanel } = await import('../views/multiClusterManager');
    await MultiClusterManagerPanel.show(k8sClient, kubeconfigManager);
}

// CRD Manager - Full Custom Resource Definitions management
export async function showCRDManager(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    CRDManagerPanel.show(extensionUri, k8sClient);
}

// Event Stream Viewer - Real-time event monitoring with live streaming
export async function showEventStreamViewer(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    EventStreamViewerPanel.show(extensionUri, k8sClient);
}

// Helm Manager Panel - Comprehensive Helm release management
export async function showHelmManagerPanel(
    extensionUri: vscode.Uri,
    helmManager: HelmManager
): Promise<void> {
    await HelmManagerPanel.show(extensionUri, helmManager);
}

// Port Forward Panel - Visual port forwarding management
export async function showPortForwardPanel(
    extensionUri: vscode.Uri,
    portForwardManager: PortForwardManager,
    k8sClient: K8sClient
): Promise<void> {
    PortForwardPanel.show(extensionUri, portForwardManager, k8sClient);
}

// Security Scanning Panel - Comprehensive security analysis
export async function showSecurityScanningPanel(
    extensionUri: vscode.Uri,
    k8sClient: K8sClient
): Promise<void> {
    await SecurityScanningPanel.show(extensionUri, k8sClient);
}


