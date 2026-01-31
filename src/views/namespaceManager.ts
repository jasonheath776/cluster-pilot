import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

export class NamespaceManagerPanel {
    private panel: vscode.WebviewPanel;
    private refreshInterval?: NodeJS.Timeout;

    constructor(
        private context: vscode.ExtensionContext,
        private k8sClient: K8sClient,
        private namespaceName?: string
    ) {
        const title = namespaceName ? `Namespace: ${namespaceName}` : 'Namespace Manager';
        
        this.panel = vscode.window.createWebviewPanel(
            'namespaceManager',
            title,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getLoadingContent();
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            undefined,
            context.subscriptions
        );

        this.panel.onDidDispose(() => {
            if (this.refreshInterval) {
                clearInterval(this.refreshInterval);
            }
        });

        this.updateContent();
        
        // Auto-refresh every 10 seconds
        this.refreshInterval = setInterval(() => {
            this.updateContent();
        }, 10000);
    }

    private async handleMessage(message: { 
        command: string; 
        namespaceName?: string;
        labels?: string;
    }) {
        switch (message.command) {
            case 'refresh':
                await this.updateContent();
                break;
            case 'createNamespace':
                if (message.namespaceName) {
                    await this.createNamespace(message.namespaceName, message.labels);
                }
                break;
            case 'deleteNamespace':
                if (message.namespaceName) {
                    await this.deleteNamespace(message.namespaceName);
                }
                break;
            case 'viewResources':
                if (message.namespaceName) {
                    this.viewNamespaceResources(message.namespaceName);
                }
                break;
        }
    }

    private async createNamespace(name: string, labelsStr?: string): Promise<void> {
        try {
            const labels: { [key: string]: string } = {};
            if (labelsStr) {
                const pairs = labelsStr.split(',');
                for (const pair of pairs) {
                    const [key, value] = pair.split('=').map(s => s.trim());
                    if (key && value) {
                        labels[key] = value;
                    }
                }
            }

            await this.k8sClient.createNamespace(name, labels);
            vscode.window.showInformationMessage(`Namespace ${name} created`);
            this.updateContent();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create namespace: ${error}`);
        }
    }

    private async deleteNamespace(name: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete namespace "${name}"? This will delete all resources in the namespace.`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            try {
                await this.k8sClient.deleteNamespace(name);
                vscode.window.showInformationMessage(`Namespace ${name} deleted`);
                this.updateContent();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete namespace: ${error}`);
            }
        }
    }

    private viewNamespaceResources(namespaceName: string): void {
        // This would integrate with the existing resource views
        vscode.window.showInformationMessage(`Viewing resources in ${namespaceName}`);
    }

    private async updateContent(): Promise<void> {
        try {
            const html = await this.getWebviewContent();
            this.panel.webview.html = html;
        } catch (error) {
            this.panel.webview.html = this.getErrorContent(String(error));
        }
    }

    private getLoadingContent(): string {
        return `<!DOCTYPE html>
<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;">
<div>Loading namespace information...</div>
</body></html>`;
    }

    private getErrorContent(error: string): string {
        return `<!DOCTYPE html>
<html><body style="padding:20px;color:var(--vscode-errorForeground);">
<h2>Error</h2><p>${this.escapeHtml(error)}</p>
</body></html>`;
    }

    private async getWebviewContent(): Promise<string> {
        const namespaces = await this.k8sClient.getNamespaces();
        
        // Get resource counts per namespace
        const namespacesWithCounts = await Promise.all(
            namespaces.map(async ns => {
                const name = ns.metadata?.name || '';
                const [pods, services, deployments, configMaps, secrets] = await Promise.all([
                    this.k8sClient.getPods(name),
                    this.k8sClient.getServices(name),
                    this.k8sClient.getDeployments(name),
                    this.k8sClient.getConfigMaps(name),
                    this.k8sClient.getSecrets(name)
                ]);

                return {
                    namespace: ns,
                    counts: {
                        pods: pods.length,
                        services: services.length,
                        deployments: deployments.length,
                        configMaps: configMaps.length,
                        secrets: secrets.length
                    }
                };
            })
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Namespace Manager</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        h1, h2 {
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 10px;
        }
        .toolbar {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            align-items: center;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 13px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .stat-card {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            padding: 15px;
        }
        .stat-value {
            font-size: 32px;
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }
        .stat-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 5px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
        }
        th, td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        th {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-descriptionForeground);
            font-weight: 600;
            font-size: 12px;
            text-transform: uppercase;
        }
        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .badge {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 600;
        }
        .badge-active { background-color: #28a745; color: white; }
        .badge-terminating { background-color: #ffc107; color: black; }
        .resource-count {
            display: inline-block;
            padding: 2px 6px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 10px;
            font-size: 11px;
            margin: 0 3px;
        }
        .actions {
            display: flex;
            gap: 8px;
        }
        .btn-danger {
            background-color: var(--vscode-errorForeground);
            color: white;
        }
        .btn-danger:hover {
            opacity: 0.9;
        }
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 1000;
        }
        .modal-content {
            background-color: var(--vscode-editor-background);
            margin: 10% auto;
            padding: 20px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            width: 500px;
            max-width: 90%;
        }
        .form-group {
            margin-bottom: 15px;
        }
        label {
            display: block;
            margin-bottom: 5px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        input {
            width: 100%;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            border-radius: 3px;
            font-size: 13px;
        }
        input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .system-namespace {
            opacity: 0.7;
        }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <h1>📁 Namespace Manager</h1>
    
    <div class="toolbar">
        <button onclick="openCreateModal()">➕ Create Namespace</button>
        <button onclick="refresh()">🔄 Refresh</button>
    </div>

    <div class="stats">
        <div class="stat-card">
            <div class="stat-value">${namespaces.length}</div>
            <div class="stat-label">Total Namespaces</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${namespaces.filter(ns => ns.status?.phase === 'Active').length}</div>
            <div class="stat-label">Active Namespaces</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${namespacesWithCounts.reduce((sum, ns) => sum + ns.counts.pods, 0)}</div>
            <div class="stat-label">Total Pods</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${namespacesWithCounts.reduce((sum, ns) => sum + ns.counts.services, 0)}</div>
            <div class="stat-label">Total Services</div>
        </div>
    </div>

    <h2>Namespaces</h2>
    ${this.renderNamespacesTable(namespacesWithCounts)}

    <!-- Create Namespace Modal -->
    <div id="createModal" class="modal">
        <div class="modal-content">
            <h2>Create Namespace</h2>
            <div class="form-group">
                <label for="namespaceName">Name *</label>
                <input type="text" id="namespaceName" placeholder="my-namespace" required />
            </div>
            <div class="form-group">
                <label for="namespaceLabels">Labels (optional)</label>
                <input type="text" id="namespaceLabels" placeholder="env=prod,team=backend" />
                <small style="color: var(--vscode-descriptionForeground); font-size: 11px;">
                    Format: key1=value1,key2=value2
                </small>
            </div>
            <div class="actions">
                <button onclick="createNamespace()">Create</button>
                <button onclick="closeCreateModal()" style="background-color: var(--vscode-button-secondaryBackground);">Cancel</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function deleteNamespace(name) {
            vscode.postMessage({
                command: 'deleteNamespace',
                namespaceName: name
            });
        }

        function viewResources(name) {
            vscode.postMessage({
                command: 'viewResources',
                namespaceName: name
            });
        }

        function openCreateModal() {
            document.getElementById('createModal').style.display = 'block';
            document.getElementById('namespaceName').focus();
        }

        function closeCreateModal() {
            document.getElementById('createModal').style.display = 'none';
            document.getElementById('namespaceName').value = '';
            document.getElementById('namespaceLabels').value = '';
        }

        function createNamespace() {
            const name = document.getElementById('namespaceName').value.trim();
            const labels = document.getElementById('namespaceLabels').value.trim();
            
            if (!name) {
                alert('Namespace name is required');
                return;
            }

            // Validate namespace name (RFC 1123)
            if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
                alert('Invalid namespace name. Must be lowercase alphanumeric with hyphens.');
                return;
            }

            vscode.postMessage({
                command: 'createNamespace',
                namespaceName: name,
                labels: labels
            });

            closeCreateModal();
        }

        // Close modal on background click
        window.onclick = function(event) {
            const modal = document.getElementById('createModal');
            if (event.target === modal) {
                closeCreateModal();
            }
        };

        // Enter key to create
        document.getElementById('namespaceName').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                createNamespace();
            }
        });
    </script>
</body>
</html>`;
    }

    private renderNamespacesTable(namespacesWithCounts: Array<{
        namespace: any;
        counts: {
            pods: number;
            services: number;
            deployments: number;
            configMaps: number;
            secrets: number;
        };
    }>): string {
        if (namespacesWithCounts.length === 0) {
            return '<div class="empty-state">No namespaces found</div>';
        }

        let html = '<table><thead><tr><th>Name</th><th>Status</th><th>Resources</th><th>Age</th><th>Labels</th><th>Actions</th></tr></thead><tbody>';

        for (const { namespace, counts } of namespacesWithCounts) {
            const name = namespace.metadata?.name || 'unknown';
            const status = namespace.status?.phase || 'Unknown';
            const labels = namespace.metadata?.labels || {};
            const created = namespace.metadata?.creationTimestamp;
            const age = created ? this.formatAge(new Date(created)) : 'Unknown';
            
            const isSystem = name.startsWith('kube-') || name === 'default';
            const rowClass = isSystem ? 'system-namespace' : '';

            let statusBadge = 'badge-active';
            if (status === 'Terminating') {
                statusBadge = 'badge-terminating';
            }

            const labelStr = Object.entries(labels)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ') || 'None';

            const resourcesHtml = `
                <span class="resource-count" title="Pods">🔵 ${counts.pods}</span>
                <span class="resource-count" title="Services">🌐 ${counts.services}</span>
                <span class="resource-count" title="Deployments">📦 ${counts.deployments}</span>
                <span class="resource-count" title="ConfigMaps">⚙️ ${counts.configMaps}</span>
                <span class="resource-count" title="Secrets">🔐 ${counts.secrets}</span>
            `;

            html += `<tr class="${rowClass}">
                <td><strong>${this.escapeHtml(name)}</strong></td>
                <td><span class="badge ${statusBadge}">${status}</span></td>
                <td>${resourcesHtml}</td>
                <td>${age}</td>
                <td><small>${this.escapeHtml(labelStr)}</small></td>
                <td>
                    <div class="actions">
                        <button onclick="viewResources('${this.escapeHtml(name)}')">View Resources</button>
                        ${!isSystem ? `<button class="btn-danger" onclick="deleteNamespace('${this.escapeHtml(name)}')">Delete</button>` : ''}
                    </div>
                </td>
            </tr>`;
        }

        html += '</tbody></table>';
        return html;
    }

    private formatAge(date: Date): string {
        const now = Date.now();
        const diff = now - date.getTime();
        const seconds = Math.floor(diff / 1000);
        
        if (seconds < 60) {
            return `${seconds}s`;
        } else if (seconds < 3600) {
            return `${Math.floor(seconds / 60)}m`;
        } else if (seconds < 86400) {
            return `${Math.floor(seconds / 3600)}h`;
        } else {
            return `${Math.floor(seconds / 86400)}d`;
        }
    }

    private escapeHtml(text: string): string {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
}
