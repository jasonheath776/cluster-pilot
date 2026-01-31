import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';
import * as k8s from '@kubernetes/client-node';
import { isClusterMetricsEnabled } from '../commands';
import { DisposablePanel, safeClearInterval } from '../utils/disposable';
import { logger } from '../utils/logger';

export class ResourceDetailsPanel extends DisposablePanel {
    private static currentPanel: ResourceDetailsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private events: k8s.CoreV1Event[] = [];
    private relatedResources: Array<{ type?: string; kind?: string; name?: string }> = [];
    private podMetrics: k8s.PodMetric | undefined;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
        private resource: k8s.KubernetesObject,
        private resourceKind: string,
        private k8sClient: K8sClient
    ) {
        super();
        this.panel = panel;
        this.registerDisposable(this.panel);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        
        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this.disposables
        );
        
        this.loadResourceData();
    }

    public static show(
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        resource: k8s.KubernetesObject,
        resourceKind: string,
        k8sClient: K8sClient
    ): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // Reuse existing panel if available
        if (ResourceDetailsPanel.currentPanel) {
            ResourceDetailsPanel.currentPanel.resource = resource;
            ResourceDetailsPanel.currentPanel.resourceKind = resourceKind;
            ResourceDetailsPanel.currentPanel.k8sClient = k8sClient;
            ResourceDetailsPanel.currentPanel.panel.reveal(column);
            ResourceDetailsPanel.currentPanel.loadResourceData();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'resourceDetails',
            `Resource Details`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        ResourceDetailsPanel.currentPanel = new ResourceDetailsPanel(
            panel,
            extensionUri,
            context,
            resource,
            resourceKind,
            k8sClient
        );
    }

    private async loadResourceData(): Promise<void> {
        // Fetch events for this resource
        await this.fetchEvents();
        
        // Fetch related resources
        await this.fetchRelatedResources();
        
        // Fetch metrics for pods if enabled
        const currentContext = this.k8sClient.getKubeConfig().getCurrentContext();
        if (this.resourceKind === 'pod' && currentContext && isClusterMetricsEnabled(this.context, currentContext)) {
            await this.fetchPodMetrics();
        }
        
        // Update the view
        this.update();
        
        // Start auto-refresh (every 5 seconds)
        this.startAutoRefresh();
    }

    private async fetchEvents(): Promise<void> {
        try {
            const namespace = this.resource.metadata?.namespace;
            const name = this.resource.metadata?.name;
            
            if (namespace && name) {
                // Get events related to this resource
                const allEvents = await this.k8sClient.getEvents(namespace);
                this.events = allEvents
                    .filter((event: k8s.CoreV1Event) => 
                        event.involvedObject?.name === name &&
                        event.involvedObject?.kind === this.resourceKind
                    )
                    .sort((a: k8s.CoreV1Event, b: k8s.CoreV1Event) => 
                        new Date(b.lastTimestamp || b.firstTimestamp || 0).getTime() - 
                        new Date(a.lastTimestamp || a.firstTimestamp || 0).getTime()
                    )
                    .slice(0, 10); // Keep only the 10 most recent events
            }
        } catch (error: unknown) {
            logger.error('Failed to fetch events', error);
            this.events = [];
        }
    }

    private async fetchRelatedResources(): Promise<void> {
        try {
            this.relatedResources = [];
            const metadata = this.resource.metadata;
            
            if (this.resourceKind === 'pod') {
                // Find owner (Deployment, ReplicaSet, etc.)
                const ownerRefs = metadata?.ownerReferences || [];
                for (const owner of ownerRefs) {
                    this.relatedResources.push({
                        type: 'Owner',
                        kind: owner.kind,
                        name: owner.name
                    });
                }
                
                // Find service that selects this pod
                const services = await this.k8sClient.getServices(metadata?.namespace);
                const podLabels = metadata?.labels || {};
                for (const service of services) {
                    const selector = service.spec?.selector || {};
                    const matches = Object.keys(selector).every(
                        key => podLabels[key] === selector[key]
                    );
                    if (matches) {
                        this.relatedResources.push({
                            type: 'Service',
                            kind: 'Service',
                            name: service.metadata?.name
                        });
                    }
                }
            } else if (this.resourceKind === 'deployment') {
                // Find replica sets
                const replicaSets = await this.k8sClient.getReplicaSets(metadata?.namespace);
                const deploymentName = metadata?.name;
                for (const rs of replicaSets) {
                    const ownerRefs = rs.metadata?.ownerReferences || [];
                    if (ownerRefs.some((ref: k8s.V1OwnerReference) => ref.name === deploymentName && ref.kind === 'Deployment')) {
                        this.relatedResources.push({
                            type: 'ReplicaSet',
                            kind: 'ReplicaSet',
                            name: rs.metadata?.name
                        });
                    }
                }
            }
        } catch (error: unknown) {
            logger.error('Failed to fetch related resources', error);
        }
    }

    private async fetchPodMetrics(): Promise<void> {
        try {
            const namespace = this.resource.metadata?.namespace;
            if (namespace) {
                const metrics = await this.k8sClient.getPodMetrics(namespace);
                this.podMetrics = metrics.find(
                    (m: k8s.PodMetric) => m.metadata?.name === this.resource.metadata?.name
                );
            }
        } catch (error: unknown) {
            logger.error('Failed to fetch pod metrics', error);
            this.podMetrics = undefined;
        }
    }

    private update(): void {
        const webview = this.panel.webview;
        this.panel.title = `${this.resourceKind}: ${this.resource.metadata?.name || 'Unknown'}`;
        this.panel.webview.html = this.getHtmlContent(webview);
    }

    private startAutoRefresh(): void {
        // Setup auto-refresh using base class method (handles cleanup automatically)
        this.setupAutoRefresh(async () => {
            // Refresh the resource data
            await this.refreshResourceData();
            await this.fetchEvents();
            
            // Fetch metrics if enabled for this cluster
            const currentContext = this.k8sClient.getKubeConfig().getCurrentContext();
            if (this.resourceKind === 'pod' && currentContext && isClusterMetricsEnabled(this.context, currentContext)) {
                await this.fetchPodMetrics();
            }
            this.update();
        }, 5000);
    }

    private async refreshResourceData(): Promise<void> {
        try {
            const namespace = this.resource.metadata?.namespace;
            const name = this.resource.metadata?.name;
            
            if (!name) { return; }
            
            // Fetch fresh resource data based on kind
            switch (this.resourceKind.toLowerCase()) {
                case 'pod': {
                    const pods = await this.k8sClient.getPods(namespace);
                    const pod = pods.find(p => p.metadata?.name === name);
                    if (pod) { this.resource = pod; }
                    break;
                }
                case 'deployment': {
                    const deployments = await this.k8sClient.getDeployments(namespace);
                    const deployment = deployments.find(d => d.metadata?.name === name);
                    if (deployment) { this.resource = deployment; }
                    break;
                }
                case 'statefulset': {
                    const statefulSets = await this.k8sClient.getStatefulSets(namespace);
                    const statefulSet = statefulSets.find(s => s.metadata?.name === name);
                    if (statefulSet) { this.resource = statefulSet; }
                    break;
                }
                case 'daemonset': {
                    const daemonSets = await this.k8sClient.getDaemonSets(namespace);
                    const daemonSet = daemonSets.find(d => d.metadata?.name === name);
                    if (daemonSet) { this.resource = daemonSet; }
                    break;
                }
                case 'service': {
                    const services = await this.k8sClient.getServices(namespace);
                    const service = services.find(s => s.metadata?.name === name);
                    if (service) { this.resource = service; }
                    break;
                }
                case 'configmap': {
                    const configMaps = await this.k8sClient.getConfigMaps(namespace);
                    const configMap = configMaps.find(c => c.metadata?.name === name);
                    if (configMap) { this.resource = configMap; }
                    break;
                }
                case 'secret': {
                    const secrets = await this.k8sClient.getSecrets(namespace);
                    const secret = secrets.find(s => s.metadata?.name === name);
                    if (secret) { this.resource = secret; }
                    break;
                }
            }
        } catch (error: unknown) {
            logger.error('Failed to refresh resource', error);
        }
    }

    private async handleMessage(message: { command: string; [key: string]: unknown }): Promise<void> {
        switch (message.command) {
            case 'delete':
                await this.deleteResource();
                break;
            case 'restart':
                await this.restartResource();
                break;
            case 'scale':
                await this.scaleResource(message.replicas as number);
                break;
            case 'viewLogs':
                await this.viewLogs(message.container as string | undefined);
                break;
            case 'copy':
                vscode.env.clipboard.writeText(message.text as string);
                vscode.window.showInformationMessage('Copied to clipboard');
                break;
            case 'refresh':
                await this.refreshResourceData();
                await this.fetchEvents();
                this.update();
                break;
        }
    }

    private async deleteResource(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete ${this.resourceKind} "${this.resource.metadata?.name}"?`,
            { modal: true },
            'Delete'
        );
        
        if (confirm === 'Delete') {
            try {
                await this.k8sClient.deleteResource(
                    this.resourceKind,
                    this.resource.metadata?.name || '',
                    this.resource.metadata?.namespace
                );
                vscode.window.showInformationMessage(`${this.resourceKind} deleted successfully`);
                this.panel.dispose();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete: ${error}`);
            }
        }
    }

    private async restartResource(): Promise<void> {
        if (this.resourceKind === 'pod') {
            // For pods, restarting means deleting (will be recreated by owner)
            const confirm = await vscode.window.showWarningMessage(
                `Restart pod "${this.resource.metadata?.name}"? This will delete the pod and it will be recreated by its controller.`,
                { modal: true },
                'Restart'
            );
            
            if (confirm === 'Restart') {
                try {
                    await this.k8sClient.deleteResource(
                        this.resourceKind,
                        this.resource.metadata?.name || '',
                        this.resource.metadata?.namespace || ''
                    );
                    vscode.window.showInformationMessage('Pod restart initiated - it will be recreated shortly');
                    // Don't dispose panel, let auto-refresh show the new pod
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to restart pod: ${error}`);
                }
            }
        } else if (this.resourceKind === 'deployment') {
            const confirm = await vscode.window.showWarningMessage(
                `Restart deployment "${this.resource.metadata?.name}"? This will trigger a rolling restart of all pods.`,
                { modal: true },
                'Restart'
            );
            
            if (confirm === 'Restart') {
                try {
                    await this.k8sClient.restartDeployment(
                        this.resource.metadata?.name || '',
                        this.resource.metadata?.namespace || ''
                    );
                    vscode.window.showInformationMessage('Deployment restart initiated');
                    await this.refreshResourceData();
                    this.update();
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to restart deployment: ${error}`);
                }
            }
        } else if (this.resourceKind === 'statefulset') {
            const confirm = await vscode.window.showWarningMessage(
                `Restart statefulset "${this.resource.metadata?.name}"? This will trigger a rolling restart of all pods.`,
                { modal: true },
                'Restart'
            );
            
            if (confirm === 'Restart') {
                try {
                    await this.k8sClient.restartStatefulSet(
                        this.resource.metadata?.name || '',
                        this.resource.metadata?.namespace || ''
                    );
                    vscode.window.showInformationMessage('StatefulSet restart initiated');
                    await this.refreshResourceData();
                    this.update();
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to restart statefulset: ${error}`);
                }
            }
        } else if (this.resourceKind === 'daemonset') {
            const confirm = await vscode.window.showWarningMessage(
                `Restart daemonset "${this.resource.metadata?.name}"? This will trigger a rolling restart of all pods.`,
                { modal: true },
                'Restart'
            );
            
            if (confirm === 'Restart') {
                try {
                    await this.k8sClient.restartDaemonSet(
                        this.resource.metadata?.name || '',
                        this.resource.metadata?.namespace || ''
                    );
                    vscode.window.showInformationMessage('DaemonSet restart initiated');
                    await this.refreshResourceData();
                    this.update();
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to restart daemonset: ${error}`);
                }
            }
        }
    }

    private async scaleResource(replicas: number): Promise<void> {
        if (isNaN(replicas) || replicas < 0) {
            vscode.window.showErrorMessage('Invalid replica count');
            return;
        }
        
        try {
            const resourceType = this.resourceKind.toLowerCase();
            const name = this.resource.metadata?.name;
            const namespace = this.resource.metadata?.namespace;
            
            if (resourceType === 'deployment') {
                await this.k8sClient.scaleDeployment(name || '', namespace || '', replicas);
            } else if (resourceType === 'statefulset') {
                await this.k8sClient.scaleStatefulSet(name || '', namespace || '', replicas);
            } else if (resourceType === 'replicaset') {
                await this.k8sClient.scaleReplicaSet(name || '', namespace || '', replicas);
            } else {
                vscode.window.showErrorMessage(`Scaling not supported for ${this.resourceKind}`);
                return;
            }
            
            vscode.window.showInformationMessage(`Scaled to ${replicas} replicas`);
            await this.refreshResourceData();
            this.update();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to scale: ${error}`);
        }
    }

    private async viewLogs(container?: string): Promise<void> {
        try {
            const logs = await this.k8sClient.getLogs(
                this.resource.metadata?.namespace || '',
                this.resource.metadata?.name || '',
                container,
                1000
            );
            
            const doc = await vscode.workspace.openTextDocument({
                content: logs,
                language: 'log'
            });
            
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to fetch logs: ${error}`);
        }
    }

    public dispose(): void {
        ResourceDetailsPanel.currentPanel = undefined;
        
        // Call parent dispose to handle cleanup
        super.dispose();
    }

    private getHtmlContent(_webview: vscode.Webview): string {
        const metadata = this.resource.metadata || {};
        const spec = (this.resource as any).spec || {};
        const status = (this.resource as any).status || {};

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http: https:;">
    <title>${this.resourceKind} Details</title>
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
            line-height: 1.6;
        }

        .header {
            border-bottom: 2px solid var(--vscode-panel-border);
            padding-bottom: 16px;
            margin-bottom: 24px;
        }

        .header h1 {
            font-size: 24px;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .header .resource-type {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 14px;
            font-weight: normal;
        }

        .metadata {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-left: 3px solid var(--vscode-activityBarBadge-background);
            padding: 12px 16px;
            margin-bottom: 20px;
            border-radius: 4px;
        }

        .metadata-item {
            display: flex;
            margin-bottom: 8px;
        }

        .metadata-item:last-child {
            margin-bottom: 0;
        }

        .metadata-label {
            font-weight: 600;
            width: 150px;
            color: var(--vscode-textLink-foreground);
        }

        .metadata-value {
            flex: 1;
            font-family: var(--vscode-editor-font-family);
        }

        .section {
            margin-bottom: 24px;
        }

        .section h2 {
            font-size: 18px;
            margin-bottom: 12px;
            color: var(--vscode-textLink-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
        }

        .card {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 12px;
        }

        .card h3 {
            font-size: 16px;
            margin-bottom: 12px;
            color: var(--vscode-foreground);
        }

        .key-value {
            display: flex;
            padding: 6px 0;
            border-bottom: 1px solid var(--vscode-widget-border);
        }

        .key-value:last-child {
            border-bottom: none;
        }

        .key {
            font-weight: 600;
            width: 200px;
            color: var(--vscode-symbolIcon-variableForeground);
            flex-shrink: 0;
            padding-right: 12px;
        }

        .value {
            flex: 1;
            font-family: var(--vscode-editor-font-family);
            word-break: break-word;
            overflow-wrap: break-word;
        }

        .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
        }

        .status-running {
            background: #28a745;
            color: white;
        }

        .status-pending {
            background: #ffc107;
            color: black;
        }

        .status-failed {
            background: #dc3545;
            color: white;
        }

        .status-succeeded {
            background: #17a2b8;
            color: white;
        }

        .label-tag {
            display: inline-block;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            padding: 2px 8px;
            margin: 2px 4px 2px 0;
            border-radius: 3px;
            font-size: 12px;
        }

        .containers-list {
            list-style: none;
        }

        .container-item {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 8px;
        }

        .container-name {
            font-weight: 600;
            font-size: 14px;
            margin-bottom: 8px;
            color: var(--vscode-textLink-foreground);
        }

        .env-vars {
            margin-top: 8px;
        }

        .env-var {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            padding: 2px 0;
        }

        .table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 8px;
        }

        .table th {
            background: var(--vscode-editor-inactiveSelectionBackground);
            padding: 8px;
            text-align: left;
            border: 1px solid var(--vscode-panel-border);
        }

        .table td {
            padding: 8px;
            border: 1px solid var(--vscode-panel-border);
        }

        code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }

        .action-bar {
            display: flex;
            gap: 8px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }

        .action-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .action-button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .action-button:active {
            transform: scale(0.95);
        }

        @keyframes buttonPress {
            0% { transform: scale(1); }
            50% { transform: scale(0.92); }
            100% { transform: scale(1); }
        }

        .action-button.pressed {
            animation: buttonPress 0.3s ease-out;
        }

        .action-button.danger {
            background: var(--vscode-errorForeground);
            color: white;
        }

        .action-button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .refresh-indicator {
            display: inline-block;
            margin-left: 8px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        .copy-btn {
            background: transparent;
            border: 1px solid var(--vscode-button-border);
            color: var(--vscode-foreground);
            padding: 2px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            margin-left: 8px;
        }

        .copy-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .copy-btn:active {
            transform: scale(0.9);
        }

        .copy-btn.pressed {
            animation: buttonPress 0.3s ease-out;
        }

        .events-timeline {
            margin-top: 12px;
        }

        .event-item {
            border-left: 3px solid var(--vscode-panel-border);
            padding: 8px 12px;
            margin-bottom: 8px;
            background: var(--vscode-input-background);
        }

        .event-item.warning {
            border-left-color: #ffc107;
        }

        .event-item.error {
            border-left-color: #dc3545;
        }

        .event-item.normal {
            border-left-color: #28a745;
        }

        .event-time {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .event-message {
            margin-top: 4px;
            font-size: 13px;
        }

        .related-resources {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .related-item {
            background: var(--vscode-input-background);
            padding: 8px 12px;
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .health-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 16px;
        }

        .health-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            display: inline-block;
        }

        .health-dot.healthy {
            background: #28a745;
            box-shadow: 0 0 8px #28a745;
        }

        .health-dot.warning {
            background: #ffc107;
            box-shadow: 0 0 8px #ffc107;
        }

        .health-dot.error {
            background: #dc3545;
            box-shadow: 0 0 8px #dc3545;
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
    <div class="header">
        <h1>
            ${this.escapeHtml(metadata.name || 'Unknown')}
            <span class="resource-type">${this.escapeHtml(this.resourceKind)}</span>
            <span class="refresh-indicator">🔄 Auto-refreshing every 5s</span>
        </h1>
    </div>

    ${this.renderHealthIndicator()}
    ${this.renderActionBar()}

    <div class="metadata">
        ${metadata.namespace ? `<div class="metadata-item"><span class="metadata-label">Namespace:</span><span class="metadata-value">${this.escapeHtml(metadata.namespace)}</span></div>` : ''}
        ${metadata.uid ? `<div class="metadata-item"><span class="metadata-label">UID:</span><span class="metadata-value"><code>${this.escapeHtml(metadata.uid)}</code></span></div>` : ''}
        ${metadata.creationTimestamp ? `<div class="metadata-item"><span class="metadata-label">Created:</span><span class="metadata-value">${new Date(metadata.creationTimestamp).toLocaleString()}</span></div>` : ''}
        ${metadata.resourceVersion ? `<div class="metadata-item"><span class="metadata-label">Resource Version:</span><span class="metadata-value">${this.escapeHtml(metadata.resourceVersion)}</span></div>` : ''}
    </div>

    ${this.renderLabelsAndAnnotations(metadata)}
    ${this.renderMetrics()}
    ${this.renderStatus(status, this.resourceKind)}
    ${this.renderSpec(spec, this.resourceKind)}
    ${this.renderConditions(status)}
    ${this.renderRelatedResources()}
    ${this.renderEvents()}

    <script>
        const vscode = acquireVsCodeApi();
        
        // Add animation to button on click
        document.addEventListener('click', function(e) {
            const target = e.target;
            if (target.classList.contains('action-button') || target.classList.contains('copy-btn')) {
                target.classList.add('pressed');
                setTimeout(() => target.classList.remove('pressed'), 300);
            }
        });
        
        function sendCommand(command, data = {}) {
            vscode.postMessage({ command, ...data });
        }
        
        function copyText(text) {
            vscode.postMessage({ command: 'copy', text });
        }
    </script>
</body>
</html>`;
    }

    private renderLabelsAndAnnotations(metadata: k8s.V1ObjectMeta | undefined): string {
        const labels = metadata?.labels || {};
        const annotations = metadata?.annotations || {};

        if (Object.keys(labels).length === 0 && Object.keys(annotations).length === 0) {
            return '';
        }

        return `
            <div class="section">
                ${Object.keys(labels).length > 0 ? `
                    <h2>Labels</h2>
                    <div class="card">
                        ${Object.entries(labels).map(([key, value]) => 
                            `<span class="label-tag">${this.escapeHtml(key)}: ${this.escapeHtml(String(value))}</span>`
                        ).join('')}
                    </div>
                ` : ''}
                
                ${Object.keys(annotations).length > 0 ? `
                    <h2>Annotations</h2>
                    <div class="card">
                        ${Object.entries(annotations).map(([key, value]) => 
                            `<div class="key-value">
                                <span class="key">${this.escapeHtml(key)}</span>
                                <span class="value">${this.linkifyUrlsAndIps(String(value))}</span>
                            </div>`
                        ).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }

    private renderMetrics(): string {
        if (this.resourceKind !== 'pod' || !this.podMetrics) {
            return '';
        }

        const containers = this.podMetrics.containers || [];
        if (containers.length === 0) {
            return '';
        }

        let totalCpu = 0;
        let totalMemory = 0;

        containers.forEach(container => {
            totalCpu += this.parseCpuToNumber(container.usage?.cpu || '0');
            totalMemory += this.parseMemoryToBytes(container.usage?.memory || '0');
        });

        return `
            <div class="section">
                <h2>📊 Resource Metrics</h2>
                <div class="card">
                    <div class="key-value">
                        <span class="key">Total CPU Usage</span>
                        <span class="value"><strong>${this.formatCpu(totalCpu)}</strong></span>
                    </div>
                    <div class="key-value">
                        <span class="key">Total Memory Usage</span>
                        <span class="value"><strong>${this.formatMemory(totalMemory)}</strong></span>
                    </div>
                    <h3 style="margin-top: 16px; margin-bottom: 8px;">Container Metrics</h3>
                    ${containers.map(container => {
                        const cpu = this.parseCpuToNumber(container.usage?.cpu || '0');
                        const memory = this.parseMemoryToBytes(container.usage?.memory || '0');
                        return `
                            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--vscode-widget-border);">
                                <div style="font-weight: 600; margin-bottom: 8px;">📦 ${this.escapeHtml(container.name)}</div>
                                <div class="key-value">
                                    <span class="key">CPU</span>
                                    <span class="value">${this.formatCpu(cpu)}</span>
                                </div>
                                <div class="key-value">
                                    <span class="key">Memory</span>
                                    <span class="value">${this.formatMemory(memory)}</span>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    private parseCpuToNumber(cpu: string): number {
        if (!cpu) { return 0; }
        if (cpu.endsWith('n')) { return parseFloat(cpu) / 1000000000; }
        if (cpu.endsWith('u')) { return parseFloat(cpu) / 1000000; }
        if (cpu.endsWith('m')) { return parseFloat(cpu) / 1000; }
        return parseFloat(cpu);
    }

    private parseMemoryToBytes(memory: string): number {
        if (!memory) { return 0; }
        const units: { [key: string]: number } = {
            Ki: 1024,
            Mi: 1024 * 1024,
            Gi: 1024 * 1024 * 1024,
            Ti: 1024 * 1024 * 1024 * 1024,
            KB: 1024,
            MB: 1024 * 1024,
            GB: 1024 * 1024 * 1024,
            TB: 1024 * 1024 * 1024 * 1024
        };
        
        for (const [suffix, multiplier] of Object.entries(units)) {
            if (memory.endsWith(suffix)) {
                return parseFloat(memory) * multiplier;
            }
        }
        return parseFloat(memory);
    }

    private formatCpu(cores: number): string {
        if (cores < 0.001) { return (cores * 1000000).toFixed(0) + 'µ cores'; }
        if (cores < 1) { return (cores * 1000).toFixed(0) + 'm cores'; }
        return cores.toFixed(2) + ' cores';
    }

    private formatMemory(bytes: number): string {
        if (bytes === 0) { return '0 B'; }
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
    }

    private renderStatus(status: any, kind: string): string {
        if (!status || Object.keys(status).length === 0) {
            return '';
        }

        let statusHtml = '<div class="section"><h2>Status</h2><div class="card">';

        if (kind === 'pod') {
            const phase = status.phase || 'Unknown';
            const statusClass = phase === 'Running' ? 'status-running' : 
                              phase === 'Pending' ? 'status-pending' :
                              phase === 'Failed' ? 'status-failed' :
                              phase === 'Succeeded' ? 'status-succeeded' : '';
            
            statusHtml += `
                <div class="key-value">
                    <span class="key">Phase</span>
                    <span class="value"><span class="status-badge ${statusClass}">${this.escapeHtml(phase)}</span></span>
                </div>
                ${status.podIP ? `<div class="key-value"><span class="key">Pod IP</span><span class="value"><code>${this.linkifyUrlsAndIps(status.podIP)}</code></span></div>` : ''}
                ${status.hostIP ? `<div class="key-value"><span class="key">Host IP</span><span class="value"><code>${this.linkifyUrlsAndIps(status.hostIP)}</code></span></div>` : ''}
                ${status.startTime ? `<div class="key-value"><span class="key">Start Time</span><span class="value">${new Date(status.startTime).toLocaleString()}</span></div>` : ''}
            `;
        } else if (kind === 'deployment') {
            statusHtml += `
                <div class="key-value"><span class="key">Replicas</span><span class="value">${status.replicas || 0}</span></div>
                <div class="key-value"><span class="key">Available Replicas</span><span class="value">${status.availableReplicas || 0}</span></div>
                <div class="key-value"><span class="key">Ready Replicas</span><span class="value">${status.readyReplicas || 0}</span></div>
                <div class="key-value"><span class="key">Updated Replicas</span><span class="value">${status.updatedReplicas || 0}</span></div>
            `;
        } else if (kind === 'service') {
            statusHtml += `
                ${status.loadBalancer?.ingress ? `
                    <div class="key-value">
                        <span class="key">Load Balancer</span>
                        <span class="value">${(status.loadBalancer.ingress as any[]).map((ing: any) => 
                            this.linkifyUrlsAndIps(ing.ip || ing.hostname)
                        ).join(', ')}</span>
                    </div>
                ` : ''}
            `;
        }

        statusHtml += '</div></div>';
        return statusHtml;
    }

    private renderSpec(spec: any, kind: string): string {
        if (!spec || Object.keys(spec).length === 0) {
            return '';
        }

        let specHtml = '<div class="section"><h2>Specification</h2>';

        if (kind === 'pod' && spec.containers) {
            specHtml += '<h3>Containers</h3><ul class="containers-list">';
            spec.containers.forEach((container: k8s.V1Container) => {
                specHtml += `
                    <li class="container-item">
                        <div class="container-name">📦 ${this.escapeHtml(container.name)}</div>
                        <div class="key-value">
                            <span class="key">Image</span>
                            <span class="value"><code>${this.escapeHtml(container.image || '')}</code></span>
                        </div>
                        ${container.imagePullPolicy ? `
                            <div class="key-value">
                                <span class="key">Pull Policy</span>
                                <span class="value">${this.escapeHtml(container.imagePullPolicy)}</span>
                            </div>
                        ` : ''}
                        ${container.ports && container.ports.length > 0 ? `
                            <div class="key-value">
                                <span class="key">Ports</span>
                                <span class="value">${container.ports.map((p: k8s.V1ContainerPort) => 
                                    `${p.containerPort}${p.protocol ? `/${p.protocol}` : ''}${p.name ? ` (${p.name})` : ''}`
                                ).join(', ')}</span>
                            </div>
                        ` : ''}
                        ${container.env && container.env.length > 0 ? `
                            <div class="env-vars">
                                <strong>Environment Variables:</strong>
                                ${container.env.map((e: k8s.V1EnvVar) => 
                                    `<div class="env-var"><code>${this.escapeHtml(e.name)}</code> = ${this.escapeHtml(e.value || '(from secret/configmap)')}</div>`
                                ).join('')}
                            </div>
                        ` : ''}
                    </li>
                `;
            });
            specHtml += '</ul>';
        } else if (kind === 'deployment') {
            specHtml += `
                <div class="card">
                    <div class="key-value"><span class="key">Replicas</span><span class="value">${spec.replicas || 1}</span></div>
                    ${spec.strategy?.type ? `<div class="key-value"><span class="key">Strategy</span><span class="value">${this.escapeHtml(spec.strategy.type)}</span></div>` : ''}
                    ${spec.selector?.matchLabels ? `
                        <div class="key-value">
                            <span class="key">Selector</span>
                            <span class="value">
                                ${Object.entries(spec.selector.matchLabels).map(([k, v]) => 
                                    `<span class="label-tag">${this.escapeHtml(k)}: ${this.escapeHtml(String(v))}</span>`
                                ).join('')}
                            </span>
                        </div>
                    ` : ''}
                </div>
            `;
        } else if (kind === 'service') {
            specHtml += `
                <div class="card">
                    <div class="key-value"><span class="key">Type</span><span class="value">${this.escapeHtml(spec.type || 'ClusterIP')}</span></div>
                    ${spec.clusterIP ? `<div class="key-value"><span class="key">Cluster IP</span><span class="value"><code>${this.linkifyUrlsAndIps(spec.clusterIP)}</code></span></div>` : ''}
                    ${spec.ports && spec.ports.length > 0 ? `
                        <div class="key-value">
                            <span class="key">Ports</span>
                            <span class="value">
                                <table class="table">
                                    <thead>
                                        <tr>
                                            <th>Name</th>
                                            <th>Protocol</th>
                                            <th>Port</th>
                                            <th>Target Port</th>
                                            <th>Node Port</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${spec.ports.map((p: k8s.V1ServicePort) => `
                                            <tr>
                                                <td>${this.escapeHtml(p.name || '-')}</td>
                                                <td>${this.escapeHtml(p.protocol || 'TCP')}</td>
                                                <td>${p.port}</td>
                                                <td>${p.targetPort || '-'}</td>
                                                <td>${p.nodePort || '-'}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </span>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        specHtml += '</div>';
        return specHtml;
    }

    private renderConditions(status: any): string {
        if (!status?.conditions || status.conditions.length === 0) {
            return '';
        }

        return `
            <div class="section">
                <h2>Conditions</h2>
                <table class="table">
                    <thead>
                        <tr>
                            <th>Type</th>
                            <th>Status</th>
                            <th>Last Transition</th>
                            <th>Reason</th>
                            <th>Message</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${status.conditions.map((cond: any) => `
                            <tr>
                                <td>${this.escapeHtml(cond.type)}</td>
                                <td><span class="status-badge ${cond.status === 'True' ? 'status-running' : 'status-pending'}">${this.escapeHtml(cond.status)}</span></td>
                                <td>${cond.lastTransitionTime ? new Date(cond.lastTransitionTime).toLocaleString() : '-'}</td>
                                <td>${this.escapeHtml(cond.reason || '-')}</td>
                                <td>${this.escapeHtml(cond.message || '-')}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    private renderEvents(): string {
        if (this.events.length === 0) {
            return '';
        }

        return `
            <div class="section">
                <h2>Recent Events</h2>
                <div class="events-timeline">
                    ${this.events.map((event: k8s.CoreV1Event) => {
                        const eventType = event.type?.toLowerCase() || 'normal';
                        const eventClass = eventType === 'warning' ? 'warning' : eventType === 'error' ? 'error' : 'normal';
                        const time = new Date(event.lastTimestamp || event.firstTimestamp || Date.now()).toLocaleString();
                        const count = (event.count || 0) > 1 ? ` (${event.count}x)` : '';
                        
                        return `
                            <div class="event-item ${eventClass}">
                                <div class="event-time">${time}${count} - ${this.escapeHtml(event.reason || 'Unknown')}</div>
                                <div class="event-message">${this.escapeHtml(event.message || 'No message')}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    private renderHealthIndicator(): string {
        const status = (this.resource as any).status || {};
        let health = 'unknown';
        let healthText = 'Unknown';
        
        if (this.resourceKind === 'pod') {
            const phase = status.phase;
            if (phase === 'Running') {
                const conditions = status.conditions || [];
                const ready = conditions.find((c: any) => c.type === 'Ready');
                if (ready?.status === 'True') {
                    health = 'healthy';
                    healthText = 'Healthy - Running';
                } else {
                    health = 'warning';
                    healthText = 'Running but not ready';
                }
            } else if (phase === 'Pending') {
                health = 'warning';
                healthText = 'Pending';
            } else if (phase === 'Failed' || phase === 'CrashLoopBackOff') {
                health = 'error';
                healthText = `Failed - ${phase}`;
            } else if (phase === 'Succeeded') {
                health = 'healthy';
                healthText = 'Completed';
            }
        } else if (this.resourceKind === 'deployment') {
            const desired = status.replicas || 0;
            const available = status.availableReplicas || 0;
            if (available === desired && desired > 0) {
                health = 'healthy';
                healthText = `Healthy - ${available}/${desired} replicas ready`;
            } else if (available > 0) {
                health = 'warning';
                healthText = `Degraded - ${available}/${desired} replicas ready`;
            } else {
                health = 'error';
                healthText = `Unhealthy - 0/${desired} replicas ready`;
            }
        }
        
        return `
            <div class="health-indicator">
                <span class="health-dot ${health} pulse"></span>
                <strong>Health:</strong> ${healthText}
            </div>
        `;
    }

    private renderActionBar(): string {
        const actions = [];
        
        // Refresh button
        actions.push(`
            <button class="action-button secondary" onclick="sendCommand('refresh')">
                🔄 Refresh
            </button>
        `);
        
        // Resource-specific actions
        if (this.resourceKind === 'pod') {
            const containers = (this.resource as any).spec?.containers || [];
            if (containers.length > 0) {
                const containerName = this.escapeHtml(containers[0].name);
                actions.push(`
                    <button class="action-button" onclick="sendCommand('viewLogs', { container: '${containerName}' })">
                        📋 View Logs
                    </button>
                `);
            }
            
            actions.push(`
                <button class="action-button danger" onclick="sendCommand('restart')">
                    ⚡ Restart Pod
                </button>
            `);
        }
        
        if (this.resourceKind === 'deployment') {
            const currentReplicas = (this.resource as any).spec?.replicas || 1;
            actions.push(`
                <button class="action-button" onclick="var r = prompt('Enter number of replicas:', '${currentReplicas}'); if (r) sendCommand('scale', { replicas: parseInt(r) });">
                    📊 Scale
                </button>
            `);
            
            actions.push(`
                <button class="action-button" onclick="sendCommand('restart')">
                    🔄 Restart Deployment
                </button>
            `);
        }
        
        if (this.resourceKind === 'statefulset') {
            const currentReplicas = (this.resource as any).spec?.replicas || 1;
            actions.push(`
                <button class="action-button" onclick="var r = prompt('Enter number of replicas:', '${currentReplicas}'); if (r) sendCommand('scale', { replicas: parseInt(r) });">
                    📊 Scale
                </button>
            `);
            
            actions.push(`
                <button class="action-button" onclick="sendCommand('restart')">
                    🔄 Restart StatefulSet
                </button>
            `);
        }
        
        if (this.resourceKind === 'daemonset') {
            actions.push(`
                <button class="action-button" onclick="sendCommand('restart')">
                    🔄 Restart DaemonSet
                </button>
            `);
        }
        
        // Delete button (always available)
        actions.push(`
            <button class="action-button danger" onclick="
                if (confirm('Are you sure you want to delete this ${this.resourceKind}?')) {
                    sendCommand('delete');
                }
            ">
                🗑️ Delete
            </button>
        `);
        
        return `
            <div class="action-bar">
                ${actions.join('')}
            </div>
        `;
    }

    private renderRelatedResources(): string {
        if (this.relatedResources.length === 0) {
            return '';
        }
        
        return `
            <div class="section">
                <h2>Related Resources</h2>
                <div class="related-resources">
                    ${this.relatedResources.map(rel => `
                        <div class="related-item">
                            <span>
                                <strong>${this.escapeHtml(rel.type || '')}:</strong> 
                                ${this.escapeHtml(rel.kind || '')} / ${this.escapeHtml(rel.name || '')}
                            </span>
                            <button class="copy-btn" onclick="copyText('${this.escapeHtml(rel.name || '')}')">
                                Copy
                            </button>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            '\'': '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    private linkifyUrlsAndIps(text: string): string {
        const escaped = this.escapeHtml(text);
        
        // Combined pattern that handles URLs and standalone IPs
        // First match URLs (which may contain IPs), then match standalone IPs
        let result = escaped;
        
        // Linkify URLs first (including URLs with IP addresses)
        const urlPattern = /(https?:\/\/[^\s<>"]+)/gi;
        result = result.replace(urlPattern, '<a href="$1" style="color: var(--vscode-textLink-foreground); text-decoration: underline;">$1</a>');
        
        // Then linkify standalone IPs that are NOT already inside anchor tags
        // Use negative lookbehind and lookahead to avoid matching IPs inside URLs
        const ipPattern = /(?<!["'>])\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![:\/\d])/g;
        result = result.replace(ipPattern, (match) => {
            // Only linkify if not already in an anchor tag
            return `<a href="http://${match}" style="color: var(--vscode-textLink-foreground); text-decoration: underline;">${match}</a>`;
        });
        
        return result;
    }
}
