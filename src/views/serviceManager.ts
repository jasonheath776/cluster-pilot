import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

interface ServiceInfo {
    name: string;
    namespace: string;
    type: string;
    clusterIP: string;
    externalIPs: string[];
    loadBalancerIP?: string;
    ports: Array<{
        name?: string;
        protocol: string;
        port: number;
        targetPort: string | number;
        nodePort?: number;
    }>;
    selector: { [key: string]: string };
    endpoints: Array<{
        ip: string;
        hostname?: string;
        nodeName?: string;
        ready: boolean;
        ports: Array<{
            name?: string;
            port: number;
            protocol: string;
        }>;
    }>;
    sessionAffinity: string;
    externalName?: string;
    ingressHostnames: string[];
}

export class ServiceManagerPanel {
    public static currentPanel: ServiceManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ServiceManagerPanel.currentPanel) {
            ServiceManagerPanel.currentPanel.panel.reveal(column);
            ServiceManagerPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'serviceManager',
            'Service Management',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        ServiceManagerPanel.currentPanel = new ServiceManagerPanel(panel, extensionUri, k8sClient);
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
                        await this.deleteService(message.name, message.namespace);
                        break;
                    case 'viewYaml':
                        await this.viewYaml(message.name, message.namespace);
                        break;
                    case 'viewPods':
                        await this.viewPods(message.selector, message.namespace);
                        break;
                    case 'createTemplate':
                        await this.createTemplate(message.type);
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
        }, 10000); // Refresh every 10 seconds
    }

    private async refresh() {
        try {
            const services = await this.k8sClient.getServices();
            const ingresses = await this.k8sClient.getIngresses();
            const serviceInfos: ServiceInfo[] = [];

            for (const svc of services) {
                const namespace = svc.metadata?.namespace || 'default';
                const name = svc.metadata?.name || 'unknown';

                // Get endpoints
                const endpoints = await this.k8sClient.getEndpoints(name, namespace);
                const endpointAddresses: ServiceInfo['endpoints'] = [];

                if (endpoints) {
                    for (const subset of endpoints.subsets || []) {
                        // Ready endpoints
                        for (const addr of subset.addresses || []) {
                            endpointAddresses.push({
                                ip: addr.ip || 'unknown',
                                hostname: addr.hostname,
                                nodeName: addr.nodeName,
                                ready: true,
                                ports: (subset.ports || []).map(p => ({
                                    name: p.name,
                                    port: p.port || 0,
                                    protocol: p.protocol || 'TCP'
                                }))
                            });
                        }
                        // Not ready endpoints
                        for (const addr of subset.notReadyAddresses || []) {
                            endpointAddresses.push({
                                ip: addr.ip || 'unknown',
                                hostname: addr.hostname,
                                nodeName: addr.nodeName,
                                ready: false,
                                ports: (subset.ports || []).map(p => ({
                                    name: p.name,
                                    port: p.port || 0,
                                    protocol: p.protocol || 'TCP'
                                }))
                            });
                        }
                    }
                }

                // Find ingresses that use this service
                const ingressHostnames: string[] = [];
                for (const ingress of ingresses) {
                    if (ingress.metadata?.namespace !== namespace) {
                        continue;
                    }
                    for (const rule of ingress.spec?.rules || []) {
                        for (const path of rule.http?.paths || []) {
                            if (path.backend?.service?.name === name) {
                                if (rule.host) {
                                    ingressHostnames.push(rule.host);
                                }
                            }
                        }
                    }
                }

                const ports = (svc.spec?.ports || []).map(p => ({
                    name: p.name,
                    protocol: p.protocol || 'TCP',
                    port: p.port || 0,
                    targetPort: p.targetPort || p.port || 0,
                    nodePort: p.nodePort
                }));

                serviceInfos.push({
                    name,
                    namespace,
                    type: svc.spec?.type || 'ClusterIP',
                    clusterIP: svc.spec?.clusterIP || 'None',
                    externalIPs: svc.spec?.externalIPs || [],
                    loadBalancerIP: svc.status?.loadBalancer?.ingress?.[0]?.ip,
                    ports,
                    selector: svc.spec?.selector || {},
                    endpoints: endpointAddresses,
                    sessionAffinity: svc.spec?.sessionAffinity || 'None',
                    externalName: svc.spec?.externalName,
                    ingressHostnames
                });
            }

            this.panel.webview.postMessage({
                command: 'updateData',
                services: serviceInfos
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh services: ${error}`);
        }
    }

    private async deleteService(name: string, namespace: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete Service "${name}" in namespace "${namespace}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            await this.k8sClient.deleteService(name, namespace);
            vscode.window.showInformationMessage(`Service ${name} deleted`);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete service: ${error}`);
        }
    }

    private async viewYaml(name: string, namespace: string) {
        try {
            const services = await this.k8sClient.getServices(namespace);
            const svc = services.find(s => s.metadata?.name === name);

            if (!svc) {
                vscode.window.showErrorMessage(`Service ${name} not found`);
                return;
            }

            const yaml = JSON.stringify(svc, null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: yaml,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view service: ${error}`);
        }
    }

    private async viewPods(selector: { [key: string]: string }, namespace: string) {
        try {
            const pods = await this.k8sClient.getPods(namespace);
            const matchingPods = pods.filter(pod => {
                const labels = pod.metadata?.labels || {};
                return Object.entries(selector).every(([key, value]) => labels[key] === value);
            });

            if (matchingPods.length === 0) {
                vscode.window.showInformationMessage('No pods found matching selector');
                return;
            }

            const podInfo = matchingPods.map(pod => {
                const status = pod.status?.phase || 'Unknown';
                const ready = pod.status?.containerStatuses?.every(c => c.ready) ? '✓' : '✗';
                const ip = pod.status?.podIP || 'N/A';
                return `${ready} ${pod.metadata?.name} - ${status} (${ip})`;
            }).join('\n');

            const doc = await vscode.workspace.openTextDocument({
                content: `Pods matching selector:\n${JSON.stringify(selector, null, 2)}\n\n${podInfo}`,
                language: 'plaintext'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view pods: ${error}`);
        }
    }

    private async createTemplate(type: string) {
        let template = '';

        switch (type) {
            case 'ClusterIP':
                template = `apiVersion: v1
kind: Service
metadata:
  name: example-service
  namespace: default
spec:
  type: ClusterIP
  selector:
    app: example
  ports:
  - name: http
    protocol: TCP
    port: 80
    targetPort: 8080
  sessionAffinity: None`;
                break;

            case 'NodePort':
                template = `apiVersion: v1
kind: Service
metadata:
  name: example-nodeport
  namespace: default
spec:
  type: NodePort
  selector:
    app: example
  ports:
  - name: http
    protocol: TCP
    port: 80
    targetPort: 8080
    nodePort: 30080  # Optional: 30000-32767
  sessionAffinity: None`;
                break;

            case 'LoadBalancer':
                template = `apiVersion: v1
kind: Service
metadata:
  name: example-loadbalancer
  namespace: default
  annotations:
    # Cloud provider specific annotations
    service.beta.kubernetes.io/aws-load-balancer-type: nlb
spec:
  type: LoadBalancer
  selector:
    app: example
  ports:
  - name: http
    protocol: TCP
    port: 80
    targetPort: 8080
  sessionAffinity: None
  # externalTrafficPolicy: Local  # Preserve source IP`;
                break;

            case 'Headless':
                template = `apiVersion: v1
kind: Service
metadata:
  name: example-headless
  namespace: default
spec:
  clusterIP: None  # Makes this a headless service
  selector:
    app: example
  ports:
  - name: http
    protocol: TCP
    port: 80
    targetPort: 8080`;
                break;

            case 'ExternalName':
                template = `apiVersion: v1
kind: Service
metadata:
  name: example-external
  namespace: default
spec:
  type: ExternalName
  externalName: external-service.example.com
  ports:
  - name: http
    protocol: TCP
    port: 80`;
                break;

            default:
                template = `# Unknown service type`;
        }

        const doc = await vscode.workspace.openTextDocument({
            content: template,
            language: 'yaml'
        });
        await vscode.window.showTextDocument(doc);
    }

    private async testEndpoint(url: string) {
        try {
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
    <title>Service Management</title>
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
        .dropdown {
            position: relative;
            display: inline-block;
        }
        .dropdown-content {
            display: none;
            position: absolute;
            background-color: var(--vscode-dropdown-background);
            min-width: 160px;
            box-shadow: 0px 8px 16px 0px rgba(0,0,0,0.2);
            z-index: 1;
            border: 1px solid var(--vscode-dropdown-border);
        }
        .dropdown-content button {
            width: 100%;
            text-align: left;
            padding: 12px 16px;
            display: block;
        }
        .dropdown:hover .dropdown-content {
            display: block;
        }
        .service-card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
            border-left: 4px solid var(--vscode-charts-green);
        }
        .service-card.loadbalancer {
            border-left-color: var(--vscode-charts-blue);
        }
        .service-card.nodeport {
            border-left-color: var(--vscode-charts-orange);
        }
        .service-card.externalname {
            border-left-color: var(--vscode-charts-purple);
        }
        .service-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .service-title {
            font-size: 18px;
            font-weight: bold;
        }
        .service-namespace {
            font-size: 12px;
            opacity: 0.8;
            margin-left: 10px;
        }
        .service-actions {
            display: flex;
            gap: 5px;
        }
        .service-actions button {
            padding: 4px 8px;
            font-size: 12px;
        }
        .type-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
            margin-left: 10px;
        }
        .type-clusterip {
            background-color: var(--vscode-charts-green);
            color: white;
        }
        .type-nodeport {
            background-color: var(--vscode-charts-orange);
            color: white;
        }
        .type-loadbalancer {
            background-color: var(--vscode-charts-blue);
            color: white;
        }
        .type-externalname {
            background-color: var(--vscode-charts-purple);
            color: white;
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
        .ports-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 10px;
            margin: 10px 0;
        }
        .port-box {
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .port-name {
            font-weight: bold;
            margin-bottom: 5px;
        }
        .endpoints {
            background-color: var(--vscode-editor-background);
            padding: 15px;
            border-radius: 3px;
            margin: 10px 0;
        }
        .endpoint {
            display: flex;
            align-items: center;
            padding: 8px;
            margin: 5px 0;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .endpoint.ready {
            border-left: 3px solid var(--vscode-charts-green);
        }
        .endpoint.not-ready {
            border-left: 3px solid var(--vscode-charts-red);
            opacity: 0.6;
        }
        .endpoint-status {
            width: 20px;
            margin-right: 10px;
        }
        .endpoint-ip {
            flex: 1;
            font-weight: bold;
        }
        .endpoint-node {
            opacity: 0.8;
            font-size: 11px;
        }
        .selector {
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .selector-tag {
            display: inline-block;
            padding: 4px 8px;
            margin: 3px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-size: 11px;
        }
        .ingress-links {
            margin-top: 10px;
        }
        .ingress-link {
            display: inline-block;
            padding: 4px 8px;
            margin: 3px;
            background-color: var(--vscode-charts-blue);
            color: white;
            border-radius: 3px;
            font-size: 11px;
            cursor: pointer;
            text-decoration: none;
        }
        .ingress-link:hover {
            opacity: 0.8;
        }
        .ip-display {
            font-family: var(--vscode-editor-font-family);
            font-size: 14px;
            font-weight: bold;
        }
        .no-services {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
        .endpoint-count {
            display: inline-block;
            padding: 2px 6px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-size: 10px;
            margin-left: 5px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Service Management</h1>
        <div class="actions">
            <div class="dropdown">
                <button>Create Template ▾</button>
                <div class="dropdown-content">
                    <button onclick="createTemplate('ClusterIP')">ClusterIP</button>
                    <button onclick="createTemplate('NodePort')">NodePort</button>
                    <button onclick="createTemplate('LoadBalancer')">LoadBalancer</button>
                    <button onclick="createTemplate('Headless')">Headless</button>
                    <button onclick="createTemplate('ExternalName')">ExternalName</button>
                </div>
            </div>
            <button onclick="refresh()">Refresh</button>
        </div>
    </div>

    <div id="servicesContainer">
        <div class="no-services">Loading services...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function deleteService(name, namespace) {
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

        function viewPods(selector, namespace) {
            vscode.postMessage({
                command: 'viewPods',
                selector: selector,
                namespace: namespace
            });
        }

        function createTemplate(type) {
            vscode.postMessage({
                command: 'createTemplate',
                type: type
            });
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
                renderServices(message.services);
            }
        });

        function renderServices(services) {
            const container = document.getElementById('servicesContainer');
            
            if (services.length === 0) {
                container.innerHTML = '<div class="no-services">No services found</div>';
                return;
            }

            container.innerHTML = services.map(svc => {
                const typeClass = svc.type.toLowerCase().replace(/\\s+/g, '');
                
                const portsHtml = svc.ports.map(port => {
                    const nodePortInfo = port.nodePort ? \`NodePort: \${port.nodePort}\` : '';
                    return \`
                        <div class="port-box">
                            <div class="port-name">\${port.name || 'unnamed'}</div>
                            <div>\${port.port} → \${port.targetPort}</div>
                            <div>\${port.protocol}</div>
                            \${nodePortInfo ? \`<div>\${nodePortInfo}</div>\` : ''}
                        </div>
                    \`;
                }).join('');

                const readyEndpoints = svc.endpoints.filter(e => e.ready).length;
                const totalEndpoints = svc.endpoints.length;
                const endpointCountBadge = totalEndpoints > 0 ? 
                    \`<span class="endpoint-count">\${readyEndpoints}/\${totalEndpoints} ready</span>\` : '';

                const endpointsHtml = svc.endpoints.length > 0 ? \`
                    <div class="info-section">
                        <div class="info-label">Endpoints \${endpointCountBadge}</div>
                        <div class="endpoints">
                            \${svc.endpoints.map(ep => \`
                                <div class="endpoint \${ep.ready ? 'ready' : 'not-ready'}">
                                    <div class="endpoint-status">\${ep.ready ? '✓' : '✗'}</div>
                                    <div class="endpoint-ip">\${ep.ip}\${ep.hostname ? ' (' + ep.hostname + ')' : ''}</div>
                                    \${ep.nodeName ? \`<div class="endpoint-node">Node: \${ep.nodeName}</div>\` : ''}
                                </div>
                            \`).join('')}
                        </div>
                    </div>
                \` : '<div class="info-section"><div class="info-label">No Endpoints</div></div>';

                const selectorTags = Object.entries(svc.selector).map(([key, value]) => 
                    \`<span class="selector-tag">\${key}=\${value}</span>\`
                ).join('');

                const selectorHtml = Object.keys(svc.selector).length > 0 ? \`
                    <div class="info-section">
                        <div class="info-label">Selector</div>
                        <div class="selector">
                            \${selectorTags}
                            <button onclick='viewPods(\${JSON.stringify(svc.selector)}, "\${svc.namespace}")' 
                                    style="margin-left: 10px; padding: 4px 8px; font-size: 11px;">
                                View Pods
                            </button>
                        </div>
                    </div>
                \` : '';

                const ingressHtml = svc.ingressHostnames.length > 0 ? \`
                    <div class="info-section">
                        <div class="info-label">Exposed via Ingress</div>
                        <div class="ingress-links">
                            \${svc.ingressHostnames.map(host => 
                                \`<a class="ingress-link" onclick="testEndpoint('https://\${host}')">\${host}</a>\`
                            ).join('')}
                        </div>
                    </div>
                \` : '';

                let ipInfo = '';
                if (svc.type === 'LoadBalancer' && svc.loadBalancerIP) {
                    ipInfo = \`<div>Load Balancer IP: <span class="ip-display">\${svc.loadBalancerIP}</span></div>\`;
                } else if (svc.type === 'ExternalName') {
                    ipInfo = \`<div>External Name: <span class="ip-display">\${svc.externalName}</span></div>\`;
                } else if (svc.clusterIP !== 'None') {
                    ipInfo = \`<div>Cluster IP: <span class="ip-display">\${svc.clusterIP}</span></div>\`;
                } else {
                    ipInfo = '<div>Cluster IP: <span class="ip-display">None (Headless)</span></div>';
                }

                const externalIPsHtml = svc.externalIPs.length > 0 ? 
                    \`<div>External IPs: <span class="ip-display">\${svc.externalIPs.join(', ')}</span></div>\` : '';

                return \`
                    <div class="service-card \${typeClass}">
                        <div class="service-header">
                            <div>
                                <span class="service-title">\${svc.name}</span>
                                <span class="service-namespace">namespace: \${svc.namespace}</span>
                                <span class="type-badge type-\${typeClass}">\${svc.type}</span>
                            </div>
                            <div class="service-actions">
                                <button onclick="viewYaml('\${svc.name}', '\${svc.namespace}')">View YAML</button>
                                <button onclick="deleteService('\${svc.name}', '\${svc.namespace}')">Delete</button>
                            </div>
                        </div>

                        \${ipInfo}
                        \${externalIPsHtml}
                        <div>Session Affinity: \${svc.sessionAffinity}</div>

                        <div class="info-section">
                            <div class="info-label">Ports</div>
                            <div class="ports-grid">
                                \${portsHtml}
                            </div>
                        </div>

                        \${endpointsHtml}
                        \${selectorHtml}
                        \${ingressHtml}
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
        ServiceManagerPanel.currentPanel = undefined;

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
