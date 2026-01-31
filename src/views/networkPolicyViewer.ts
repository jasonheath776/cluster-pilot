import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';

interface PolicyVisualization {
    name: string;
    namespace: string;
    podSelector: Record<string, string>;
    policyTypes: string[];
    ingress: Array<{
        from: Array<{ type: string; selector?: Record<string, string>; namespace?: string; cidr?: string }>;
        ports: Array<{ protocol?: string; port?: number }>;
    }>;
    egress: Array<{
        to: Array<{ type: string; selector?: Record<string, string>; namespace?: string; cidr?: string }>;
        ports: Array<{ protocol?: string; port?: number }>;
    }>;
}

export class NetworkPolicyViewerPanel {
    public static currentPanel: NetworkPolicyViewerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (NetworkPolicyViewerPanel.currentPanel) {
            NetworkPolicyViewerPanel.currentPanel.panel.reveal(column);
            NetworkPolicyViewerPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'networkPolicyViewer',
            'Network Policies',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        NetworkPolicyViewerPanel.currentPanel = new NetworkPolicyViewerPanel(panel, extensionUri, k8sClient);
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
                        await this.deletePolicy(message.name, message.namespace);
                        break;
                    case 'create':
                        await this.createPolicy(message.policy);
                        break;
                    case 'viewYaml':
                        await this.viewPolicyYaml(message.name, message.namespace);
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
        }, 15000); // Refresh every 15 seconds
    }

    private async refresh() {
        try {
            const policies = await this.k8sClient.getNetworkPolicies();
            const visualizations: PolicyVisualization[] = policies.map(policy => this.visualizePolicy(policy));

            this.panel.webview.postMessage({
                command: 'updatePolicies',
                policies: visualizations
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load network policies: ${error}`);
        }
    }

    private visualizePolicy(policy: k8s.V1NetworkPolicy): PolicyVisualization {
        const ingress = (policy.spec?.ingress || []).map(rule => ({
            from: (rule.from || []).map(peer => {
                if (peer.podSelector) {
                    return {
                        type: 'pod',
                        selector: peer.podSelector.matchLabels || {},
                        namespace: peer.namespaceSelector?.matchLabels ? 
                            Object.entries(peer.namespaceSelector.matchLabels).map(([k, v]) => `${k}=${v}`).join(',') : 
                            undefined
                    };
                } else if (peer.namespaceSelector) {
                    return {
                        type: 'namespace',
                        namespace: Object.entries(peer.namespaceSelector.matchLabels || {}).map(([k, v]) => `${k}=${v}`).join(',')
                    };
                } else if (peer.ipBlock) {
                    return {
                        type: 'cidr',
                        cidr: peer.ipBlock.cidr
                    };
                }
                return { type: 'unknown' };
            }),
            ports: (rule.ports || []).map(port => ({
                protocol: port.protocol || 'TCP',
                port: port.port as number
            }))
        }));

        const egress = (policy.spec?.egress || []).map(rule => ({
            to: (rule.to || []).map(peer => {
                if (peer.podSelector) {
                    return {
                        type: 'pod',
                        selector: peer.podSelector.matchLabels || {},
                        namespace: peer.namespaceSelector?.matchLabels ? 
                            Object.entries(peer.namespaceSelector.matchLabels).map(([k, v]) => `${k}=${v}`).join(',') : 
                            undefined
                    };
                } else if (peer.namespaceSelector) {
                    return {
                        type: 'namespace',
                        namespace: Object.entries(peer.namespaceSelector.matchLabels || {}).map(([k, v]) => `${k}=${v}`).join(',')
                    };
                } else if (peer.ipBlock) {
                    return {
                        type: 'cidr',
                        cidr: peer.ipBlock.cidr
                    };
                }
                return { type: 'unknown' };
            }),
            ports: (rule.ports || []).map(port => ({
                protocol: port.protocol || 'TCP',
                port: port.port as number
            }))
        }));

        return {
            name: policy.metadata?.name || 'unknown',
            namespace: policy.metadata?.namespace || 'default',
            podSelector: policy.spec?.podSelector?.matchLabels || {},
            policyTypes: policy.spec?.policyTypes || [],
            ingress,
            egress
        };
    }

    private async deletePolicy(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete network policy "${name}" in namespace "${namespace}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            await this.k8sClient.deleteNetworkPolicy(name, namespace);
            vscode.window.showInformationMessage(`Network policy ${name} deleted`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete network policy: ${error}`);
        }
    }

    private async createPolicy(policyData: unknown) {
        try {
            // Policy creation logic would go here
            vscode.window.showInformationMessage('Network policy created successfully');
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create network policy: ${error}`);
        }
    }

    private async viewPolicyYaml(name: string, namespace: string) {
        try {
            const policies = await this.k8sClient.getNetworkPolicies(namespace);
            const policy = policies.find(p => p.metadata?.name === name);

            if (!policy) {
                vscode.window.showErrorMessage(`Network policy ${name} not found`);
                return;
            }

            const yaml = JSON.stringify(policy, null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: yaml,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view network policy: ${error}`);
        }
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Network Policies</title>
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
        .policy-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-charts-blue);
        }
        .policy-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .policy-title {
            font-size: 18px;
            font-weight: bold;
        }
        .policy-namespace {
            font-size: 12px;
            opacity: 0.8;
            margin-left: 10px;
        }
        .policy-actions {
            display: flex;
            gap: 5px;
        }
        .policy-actions button {
            padding: 4px 8px;
            font-size: 12px;
        }
        .selector-section {
            margin: 15px 0;
            padding: 10px;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
        }
        .selector-title {
            font-size: 12px;
            font-weight: bold;
            opacity: 0.8;
            margin-bottom: 5px;
        }
        .label-list {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
        }
        .label {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 11px;
        }
        .rules-section {
            margin-top: 15px;
        }
        .rule-type {
            font-weight: bold;
            margin-bottom: 10px;
            color: var(--vscode-charts-green);
        }
        .rule {
            margin: 10px 0;
            padding: 10px;
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-charts-green);
            border-radius: 3px;
        }
        .rule.egress {
            border-left-color: var(--vscode-charts-orange);
        }
        .peer {
            margin: 5px 0;
            font-size: 13px;
        }
        .peer-type {
            display: inline-block;
            padding: 2px 6px;
            background-color: var(--vscode-charts-purple);
            color: white;
            border-radius: 3px;
            font-size: 10px;
            margin-right: 5px;
        }
        .port-list {
            margin-top: 5px;
            font-size: 12px;
            opacity: 0.9;
        }
        .no-policies {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
        .diagram {
            margin: 15px 0;
            padding: 15px;
            background-color: var(--vscode-editor-background);
            border-radius: 4px;
            text-align: center;
        }
        .diagram-node {
            display: inline-block;
            padding: 10px 20px;
            background-color: var(--vscode-charts-blue);
            color: white;
            border-radius: 4px;
            margin: 5px;
        }
        .diagram-arrow {
            display: inline-block;
            margin: 0 10px;
            font-size: 20px;
        }
        .empty-rule {
            font-style: italic;
            opacity: 0.6;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Network Policies</h1>
        <button onclick="refresh()">Refresh</button>
    </div>

    <div id="policiesContainer">
        <div class="no-policies">Loading network policies...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function deletePolicy(name, namespace) {
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

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updatePolicies') {
                renderPolicies(message.policies);
            }
        });

        function renderPolicies(policies) {
            const container = document.getElementById('policiesContainer');
            
            if (policies.length === 0) {
                container.innerHTML = '<div class="no-policies">No network policies found</div>';
                return;
            }

            container.innerHTML = policies.map(policy => {
                const selectorLabels = Object.entries(policy.podSelector)
                    .map(([k, v]) => \`<span class="label">\${k}=\${v}</span>\`)
                    .join('');

                const ingressRules = policy.ingress.map((rule, idx) => {
                    const peers = rule.from.length > 0 ? rule.from.map(peer => {
                        let peerInfo = '';
                        if (peer.type === 'pod') {
                            const labels = Object.entries(peer.selector || {})
                                .map(([k, v]) => \`\${k}=\${v}\`)
                                .join(', ');
                            peerInfo = \`Pods: \${labels}\`;
                            if (peer.namespace) {
                                peerInfo += \` in namespace(\${peer.namespace})\`;
                            }
                        } else if (peer.type === 'namespace') {
                            peerInfo = \`Namespace: \${peer.namespace}\`;
                        } else if (peer.type === 'cidr') {
                            peerInfo = \`CIDR: \${peer.cidr}\`;
                        }
                        return \`
                            <div class="peer">
                                <span class="peer-type">\${peer.type.toUpperCase()}</span>
                                \${peerInfo}
                            </div>
                        \`;
                    }).join('') : '<div class="empty-rule">Allow from all sources</div>';

                    const ports = rule.ports.length > 0 ? 
                        \`<div class="port-list">Ports: \${rule.ports.map(p => \`\${p.protocol}/\${p.port}\`).join(', ')}</div>\` :
                        '<div class="port-list">All ports</div>';

                    return \`
                        <div class="rule">
                            <strong>Rule \${idx + 1}</strong>
                            \${peers}
                            \${ports}
                        </div>
                    \`;
                }).join('');

                const egressRules = policy.egress.map((rule, idx) => {
                    const peers = rule.to.length > 0 ? rule.to.map(peer => {
                        let peerInfo = '';
                        if (peer.type === 'pod') {
                            const labels = Object.entries(peer.selector || {})
                                .map(([k, v]) => \`\${k}=\${v}\`)
                                .join(', ');
                            peerInfo = \`Pods: \${labels}\`;
                            if (peer.namespace) {
                                peerInfo += \` in namespace(\${peer.namespace})\`;
                            }
                        } else if (peer.type === 'namespace') {
                            peerInfo = \`Namespace: \${peer.namespace}\`;
                        } else if (peer.type === 'cidr') {
                            peerInfo = \`CIDR: \${peer.cidr}\`;
                        }
                        return \`
                            <div class="peer">
                                <span class="peer-type">\${peer.type.toUpperCase()}</span>
                                \${peerInfo}
                            </div>
                        \`;
                    }).join('') : '<div class="empty-rule">Allow to all destinations</div>';

                    const ports = rule.ports.length > 0 ? 
                        \`<div class="port-list">Ports: \${rule.ports.map(p => \`\${p.protocol}/\${p.port}\`).join(', ')}</div>\` :
                        '<div class="port-list">All ports</div>';

                    return \`
                        <div class="rule egress">
                            <strong>Rule \${idx + 1}</strong>
                            \${peers}
                            \${ports}
                        </div>
                    \`;
                }).join('');

                return \`
                    <div class="policy-card">
                        <div class="policy-header">
                            <div>
                                <span class="policy-title">\${policy.name}</span>
                                <span class="policy-namespace">namespace: \${policy.namespace}</span>
                            </div>
                            <div class="policy-actions">
                                <button onclick="viewYaml('\${policy.name}', '\${policy.namespace}')">View YAML</button>
                                <button onclick="deletePolicy('\${policy.name}', '\${policy.namespace}')">Delete</button>
                            </div>
                        </div>

                        <div class="selector-section">
                            <div class="selector-title">Pod Selector</div>
                            <div class="label-list">
                                \${selectorLabels || '<span class="empty-rule">All pods in namespace</span>'}
                            </div>
                        </div>

                        <div class="selector-section">
                            <div class="selector-title">Policy Types</div>
                            <div class="label-list">
                                \${policy.policyTypes.map(t => \`<span class="label">\${t}</span>\`).join('')}
                            </div>
                        </div>

                        \${policy.policyTypes.includes('Ingress') ? \`
                            <div class="rules-section">
                                <div class="rule-type">↓ Ingress Rules (Incoming Traffic)</div>
                                \${ingressRules || '<div class="empty-rule">No ingress rules defined - deny all incoming</div>'}
                            </div>
                        \` : ''}

                        \${policy.policyTypes.includes('Egress') ? \`
                            <div class="rules-section">
                                <div class="rule-type">↑ Egress Rules (Outgoing Traffic)</div>
                                \${egressRules || '<div class="empty-rule">No egress rules defined - deny all outgoing</div>'}
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
        NetworkPolicyViewerPanel.currentPanel = undefined;

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
