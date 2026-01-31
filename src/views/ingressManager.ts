import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

interface IngressInfo {
    name: string;
    namespace: string;
    className?: string;
    hosts: Array<{
        host: string;
        paths: Array<{
            path: string;
            pathType: string;
            backend: string;
        }>;
    }>;
    tlsHosts: string[];
    tlsSecrets: string[];
    certificateExpiry?: { [host: string]: { expiry: string; daysRemaining: number; status: 'valid' | 'expiring' | 'expired' } };
    rules: number;
    loadBalancerIP?: string;
    annotations: { [key: string]: string };
}

export class IngressManagerPanel {
    public static currentPanel: IngressManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (IngressManagerPanel.currentPanel) {
            IngressManagerPanel.currentPanel.panel.reveal(column);
            IngressManagerPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ingressManager',
            'Ingress Management',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        IngressManagerPanel.currentPanel = new IngressManagerPanel(panel, extensionUri, k8sClient);
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
                        await this.deleteIngress(message.name, message.namespace);
                        break;
                    case 'viewYaml':
                        await this.viewYaml(message.name, message.namespace);
                        break;
                    case 'viewCertificate':
                        await this.viewCertificate(message.secretName, message.namespace);
                        break;
                    case 'createTemplate':
                        await this.createTemplate();
                        break;
                    case 'testEndpoint':
                        await this.testEndpoint(message.url);
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
        }, 30000); // Refresh every 30 seconds
    }

    private async refresh() {
        try {
            const ingresses = await this.k8sClient.getIngresses();
            const ingressInfos: IngressInfo[] = [];

            for (const ingress of ingresses) {
                const hosts: Array<{ host: string; paths: Array<{ path: string; pathType: string; backend: string }> }> = [];
                const tlsHosts: string[] = [];
                const tlsSecrets: string[] = [];
                const certificateExpiry: { [host: string]: { expiry: string; daysRemaining: number; status: 'valid' | 'expiring' | 'expired' } } = {};

                // Parse rules
                for (const rule of ingress.spec?.rules || []) {
                    const host = rule.host || '*';
                    const paths: Array<{ path: string; pathType: string; backend: string }> = [];

                    for (const path of rule.http?.paths || []) {
                        let backend = 'unknown';
                        if (path.backend?.service) {
                            backend = `${path.backend.service.name}:${path.backend.service.port?.number || path.backend.service.port?.name || 'unknown'}`;
                        }
                        paths.push({
                            path: path.path || '/',
                            pathType: path.pathType || 'Prefix',
                            backend
                        });
                    }

                    hosts.push({ host, paths });
                }

                // Parse TLS
                for (const tls of ingress.spec?.tls || []) {
                    if (tls.secretName) {
                        tlsSecrets.push(tls.secretName);
                    }
                    for (const host of tls.hosts || []) {
                        tlsHosts.push(host);
                    }
                }

                // Get certificate expiry information
                for (const secretName of tlsSecrets) {
                    try {
                        const secret = await this.k8sClient.getSecret(secretName, ingress.metadata?.namespace || 'default');
                        if (secret?.data?.['tls.crt']) {
                            const certInfo = this.parseCertificate(secret.data['tls.crt']);
                            if (certInfo) {
                                // Associate with hosts
                                const hostsForSecret = ingress.spec?.tls?.find(t => t.secretName === secretName)?.hosts || [];
                                for (const host of hostsForSecret) {
                                    certificateExpiry[host] = certInfo;
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`Failed to get certificate for secret ${secretName}:`, error);
                    }
                }

                const loadBalancerIP = ingress.status?.loadBalancer?.ingress?.[0]?.ip;

                ingressInfos.push({
                    name: ingress.metadata?.name || 'unknown',
                    namespace: ingress.metadata?.namespace || 'default',
                    className: ingress.spec?.ingressClassName,
                    hosts,
                    tlsHosts,
                    tlsSecrets,
                    certificateExpiry,
                    rules: ingress.spec?.rules?.length || 0,
                    loadBalancerIP,
                    annotations: ingress.metadata?.annotations || {}
                });
            }

            this.panel.webview.postMessage({
                command: 'updateData',
                ingresses: ingressInfos
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh ingresses: ${error}`);
        }
    }

    private parseCertificate(base64Cert: string): { expiry: string; daysRemaining: number; status: 'valid' | 'expiring' | 'expired' } | null {
        try {
            // Decode base64
            const certPem = Buffer.from(base64Cert, 'base64').toString('utf-8');
            
            // Extract expiry date using regex (basic parsing)
            // In a real implementation, you'd use a proper x509 parser
            const notAfterMatch = certPem.match(/Not After : (.+)/);
            if (!notAfterMatch) {
                // Try to find the validity period in the certificate
                // This is a simplified approach - in production, use a proper certificate parser
                return null;
            }

            const expiryDate = new Date(notAfterMatch[1]);
            const now = new Date();
            const daysRemaining = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

            let status: 'valid' | 'expiring' | 'expired' = 'valid';
            if (daysRemaining < 0) {
                status = 'expired';
            } else if (daysRemaining < 30) {
                status = 'expiring';
            }

            return {
                expiry: expiryDate.toISOString(),
                daysRemaining,
                status
            };
        } catch (error) {
            console.error('Failed to parse certificate:', error);
            return null;
        }
    }

    private async deleteIngress(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete Ingress "${name}" in namespace "${namespace}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            await this.k8sClient.deleteIngress(name, namespace);
            vscode.window.showInformationMessage(`Ingress ${name} deleted`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete ingress: ${error}`);
        }
    }

    private async viewYaml(name: string, namespace: string) {
        try {
            const ingresses = await this.k8sClient.getIngresses(namespace);
            const ingress = ingresses.find(i => i.metadata?.name === name);

            if (!ingress) {
                vscode.window.showErrorMessage(`Ingress ${name} not found`);
                return;
            }

            const yaml = JSON.stringify(ingress, null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: yaml,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view ingress: ${error}`);
        }
    }

    private async viewCertificate(secretName: string, namespace: string) {
        try {
            const secret = await this.k8sClient.getSecret(secretName, namespace);

            if (!secret) {
                vscode.window.showErrorMessage(`Secret ${secretName} not found`);
                return;
            }

            let content = `Certificate Secret: ${secretName}\nNamespace: ${namespace}\n\n`;

            if (secret.data?.['tls.crt']) {
                const certPem = Buffer.from(secret.data['tls.crt'], 'base64').toString('utf-8');
                content += `TLS Certificate:\n${certPem}\n\n`;
            }

            if (secret.data?.['tls.key']) {
                content += `TLS Key: [REDACTED]\n`;
            }

            const doc = await vscode.workspace.openTextDocument({
                content,
                language: 'plaintext'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view certificate: ${error}`);
        }
    }

    private async createTemplate() {
        const template = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example-ingress
  namespace: default
  annotations:
    # NGINX Ingress Controller annotations
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    # cert-manager annotation for automatic certificate provisioning
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - example.com
    - www.example.com
    secretName: example-tls
  rules:
  - host: example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: example-service
            port:
              number: 80
  - host: www.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: example-service
            port:
              number: 80
---
# Optional: ClusterIssuer for cert-manager
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx`;

        const doc = await vscode.workspace.openTextDocument({
            content: template,
            language: 'yaml'
        });
        await vscode.window.showTextDocument(doc);
    }

    private async testEndpoint(url: string) {
        try {
            vscode.window.showInformationMessage(`Testing endpoint: ${url}`);
            // Open in browser
            await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open endpoint: ${error}`);
        }
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ingress Management</title>
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
        .ingress-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-charts-blue);
        }
        .ingress-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .ingress-title {
            font-size: 18px;
            font-weight: bold;
        }
        .ingress-namespace {
            font-size: 12px;
            opacity: 0.8;
            margin-left: 10px;
        }
        .ingress-actions {
            display: flex;
            gap: 5px;
        }
        .ingress-actions button {
            padding: 4px 8px;
            font-size: 12px;
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
        .hosts-list {
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-radius: 3px;
            margin: 5px 0;
        }
        .host-entry {
            padding: 8px;
            margin: 5px 0;
            border-left: 3px solid var(--vscode-charts-green);
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        .host-name {
            font-weight: bold;
            font-size: 14px;
            margin-bottom: 5px;
        }
        .host-name.tls {
            color: var(--vscode-charts-green);
        }
        .host-name.tls::before {
            content: "🔒 ";
        }
        .path-entry {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            padding: 3px 0;
            margin-left: 15px;
        }
        .path-type {
            display: inline-block;
            padding: 2px 6px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-size: 10px;
            margin: 0 5px;
        }
        .backend {
            color: var(--vscode-charts-blue);
        }
        .cert-info {
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-radius: 3px;
            margin: 10px 0;
        }
        .cert-entry {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px;
            margin: 5px 0;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 3px;
        }
        .cert-status {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
        }
        .cert-status.valid {
            background-color: var(--vscode-charts-green);
            color: white;
        }
        .cert-status.expiring {
            background-color: var(--vscode-charts-orange);
            color: white;
        }
        .cert-status.expired {
            background-color: var(--vscode-charts-red);
            color: white;
        }
        .cert-details {
            font-size: 11px;
            opacity: 0.9;
        }
        .cert-secret {
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
            cursor: pointer;
            color: var(--vscode-textLink-foreground);
            text-decoration: underline;
        }
        .annotations {
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-radius: 3px;
            margin: 10px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
        }
        .annotation-entry {
            padding: 3px 0;
            word-break: break-all;
        }
        .annotation-key {
            color: var(--vscode-charts-purple);
            font-weight: 600;
        }
        .lb-ip {
            display: inline-block;
            padding: 4px 8px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .no-ingresses {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
        .test-button {
            background-color: var(--vscode-charts-green);
            margin-left: 5px;
            padding: 2px 6px;
            font-size: 10px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Ingress Management</h1>
        <div class="actions">
            <button onclick="createTemplate()">Create Ingress Template</button>
            <button onclick="refresh()">Refresh</button>
        </div>
    </div>

    <div id="ingressContainer">
        <div class="no-ingresses">Loading ingresses...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function deleteIngress(name, namespace) {
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

        function viewCertificate(secretName, namespace) {
            vscode.postMessage({
                command: 'viewCertificate',
                secretName: secretName,
                namespace: namespace
            });
        }

        function createTemplate() {
            vscode.postMessage({ command: 'createTemplate' });
        }

        function testEndpoint(url) {
            vscode.postMessage({
                command: 'testEndpoint',
                url: url
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateData') {
                renderIngresses(message.ingresses);
            }
        });

        function renderIngresses(ingresses) {
            const container = document.getElementById('ingressContainer');
            
            if (ingresses.length === 0) {
                container.innerHTML = '<div class="no-ingresses">No ingresses found</div>';
                return;
            }

            container.innerHTML = ingresses.map(ingress => {
                const hostsHtml = ingress.hosts.map(host => {
                    const isTLS = ingress.tlsHosts.includes(host.host);
                    const pathsHtml = host.paths.map(path => \`
                        <div class="path-entry">
                            <span>\${path.path}</span>
                            <span class="path-type">\${path.pathType}</span>
                            → <span class="backend">\${path.backend}</span>
                            <button class="test-button" onclick="testEndpoint('http\${isTLS ? 's' : ''}://\${host.host}\${path.path}')">Test</button>
                        </div>
                    \`).join('');

                    return \`
                        <div class="host-entry">
                            <div class="host-name \${isTLS ? 'tls' : ''}">\${host.host}</div>
                            \${pathsHtml}
                        </div>
                    \`;
                }).join('');

                let certHtml = '';
                if (ingress.tlsSecrets.length > 0) {
                    const certEntries = Object.entries(ingress.certificateExpiry || {}).map(([host, info]) => {
                        let statusClass = info.status;
                        let statusText = info.status.toUpperCase();
                        if (info.status === 'expiring') {
                            statusText += \` (\${info.daysRemaining}d left)\`;
                        } else if (info.status === 'expired') {
                            statusText += \` (\${Math.abs(info.daysRemaining)}d ago)\`;
                        }

                        return \`
                            <div class="cert-entry">
                                <div>
                                    <strong>\${host}</strong>
                                    <div class="cert-details">Expires: \${new Date(info.expiry).toLocaleDateString()}</div>
                                </div>
                                <div class="cert-status \${statusClass}">\${statusText}</div>
                            </div>
                        \`;
                    }).join('');

                    const secretLinks = ingress.tlsSecrets.map(secret => 
                        \`<span class="cert-secret" onclick="viewCertificate('\${secret}', '\${ingress.namespace}')">\${secret}</span>\`
                    ).join(', ');

                    certHtml = \`
                        <div class="info-section">
                            <div class="info-label">TLS Certificates</div>
                            <div class="cert-info">
                                <div style="margin-bottom: 10px;">Secrets: \${secretLinks}</div>
                                \${certEntries}
                            </div>
                        </div>
                    \`;
                }

                const annotationsHtml = Object.keys(ingress.annotations).length > 0 ? \`
                    <div class="info-section">
                        <div class="info-label">Annotations</div>
                        <div class="annotations">
                            \${Object.entries(ingress.annotations).map(([key, value]) => \`
                                <div class="annotation-entry">
                                    <span class="annotation-key">\${key}:</span> \${value}
                                </div>
                            \`).join('')}
                        </div>
                    </div>
                \` : '';

                const classInfo = ingress.className ? \`<div>Class: <strong>\${ingress.className}</strong></div>\` : '';
                const lbInfo = ingress.loadBalancerIP ? 
                    \`<div>Load Balancer: <span class="lb-ip">\${ingress.loadBalancerIP}</span></div>\` : '';

                return \`
                    <div class="ingress-card">
                        <div class="ingress-header">
                            <div>
                                <span class="ingress-title">\${ingress.name}</span>
                                <span class="ingress-namespace">namespace: \${ingress.namespace}</span>
                            </div>
                            <div class="ingress-actions">
                                <button onclick="viewYaml('\${ingress.name}', '\${ingress.namespace}')">View YAML</button>
                                <button onclick="deleteIngress('\${ingress.name}', '\${ingress.namespace}')">Delete</button>
                            </div>
                        </div>

                        \${classInfo}
                        \${lbInfo}

                        <div class="info-section">
                            <div class="info-label">Routes (\${ingress.rules} rules)</div>
                            <div class="hosts-list">
                                \${hostsHtml}
                            </div>
                        </div>

                        \${certHtml}
                        \${annotationsHtml}
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
        IngressManagerPanel.currentPanel = undefined;

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
