import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';

interface AuditEvent {
    timestamp: string;
    level: string;
    stage: string;
    verb: string;
    user: string;
    resource: string;
    namespace?: string;
    name?: string;
    requestURI: string;
    sourceIPs: string[];
    userAgent: string;
    responseStatus?: number;
}

export class AuditLogViewer {
    private kc: k8s.KubeConfig;
    private panel: vscode.WebviewPanel | undefined;
    private events: AuditEvent[] = [];

    constructor(kc: k8s.KubeConfig) {
        this.kc = kc;
    }

    /**
     * Show audit log viewer panel
     */
    async showAuditLogViewer(): Promise<void> {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'clusterPilot.auditLogs',
            'Kubernetes Audit Logs',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getWebviewContent();

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(async (message: any) => {
            switch (message.command) {
                case 'refresh':
                    await this.loadAuditLogs();
                    break;
                case 'filter':
                    this.filterEvents(message.filters);
                    break;
                case 'export':
                    await this.exportLogs(message.format);
                    break;
                case 'clear':
                    this.events = [];
                    this.panel?.webview.postMessage({ command: 'updateEvents', events: [] });
                    break;
            }
        });

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });

        // Initial load
        await this.loadAuditLogs();
    }

    /**
     * Load audit logs from Kubernetes API server
     */
    private async loadAuditLogs(): Promise<void> {
        try {
            // Note: Kubernetes audit logs are typically not exposed via API
            // They're stored as files on the API server or sent to a backend
            // This implementation simulates reading from API server logs via kubectl
            
            let exec, util, execPromise;
            try {
                const childProcess = require('child_process');
                exec = childProcess.exec;
                util = require('util');
                execPromise = util.promisify(exec);
            } catch (requireError: any) {
                throw new Error(`Failed to load required modules: ${requireError.message}`);
            }

            // Try to get audit logs from API server pod logs
            const commands = [
                'kubectl logs -n kube-system -l component=kube-apiserver --tail=1000',
                'kubectl logs -n kube-system kube-apiserver --tail=1000',
            ];

            let logs = '';
            for (const command of commands) {
                try {
                    const { stdout } = await Promise.race([
                        execPromise(command),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Command timeout')), 10000)
                        )
                    ]);
                    if (stdout) {
                        logs = stdout;
                        break;
                    }
                } catch (error) {
                    // Try next command
                    continue;
                }
            }

            if (!logs) {
                vscode.window.showWarningMessage(
                    'Unable to retrieve audit logs. Audit logging may not be enabled or accessible.',
                    'Learn More'
                ).then(selection => {
                    if (selection === 'Learn More') {
                        vscode.env.openExternal(vscode.Uri.parse(
                            'https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/'
                        ));
                    }
                });
                
                // Show sample data for demonstration
                this.events = this.generateSampleAuditEvents();
            } else {
                this.events = this.parseAuditLogs(logs);
            }

            this.panel?.webview.postMessage({ 
                command: 'updateEvents', 
                events: this.events,
                stats: this.calculateStats(this.events)
            });

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to load audit logs: ${error.message}`);
            // Show sample data for demonstration
            this.events = this.generateSampleAuditEvents();
            this.panel?.webview.postMessage({ 
                command: 'updateEvents', 
                events: this.events,
                stats: this.calculateStats(this.events)
            });
        }
    }

    /**
     * Parse audit log lines into structured events
     */
    private parseAuditLogs(logs: string): AuditEvent[] {
        const events: AuditEvent[] = [];
        const lines = logs.split('\n');
        const maxEvents = 1000; // Prevent memory issues with huge log files

        for (const line of lines) {
            if (events.length >= maxEvents) {
                break;
            }
            try {
                // Audit logs are typically JSON
                if (line.trim().startsWith('{')) {
                    const event = JSON.parse(line);
                    if (event.kind === 'Event' && event.auditID) {
                        events.push({
                            timestamp: event.requestReceivedTimestamp || event.stageTimestamp,
                            level: event.level || 'Metadata',
                            stage: event.stage || 'ResponseComplete',
                            verb: event.verb || 'unknown',
                            user: event.user?.username || 'unknown',
                            resource: `${event.objectRef?.resource || 'unknown'}/${event.objectRef?.subresource || ''}`.replace(/\/$/, ''),
                            namespace: event.objectRef?.namespace,
                            name: event.objectRef?.name,
                            requestURI: event.requestURI || '',
                            sourceIPs: event.sourceIPs || [],
                            userAgent: event.userAgent || '',
                            responseStatus: event.responseStatus?.code
                        });
                    }
                }
            } catch (error) {
                // Skip malformed lines
                continue;
            }
        }

        return events;
    }

    /**
     * Generate sample audit events for demonstration
     */
    private generateSampleAuditEvents(): AuditEvent[] {
        const now = new Date();
        const verbs = ['get', 'list', 'create', 'update', 'patch', 'delete', 'watch'];
        const resources = ['pods', 'deployments', 'services', 'configmaps', 'secrets', 'nodes'];
        const users = ['system:admin', 'john@example.com', 'jane@example.com', 'system:serviceaccount:kube-system:default'];
        const namespaces = ['default', 'kube-system', 'production', 'staging'];
        const levels = ['Metadata', 'Request', 'RequestResponse'];
        const stages = ['ResponseComplete', 'ResponseStarted', 'RequestReceived'];

        const events: AuditEvent[] = [];
        const maxSampleEvents = 100;

        for (let i = 0; i < maxSampleEvents; i++) {
            const timestamp = new Date(now.getTime() - Math.random() * 3600000);
            events.push({
                timestamp: timestamp.toISOString(),
                level: levels[Math.floor(Math.random() * levels.length)],
                stage: stages[Math.floor(Math.random() * stages.length)],
                verb: verbs[Math.floor(Math.random() * verbs.length)],
                user: users[Math.floor(Math.random() * users.length)],
                resource: resources[Math.floor(Math.random() * resources.length)],
                namespace: Math.random() > 0.2 ? namespaces[Math.floor(Math.random() * namespaces.length)] : undefined,
                name: `resource-${Math.floor(Math.random() * 100)}`,
                requestURI: `/api/v1/namespaces/${namespaces[Math.floor(Math.random() * namespaces.length)]}/pods`,
                sourceIPs: [`192.168.1.${Math.floor(Math.random() * 255)}`],
                userAgent: 'kubectl/v1.28.0',
                responseStatus: Math.random() > 0.9 ? (Math.random() > 0.5 ? 403 : 404) : 200
            });
        }

        return events.sort((a, b) => 
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
    }

    /**
     * Filter events based on criteria
     */
    private filterEvents(filters: any): void {
        if (!filters || typeof filters !== 'object') {
            return;
        }

        let filtered = [...this.events];

        if (filters.user && typeof filters.user === 'string') {
            const sanitizedUser = filters.user.trim();
            if (sanitizedUser.length > 0 && sanitizedUser.length < 256) {
                filtered = filtered.filter(e => 
                    e.user.toLowerCase().includes(sanitizedUser.toLowerCase())
                );
            }
        }

        if (filters.verb && typeof filters.verb === 'string') {
            filtered = filtered.filter(e => e.verb === filters.verb);
        }

        if (filters.resource) {
            filtered = filtered.filter(e => 
                e.resource.toLowerCase().includes(filters.resource.toLowerCase())
            );
        }

        if (filters.namespace) {
            filtered = filtered.filter(e => e.namespace === filters.namespace);
        }

        if (filters.level) {
            filtered = filtered.filter(e => e.level === filters.level);
        }

        if (filters.statusCode) {
            const code = parseInt(filters.statusCode);
            filtered = filtered.filter(e => e.responseStatus === code);
        }

        this.panel?.webview.postMessage({ 
            command: 'updateEvents', 
            events: filtered,
            stats: this.calculateStats(filtered)
        });
    }

    /**
     * Calculate statistics
     */
    private calculateStats(events: AuditEvent[]): any {
        const uniqueUsers = new Set(events.map(e => e.user)).size;
        const uniqueResources = new Set(events.map(e => e.resource)).size;
        const errors = events.filter(e => e.responseStatus && e.responseStatus >= 400).length;
        const verbCounts: { [key: string]: number } = {};
        
        events.forEach(e => {
            verbCounts[e.verb] = (verbCounts[e.verb] || 0) + 1;
        });

        return {
            total: events.length,
            uniqueUsers,
            uniqueResources,
            errors,
            verbCounts
        };
    }

    /**
     * Export logs to file
     */
    private async exportLogs(format: 'json' | 'csv'): Promise<void> {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`audit-logs-${Date.now()}.${format}`),
            filters: format === 'json' 
                ? { 'JSON': ['json'] }
                : { 'CSV': ['csv'] }
        });

        if (!uri) {
            return;
        }

        try {
            const fs = require('fs');
            let content: string;

            if (format === 'json') {
                content = JSON.stringify(this.events, null, 2);
            } else {
                // CSV format
                const headers = 'Timestamp,Level,Stage,Verb,User,Resource,Namespace,Name,Status\n';
                const rows = this.events.map(e => 
                    `"${e.timestamp}","${e.level}","${e.stage}","${e.verb}","${e.user}","${e.resource}","${e.namespace || ''}","${e.name || ''}","${e.responseStatus || ''}"`
                ).join('\n');
                content = headers + rows;
            }

            fs.writeFileSync(uri.fsPath, content);
            vscode.window.showInformationMessage(`✅ Audit logs exported to ${uri.fsPath}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`❌ Export failed: ${error.message}`);
        }
    }

    /**
     * Get webview HTML content
     */
    private getWebviewContent(): string {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kubernetes Audit Logs</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .title {
            font-size: 24px;
            font-weight: bold;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .actions {
            display: flex;
            gap: 10px;
        }
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .secondary-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 15px;
        }
        .stat-label {
            font-size: 11px;
            opacity: 0.7;
            margin-bottom: 5px;
        }
        .stat-value {
            font-size: 24px;
            font-weight: bold;
        }
        .filters {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px;
            margin-bottom: 20px;
            padding: 15px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
        }
        .filters input, .filters select {
            width: 100%;
            padding: 6px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
        }
        .events-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        .events-table th {
            background: var(--vscode-editor-background);
            padding: 10px;
            text-align: left;
            border-bottom: 2px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
        }
        .events-table td {
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .events-table tr:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: bold;
        }
        .badge-success { background: #28a745; color: white; }
        .badge-error { background: #dc3545; color: white; }
        .badge-warning { background: #ffc107; color: black; }
        .verb-get { color: #28a745; }
        .verb-list { color: #17a2b8; }
        .verb-create { color: #007bff; }
        .verb-update { color: #ffc107; }
        .verb-patch { color: #fd7e14; }
        .verb-delete { color: #dc3545; }
        .empty-state {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title">📋 Kubernetes Audit Logs</div>
        <div class="actions">
            <button onclick="refresh()">🔄 Refresh</button>
            <button class="secondary-button" onclick="exportLogs('json')">📥 Export JSON</button>
            <button class="secondary-button" onclick="exportLogs('csv')">📥 Export CSV</button>
            <button class="secondary-button" onclick="clearLogs()">🗑️ Clear</button>
        </div>
    </div>

    <div class="stats" id="stats"></div>

    <div class="filters">
        <input type="text" id="userFilter" placeholder="Filter by user..." onchange="applyFilters()">
        <select id="verbFilter" onchange="applyFilters()">
            <option value="">All Verbs</option>
            <option value="get">GET</option>
            <option value="list">LIST</option>
            <option value="create">CREATE</option>
            <option value="update">UPDATE</option>
            <option value="patch">PATCH</option>
            <option value="delete">DELETE</option>
        </select>
        <input type="text" id="resourceFilter" placeholder="Filter by resource..." onchange="applyFilters()">
        <input type="text" id="namespaceFilter" placeholder="Filter by namespace..." onchange="applyFilters()">
        <select id="levelFilter" onchange="applyFilters()">
            <option value="">All Levels</option>
            <option value="Metadata">Metadata</option>
            <option value="Request">Request</option>
            <option value="RequestResponse">RequestResponse</option>
        </select>
        <input type="number" id="statusFilter" placeholder="Status code..." onchange="applyFilters()">
    </div>

    <div style="overflow-x: auto;">
        <table class="events-table">
            <thead>
                <tr>
                    <th>Timestamp</th>
                    <th>User</th>
                    <th>Verb</th>
                    <th>Resource</th>
                    <th>Namespace</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Source IP</th>
                </tr>
            </thead>
            <tbody id="eventsBody">
                <tr>
                    <td colspan="8">
                        <div class="empty-state">
                            <h3>Loading audit logs...</h3>
                            <p>Please wait while we fetch the data</p>
                        </div>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allEvents = [];

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function applyFilters() {
            const filters = {
                user: document.getElementById('userFilter').value,
                verb: document.getElementById('verbFilter').value,
                resource: document.getElementById('resourceFilter').value,
                namespace: document.getElementById('namespaceFilter').value,
                level: document.getElementById('levelFilter').value,
                statusCode: document.getElementById('statusFilter').value
            };
            vscode.postMessage({ command: 'filter', filters });
        }

        function exportLogs(format) {
            vscode.postMessage({ command: 'export', format });
        }

        function clearLogs() {
            vscode.postMessage({ command: 'clear' });
        }

        function formatTimestamp(ts) {
            const date = new Date(ts);
            return date.toLocaleString();
        }

        function getVerbClass(verb) {
            return 'verb-' + verb.toLowerCase();
        }

        function getStatusBadge(status) {
            if (!status) return '';
            if (status >= 200 && status < 300) {
                return \`<span class="badge badge-success">\${status}</span>\`;
            } else if (status >= 400) {
                return \`<span class="badge badge-error">\${status}</span>\`;
            }
            return \`<span class="badge badge-warning">\${status}</span>\`;
        }

        function renderStats(stats) {
            if (!stats) return;
            
            document.getElementById('stats').innerHTML = \`
                <div class="stat-card">
                    <div class="stat-label">Total Events</div>
                    <div class="stat-value">\${stats.total}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Unique Users</div>
                    <div class="stat-value">\${stats.uniqueUsers}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Unique Resources</div>
                    <div class="stat-value">\${stats.uniqueResources}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Errors</div>
                    <div class="stat-value">\${stats.errors}</div>
                </div>
            \`;
        }

        function renderEvents(events) {
            const tbody = document.getElementById('eventsBody');
            
            if (events.length === 0) {
                tbody.innerHTML = \`
                    <tr>
                        <td colspan="8">
                            <div class="empty-state">
                                <h3>No audit events found</h3>
                                <p>Try adjusting your filters or refresh the logs</p>
                            </div>
                        </td>
                    </tr>
                \`;
                return;
            }

            tbody.innerHTML = events.map(event => \`
                <tr>
                    <td>\${formatTimestamp(event.timestamp)}</td>
                    <td title="\${event.user}">\${event.user.substring(0, 30)}</td>
                    <td class="\${getVerbClass(event.verb)}">\${event.verb.toUpperCase()}</td>
                    <td>\${event.resource}</td>
                    <td>\${event.namespace || '-'}</td>
                    <td>\${event.name || '-'}</td>
                    <td>\${getStatusBadge(event.responseStatus)}</td>
                    <td>\${event.sourceIPs[0] || '-'}</td>
                </tr>
            \`).join('');
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateEvents') {
                allEvents = message.events;
                renderEvents(message.events);
                renderStats(message.stats);
            }
        });

        // Initial refresh
        refresh();
    </script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
        this.events = [];
    }
}
