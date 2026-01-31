import * as vscode from 'vscode';
import { PortForwardManager, PortForward } from '../utils/portForwardManager';
import { K8sClient } from '../utils/k8sClient';

export class PortForwardPanel {
    private static currentPanel: PortForwardPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private portForwardManager: PortForwardManager,
        private k8sClient: K8sClient
    ) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this.disposables
        );
        
        this.panel.webview.html = this.getHtmlContent();
        this.updateForwards();
    }

    public static show(
        extensionUri: vscode.Uri,
        portForwardManager: PortForwardManager,
        k8sClient: K8sClient
    ): void {
        const column = vscode.ViewColumn.One;

        if (PortForwardPanel.currentPanel) {
            PortForwardPanel.currentPanel.panel.reveal(column);
            PortForwardPanel.currentPanel.updateForwards();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'portForwardPanel',
            '📡 Port Forwards',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        PortForwardPanel.currentPanel = new PortForwardPanel(
            panel,
            extensionUri,
            portForwardManager,
            k8sClient
        );
    }

    private updateForwards(): void {
        const forwards = this.portForwardManager.getActiveForwards();
        this.panel.webview.postMessage({
            command: 'update',
            forwards: forwards.map((f: PortForward) => ({
                id: f.id,
                namespace: f.namespace,
                podName: f.podName,
                localPort: f.localPort,
                remotePort: f.remotePort
            }))
        });
        this.startAutoRefresh();
    }

    private startAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        
        this.refreshInterval = setInterval(() => {
            this.updateForwards();
        }, 5000);
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'refresh':
                this.updateForwards();
                break;
            case 'stop':
                await this.stopForward(message.id);
                break;
            case 'stopAll':
                await this.stopAllForwards();
                break;
            case 'create':
                await this.createForward();
                break;
            case 'openBrowser':
                await this.openInBrowser(message.port);
                break;
        }
    }

    private async stopForward(id: string): Promise<void> {
        try {
            this.portForwardManager.stopPortForward(id);
            vscode.window.showInformationMessage(`Stopped port forward: ${id}`);
            this.updateForwards();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to stop port forward: ${error}`);
        }
    }

    private async stopAllForwards(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Stop all port forwards?',
            { modal: true },
            'Stop All'
        );

        if (confirm === 'Stop All') {
            this.portForwardManager.stopAllPortForwards();
            vscode.window.showInformationMessage('Stopped all port forwards');
            this.updateForwards();
        }
    }

    private async createForward(): Promise<void> {
        // Get namespaces
        const namespaces = await this.k8sClient.getNamespaces();
        const namespace = await vscode.window.showQuickPick(
            namespaces.map(ns => ns.metadata?.name || ''),
            { placeHolder: 'Select namespace' }
        );
        if (!namespace) { return; }

        // Get pods in namespace
        const pods = await this.k8sClient.getPods(namespace);
        const podName = await vscode.window.showQuickPick(
            pods.map(pod => pod.metadata?.name || ''),
            { placeHolder: 'Select pod' }
        );
        if (!podName) { return; }

        // Get pod details to show container ports
        const pod = pods.find(p => p.metadata?.name === podName);
        const ports: number[] = [];
        pod?.spec?.containers?.forEach(container => {
            container.ports?.forEach(port => {
                if (port.containerPort) {
                    ports.push(port.containerPort);
                }
            });
        });

        const remotePortStr = await vscode.window.showQuickPick(
            ports.length > 0 ? ports.map(p => p.toString()) : ['80', '443', '8080', '3000', '5000'],
            { placeHolder: 'Select or enter remote port' }
        );
        if (!remotePortStr) { return; }
        const remotePort = parseInt(remotePortStr);

        const localPortStr = await vscode.window.showInputBox({
            prompt: 'Enter local port (leave empty for auto)',
            placeHolder: remotePortStr,
            validateInput: (value) => {
                if (value && (isNaN(parseInt(value)) || parseInt(value) < 1 || parseInt(value) > 65535)) {
                    return 'Invalid port number';
                }
                return null;
            }
        });

        const localPort = localPortStr ? parseInt(localPortStr) : undefined;

        try {
            await this.portForwardManager.startPortForward(namespace, podName, remotePort, localPort);
            vscode.window.showInformationMessage(`Port forward started: localhost:${localPort || 'auto'} → ${podName}:${remotePort}`);
            this.updateForwards();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create port forward: ${error}`);
        }
    }

    private async openInBrowser(port: number): Promise<void> {
        const url = `http://localhost:${port}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private dispose(): void {
        PortForwardPanel.currentPanel = undefined;

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

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Port Forwards</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
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
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 2px solid var(--vscode-panel-border);
        }

        h1 {
            font-size: 24px;
            font-weight: 600;
        }

        .controls {
            display: flex;
            gap: 12px;
        }

        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        button.danger {
            background: rgba(244, 67, 54, 0.2);
            color: #f44336;
        }

        button.danger:hover {
            background: rgba(244, 67, 54, 0.3);
        }

        .forwards-table {
            width: 100%;
            border-collapse: collapse;
        }

        .forwards-table thead {
            background: var(--vscode-editor-background);
            position: sticky;
            top: 0;
        }

        .forwards-table th {
            text-align: left;
            padding: 12px;
            border-bottom: 2px solid var(--vscode-panel-border);
            font-weight: 600;
            text-transform: uppercase;
            font-size: 11px;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }

        .forwards-table td {
            padding: 16px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .forwards-table tbody tr:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            background: rgba(76, 175, 80, 0.2);
            color: #4caf50;
        }

        .pulse {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: currentColor;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .port-badge {
            display: inline-block;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 4px 10px;
            border-radius: 12px;
            font-family: monospace;
            font-size: 13px;
            font-weight: 600;
        }

        .namespace-badge {
            color: var(--vscode-textLink-foreground);
            font-weight: 500;
        }

        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }

        .empty-state-icon {
            font-size: 48px;
            margin-bottom: 16px;
            opacity: 0.5;
        }

        .action-buttons {
            display: flex;
            gap: 8px;
        }

        .action-buttons button {
            padding: 6px 12px;
            font-size: 12px;
        }

        .info-card {
            background: var(--vscode-textBlockQuote-background);
            border-left: 4px solid var(--vscode-textLink-foreground);
            padding: 16px;
            margin-bottom: 24px;
            border-radius: 4px;
        }

        .info-card-title {
            font-weight: 600;
            margin-bottom: 8px;
        }

        .info-card-text {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📡 Port Forwards</h1>
        <div class="controls">
            <button onclick="createForward()">➕ New Forward</button>
            <button onclick="refresh()">🔄 Refresh</button>
            <button class="danger" onclick="stopAll()">🛑 Stop All</button>
        </div>
    </div>

    <div class="info-card">
        <div class="info-card-title">💡 Port Forwarding</div>
        <div class="info-card-text">
            Port forwards allow you to access pods and services from your local machine.
            All forwards are listed below with their local and remote ports.
        </div>
    </div>

    <div id="content">
        <table class="forwards-table">
            <thead>
                <tr>
                    <th>Status</th>
                    <th>Namespace</th>
                    <th>Pod</th>
                    <th>Local Port</th>
                    <th>Remote Port</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody id="forwardsBody">
                <tr>
                    <td colspan="6" style="text-align: center; padding: 40px; color: var(--vscode-descriptionForeground);">
                        Loading port forwards...
                    </td>
                </tr>
            </tbody>
        </table>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allForwards = [];

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'update') {
                allForwards = message.forwards || [];
                renderForwards();
            }
        });

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function createForward() {
            vscode.postMessage({ command: 'create' });
        }

        function stopForward(id) {
            vscode.postMessage({ command: 'stop', id });
        }

        function stopAll() {
            vscode.postMessage({ command: 'stopAll' });
        }

        function openBrowser(port) {
            vscode.postMessage({ command: 'openBrowser', port });
        }

        function renderForwards() {
            const tbody = document.getElementById('forwardsBody');
            
            if (allForwards.length === 0) {
                tbody.innerHTML = \`
                    <tr>
                        <td colspan="6">
                            <div class="empty-state">
                                <div class="empty-state-icon">📡</div>
                                <div>No active port forwards</div>
                                <div style="font-size: 13px; margin-top: 8px;">
                                    Create a new port forward to access your pods locally
                                </div>
                            </div>
                        </td>
                    </tr>
                \`;
                return;
            }

            tbody.innerHTML = allForwards.map(forward => \`
                <tr>
                    <td>
                        <span class="status-indicator">
                            <span class="pulse"></span>
                            ACTIVE
                        </span>
                    </td>
                    <td>
                        <span class="namespace-badge">\${forward.namespace}</span>
                    </td>
                    <td>
                        <strong>\${forward.podName}</strong>
                    </td>
                    <td>
                        <span class="port-badge">:\${forward.localPort}</span>
                    </td>
                    <td>
                        <span class="port-badge">:\${forward.remotePort}</span>
                    </td>
                    <td>
                        <div class="action-buttons">
                            <button onclick="openBrowser(\${forward.localPort})">🌐 Open</button>
                            <button onclick="navigator.clipboard.writeText('localhost:\${forward.localPort}')">📋 Copy</button>
                            <button class="danger" onclick="stopForward('\${forward.id}')">🛑 Stop</button>
                        </div>
                    </td>
                </tr>
            \`).join('');
        }
    </script>
</body>
</html>`;
    }
}
