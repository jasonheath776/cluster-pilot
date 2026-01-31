import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';
import * as k8s from '@kubernetes/client-node';

export class CRDManagerPanel {
    private static currentPanel: CRDManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
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
        this.loadData();
    }

    public static show(extensionUri: vscode.Uri, k8sClient: K8sClient): void {
        const column = vscode.ViewColumn.One;

        if (CRDManagerPanel.currentPanel) {
            CRDManagerPanel.currentPanel.panel.reveal(column);
            CRDManagerPanel.currentPanel.loadData();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'crdManager',
            'Custom Resource Definitions',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        CRDManagerPanel.currentPanel = new CRDManagerPanel(panel, extensionUri, k8sClient);
    }

    private async loadData(): Promise<void> {
        try {
            const crds = await this.k8sClient.getCRDs();
            
            // Load instances for each CRD
            const crdData = await Promise.all(crds.map(async (crd) => {
                const group = crd.spec?.group || '';
                const version = crd.spec?.versions?.find(v => v.served)?.name || crd.spec?.versions?.[0]?.name || '';
                const plural = crd.spec?.names?.plural || '';
                const scope = crd.spec?.scope || 'Namespaced';
                
                let instances: any[] = [];
                let instanceCount = 0;
                
                try {
                    if (group && version && plural) {
                        instances = await this.k8sClient.getCustomResources(group, version, plural);
                        instanceCount = instances.length;
                    }
                } catch (error) {
                    console.error(`Failed to load instances for ${plural}:`, error);
                }
                
                return {
                    name: crd.metadata?.name || 'unknown',
                    group,
                    version,
                    kind: crd.spec?.names?.kind || '',
                    plural,
                    singular: crd.spec?.names?.singular || '',
                    scope,
                    instanceCount,
                    instances,
                    versions: crd.spec?.versions?.map(v => ({
                        name: v.name,
                        served: v.served,
                        storage: v.storage
                    })) || [],
                    conditions: crd.status?.conditions || [],
                    created: crd.metadata?.creationTimestamp || '',
                    labels: crd.metadata?.labels || {},
                    annotations: crd.metadata?.annotations || {}
                };
            }));
            
            this.panel.webview.postMessage({
                command: 'update',
                data: crdData
            });
            
            this.startAutoRefresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load CRDs: ${error}`);
        }
    }

    private startAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        
        this.refreshInterval = setInterval(() => {
            this.loadData();
        }, 10000);
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'refresh':
                await this.loadData();
                break;
            case 'viewYaml':
                await this.viewResourceYaml(message.resource);
                break;
            case 'deleteResource':
                await this.deleteResource(message.resource);
                break;
            case 'viewInstances':
                await this.viewInstances(message.crd);
                break;
            case 'createInstance':
                await this.createInstance(message.crd);
                break;
        }
    }

    private async viewResourceYaml(resource: any): Promise<void> {
        try {
            const yaml = require('yaml');
            const doc = vscode.workspace.openTextDocument({
                language: 'yaml',
                content: yaml.stringify(resource)
            });
            vscode.window.showTextDocument(await doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view YAML: ${error}`);
        }
    }

    private async deleteResource(resource: any): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete ${resource.kind} "${resource.metadata.name}"?`,
            { modal: true },
            'Delete'
        );
        
        if (confirm === 'Delete') {
            try {
                await this.k8sClient.deleteCustomResource(
                    resource.apiVersion.split('/')[0],
                    resource.apiVersion.split('/')[1],
                    resource.kind.toLowerCase() + 's',
                    resource.metadata.name,
                    resource.metadata.namespace
                );
                vscode.window.showInformationMessage(`Deleted ${resource.kind} ${resource.metadata.name}`);
                this.loadData();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete resource: ${error}`);
            }
        }
    }

    private async viewInstances(crd: any): Promise<void> {
        // Open a new panel showing all instances of this CRD
        const instances = crd.instances || [];
        const instanceList = instances.map((inst: any) => 
            `${inst.metadata?.name || 'unknown'} (${inst.metadata?.namespace || 'cluster-wide'})`
        );
        
        const selected = await vscode.window.showQuickPick(instanceList, {
            placeHolder: `Select ${crd.kind} instance to view`
        });
        
        if (selected) {
            const index = instanceList.indexOf(selected);
            if (index >= 0) {
                await this.viewResourceYaml(instances[index]);
            }
        }
    }

    private async createInstance(crd: any): Promise<void> {
        const yaml = require('yaml');
        const template = {
            apiVersion: `${crd.group}/${crd.version}`,
            kind: crd.kind,
            metadata: {
                name: 'new-' + crd.singular,
                namespace: crd.scope === 'Namespaced' ? 'default' : undefined
            },
            spec: {}
        };
        
        const doc = await vscode.workspace.openTextDocument({
            language: 'yaml',
            content: yaml.stringify(template)
        });
        
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage('Edit the template and use kubectl apply to create the resource');
    }

    private dispose(): void {
        CRDManagerPanel.currentPanel = undefined;

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
    <title>Custom Resource Definitions</title>
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

        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }

        .stat-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 16px;
        }

        .stat-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }

        .stat-value {
            font-size: 28px;
            font-weight: 600;
        }

        .search-box {
            width: 100%;
            padding: 10px 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 14px;
            margin-bottom: 20px;
        }

        .search-box:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .crd-grid {
            display: grid;
            gap: 16px;
        }

        .crd-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 20px;
            transition: border-color 0.2s;
        }

        .crd-card:hover {
            border-color: var(--vscode-focusBorder);
        }

        .crd-header {
            display: flex;
            justify-content: space-between;
            align-items: start;
            margin-bottom: 16px;
        }

        .crd-title {
            flex: 1;
        }

        .crd-name {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 4px;
        }

        .crd-group {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }

        .crd-actions {
            display: flex;
            gap: 8px;
        }

        .crd-actions button {
            padding: 6px 12px;
            font-size: 12px;
        }

        .crd-details {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 16px;
            margin-bottom: 16px;
        }

        .detail-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .detail-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .detail-value {
            font-size: 14px;
            font-weight: 500;
        }

        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .badge.namespaced {
            background: rgba(76, 175, 80, 0.2);
            color: #4caf50;
        }

        .badge.cluster {
            background: rgba(33, 150, 243, 0.2);
            color: #2196f3;
        }

        .badge.version {
            background: rgba(156, 39, 176, 0.2);
            color: #9c27b0;
        }

        .badge.storage {
            background: rgba(255, 152, 0, 0.2);
            color: #ff9800;
        }

        .instances-section {
            margin-top: 16px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .instances-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }

        .instances-count {
            font-size: 14px;
            font-weight: 600;
        }

        .instances-count .number {
            color: var(--vscode-textLink-foreground);
            font-size: 18px;
        }

        .instance-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            max-height: 100px;
            overflow-y: auto;
        }

        .instance-chip {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
        }

        .versions-list {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
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

        .empty-state-text {
            font-size: 16px;
            margin-bottom: 8px;
        }

        .empty-state-subtext {
            font-size: 13px;
        }

        .loading {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }

        .status-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 6px;
        }

        .status-indicator.healthy {
            background: #4caf50;
        }

        .status-indicator.warning {
            background: #ff9800;
        }

        .status-indicator.error {
            background: #f44336;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎯 Custom Resource Definitions</h1>
        <div class="controls">
            <button onclick="refresh()">🔄 Refresh</button>
        </div>
    </div>

    <div id="stats" class="stats"></div>

    <input 
        type="text" 
        class="search-box" 
        placeholder="Search CRDs by name, group, or kind..." 
        oninput="filterCRDs(this.value)"
    />

    <div id="content" class="loading">
        Loading Custom Resource Definitions...
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allCRDs = [];

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'update') {
                allCRDs = message.data || [];
                renderCRDs(allCRDs);
            }
        });

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function filterCRDs(searchTerm) {
            const filtered = allCRDs.filter(crd => {
                const term = searchTerm.toLowerCase();
                return crd.name.toLowerCase().includes(term) ||
                       crd.group.toLowerCase().includes(term) ||
                       crd.kind.toLowerCase().includes(term) ||
                       crd.plural.toLowerCase().includes(term);
            });
            renderCRDs(filtered);
        }

        function renderCRDs(crds) {
            renderStats(crds);
            
            const content = document.getElementById('content');
            
            if (crds.length === 0) {
                content.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">📦</div>
                        <div class="empty-state-text">No Custom Resource Definitions Found</div>
                        <div class="empty-state-subtext">Install operators or custom controllers to see CRDs</div>
                    </div>
                \`;
                return;
            }

            content.className = 'crd-grid';
            content.innerHTML = crds.map(crd => \`
                <div class="crd-card">
                    <div class="crd-header">
                        <div class="crd-title">
                            <div class="crd-name">\${crd.kind}</div>
                            <div class="crd-group">\${crd.group}</div>
                        </div>
                        <div class="crd-actions">
                            <button class="secondary" onclick="viewInstances('\${crd.name}')">📋 View Instances</button>
                            <button class="secondary" onclick="createInstance('\${crd.name}')">➕ Create</button>
                            <button class="secondary" onclick="viewYaml('\${crd.name}')">📄 YAML</button>
                        </div>
                    </div>

                    <div class="crd-details">
                        <div class="detail-item">
                            <div class="detail-label">Scope</div>
                            <div class="detail-value">
                                <span class="badge \${crd.scope === 'Namespaced' ? 'namespaced' : 'cluster'}">
                                    \${crd.scope}
                                </span>
                            </div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Plural Name</div>
                            <div class="detail-value">\${crd.plural}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Singular Name</div>
                            <div class="detail-value">\${crd.singular}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">API Versions</div>
                            <div class="detail-value versions-list">
                                \${crd.versions.map(v => \`
                                    <span class="badge \${v.storage ? 'storage' : 'version'}">
                                        \${v.name}\${v.storage ? ' (storage)' : ''}
                                    </span>
                                \`).join('')}
                            </div>
                        </div>
                    </div>

                    <div class="instances-section">
                        <div class="instances-header">
                            <div class="instances-count">
                                <span class="number">\${crd.instanceCount}</span> instance\${crd.instanceCount !== 1 ? 's' : ''}
                            </div>
                        </div>
                        \${crd.instanceCount > 0 ? \`
                            <div class="instance-list">
                                \${crd.instances.slice(0, 10).map(inst => \`
                                    <div class="instance-chip">
                                        \${inst.metadata?.name || 'unknown'}
                                        \${inst.metadata?.namespace ? \` (\${inst.metadata.namespace})\` : ''}
                                    </div>
                                \`).join('')}
                                \${crd.instanceCount > 10 ? \`
                                    <div class="instance-chip">+\${crd.instanceCount - 10} more</div>
                                \` : ''}
                            </div>
                        \` : '<div style="font-size: 13px; color: var(--vscode-descriptionForeground);">No instances created yet</div>'}
                    </div>
                </div>
            \`).join('');
        }

        function renderStats(crds) {
            const totalCRDs = crds.length;
            const totalInstances = crds.reduce((sum, crd) => sum + crd.instanceCount, 0);
            const namespacedCRDs = crds.filter(crd => crd.scope === 'Namespaced').length;
            const clusterCRDs = crds.filter(crd => crd.scope === 'Cluster').length;

            document.getElementById('stats').innerHTML = \`
                <div class="stat-card">
                    <div class="stat-label">Total CRDs</div>
                    <div class="stat-value">\${totalCRDs}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Total Instances</div>
                    <div class="stat-value">\${totalInstances}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Namespaced</div>
                    <div class="stat-value">\${namespacedCRDs}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Cluster-Scoped</div>
                    <div class="stat-value">\${clusterCRDs}</div>
                </div>
            \`;
        }

        function viewYaml(crdName) {
            const crd = allCRDs.find(c => c.name === crdName);
            if (crd) {
                vscode.postMessage({ command: 'viewYaml', resource: crd });
            }
        }

        function viewInstances(crdName) {
            const crd = allCRDs.find(c => c.name === crdName);
            if (crd) {
                vscode.postMessage({ command: 'viewInstances', crd });
            }
        }

        function createInstance(crdName) {
            const crd = allCRDs.find(c => c.name === crdName);
            if (crd) {
                vscode.postMessage({ command: 'createInstance', crd });
            }
        }
    </script>
</body>
</html>`;
    }
}
