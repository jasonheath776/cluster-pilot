import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';
import * as k8s from '@kubernetes/client-node';

interface EventWithAge extends k8s.CoreV1Event {
    age?: string;
    firstSeenAge?: string;
    lastSeenAge?: string;
}

export class EventStreamViewerPanel {
    private static currentPanel: EventStreamViewerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;
    private events: EventWithAge[] = [];
    private lastEventTime: Date | undefined;
    private isStreaming: boolean = true;

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
        this.loadEvents();
    }

    public static show(extensionUri: vscode.Uri, k8sClient: K8sClient): void {
        const column = vscode.ViewColumn.One;

        if (EventStreamViewerPanel.currentPanel) {
            EventStreamViewerPanel.currentPanel.panel.reveal(column);
            EventStreamViewerPanel.currentPanel.loadEvents();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'eventStreamViewer',
            '📡 Event Stream',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        EventStreamViewerPanel.currentPanel = new EventStreamViewerPanel(panel, extensionUri, k8sClient);
    }

    private async loadEvents(): Promise<void> {
        try {
            const allEvents = await this.k8sClient.getEvents('');
            
            // Sort events by last timestamp (most recent first)
            allEvents.sort((a, b) => {
                const timeA = new Date(b.lastTimestamp || b.eventTime || 0).getTime();
                const timeB = new Date(a.lastTimestamp || a.eventTime || 0).getTime();
                return timeA - timeB;
            });
            
            // Calculate ages
            const now = new Date();
            this.events = allEvents.map(event => {
                const lastTime = new Date(event.lastTimestamp || event.eventTime || now);
                const firstTime = new Date(event.firstTimestamp || event.eventTime || now);
                
                return {
                    ...event,
                    age: this.getAge(now, lastTime),
                    firstSeenAge: this.getAge(now, firstTime),
                    lastSeenAge: this.getAge(now, lastTime)
                };
            });
            
            this.updateWebview();
            this.startAutoRefresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load events: ${error}`);
        }
    }

    private getAge(now: Date, then: Date): string {
        const diffMs = now.getTime() - then.getTime();
        const diffSec = Math.floor(diffMs / 1000);
        
        if (diffSec < 60) {
            return `${diffSec}s`;
        } else if (diffSec < 3600) {
            return `${Math.floor(diffSec / 60)}m`;
        } else if (diffSec < 86400) {
            return `${Math.floor(diffSec / 3600)}h`;
        } else {
            return `${Math.floor(diffSec / 86400)}d`;
        }
    }

    private startAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        
        if (this.isStreaming) {
            this.refreshInterval = setInterval(async () => {
                try {
                    await this.loadEvents();
                } catch (error) {
                    console.error('Auto-refresh failed:', error);
                }
            }, 2000); // Refresh every 2 seconds for live streaming
        }
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'refresh':
                await this.loadEvents();
                break;
            case 'toggleStreaming':
                this.isStreaming = !this.isStreaming;
                if (this.isStreaming) {
                    this.startAutoRefresh();
                } else if (this.refreshInterval) {
                    clearInterval(this.refreshInterval);
                    this.refreshInterval = undefined;
                }
                this.panel.webview.postMessage({
                    command: 'streamingStatus',
                    isStreaming: this.isStreaming
                });
                break;
            case 'clearEvents':
                this.events = [];
                this.updateWebview();
                break;
            case 'viewEventYaml':
                await this.viewEventYaml(message.event);
                break;
            case 'exportEvents':
                await this.exportEvents(message.events);
                break;
        }
    }

    private updateWebview(): void {
        this.panel.webview.postMessage({
            command: 'updateEvents',
            events: this.events,
            stats: this.calculateStats()
        });
    }

    private calculateStats() {
        const total = this.events.length;
        const warnings = this.events.filter(e => e.type === 'Warning').length;
        const normal = this.events.filter(e => e.type === 'Normal').length;
        
        // Count unique namespaces
        const namespaces = new Set(this.events.map(e => e.involvedObject?.namespace).filter(Boolean));
        
        // Count unique kinds
        const kinds = new Set(this.events.map(e => e.involvedObject?.kind).filter(Boolean));
        
        // Recent events (last 5 minutes)
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const recent = this.events.filter(e => {
            const eventTime = new Date(e.lastTimestamp || e.eventTime || 0);
            return eventTime > fiveMinutesAgo;
        }).length;
        
        return {
            total,
            warnings,
            normal,
            namespaces: namespaces.size,
            kinds: kinds.size,
            recent
        };
    }

    private async viewEventYaml(event: any): Promise<void> {
        try {
            const yaml = require('yaml');
            const doc = await vscode.workspace.openTextDocument({
                language: 'yaml',
                content: yaml.stringify(event)
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view YAML: ${error}`);
        }
    }

    private async exportEvents(events: any[]): Promise<void> {
        try {
            const yaml = require('yaml');
            const content = yaml.stringify(events);
            
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file('kubernetes-events.yaml'),
                filters: {
                    'YAML': ['yaml', 'yml'],
                    'JSON': ['json']
                }
            });
            
            if (uri) {
                const encoder = new TextEncoder();
                await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
                vscode.window.showInformationMessage(`Exported ${events.length} events to ${uri.fsPath}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export events: ${error}`);
        }
    }

    private dispose(): void {
        EventStreamViewerPanel.currentPanel = undefined;

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
    <title>Event Stream</title>
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
            overflow-x: hidden;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 16px;
            border-bottom: 2px solid var(--vscode-panel-border);
        }

        h1 {
            font-size: 24px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .streaming-indicator {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
        }

        .streaming-indicator.active {
            background: rgba(76, 175, 80, 0.2);
            color: #4caf50;
        }

        .streaming-indicator.paused {
            background: rgba(158, 158, 158, 0.2);
            color: #9e9e9e;
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

        .controls {
            display: flex;
            gap: 12px;
            align-items: center;
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
            display: flex;
            align-items: center;
            gap: 6px;
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

        button.danger {
            background: rgba(244, 67, 54, 0.2);
            color: #f44336;
        }

        button.danger:hover {
            background: rgba(244, 67, 54, 0.3);
        }

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 12px;
            margin-bottom: 20px;
        }

        .stat-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px;
        }

        .stat-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 6px;
        }

        .stat-value {
            font-size: 24px;
            font-weight: 600;
        }

        .stat-value.warning {
            color: #ff9800;
        }

        .stat-value.success {
            color: #4caf50;
        }

        .filters {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr auto;
            gap: 12px;
            margin-bottom: 20px;
        }

        select, input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 13px;
        }

        select:focus, input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .events-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }

        .events-table thead {
            position: sticky;
            top: 0;
            background: var(--vscode-editor-background);
            z-index: 10;
        }

        .events-table th {
            text-align: left;
            padding: 12px 8px;
            border-bottom: 2px solid var(--vscode-panel-border);
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            font-size: 11px;
            letter-spacing: 0.5px;
        }

        .events-table td {
            padding: 12px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            vertical-align: top;
        }

        .events-table tbody tr {
            transition: background-color 0.2s;
        }

        .events-table tbody tr:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .events-table tbody tr.new-event {
            animation: highlight 2s;
        }

        @keyframes highlight {
            0% { background: rgba(76, 175, 80, 0.3); }
            100% { background: transparent; }
        }

        .event-type {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .event-type.warning {
            background: rgba(255, 152, 0, 0.2);
            color: #ff9800;
        }

        .event-type.normal {
            background: rgba(76, 175, 80, 0.2);
            color: #4caf50;
        }

        .event-type.error {
            background: rgba(244, 67, 54, 0.2);
            color: #f44336;
        }

        .event-count {
            display: inline-block;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: 600;
        }

        .resource-badge {
            display: inline-block;
            background: var(--vscode-textCodeBlock-background);
            padding: 4px 8px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
        }

        .namespace-badge {
            color: var(--vscode-textLink-foreground);
            font-weight: 500;
        }

        .reason {
            font-weight: 600;
        }

        .message {
            color: var(--vscode-descriptionForeground);
            max-width: 400px;
            word-wrap: break-word;
        }

        .age {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
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

        .loading {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }

        .event-actions {
            opacity: 0;
            transition: opacity 0.2s;
        }

        .events-table tbody tr:hover .event-actions {
            opacity: 1;
        }

        .event-actions button {
            padding: 4px 8px;
            font-size: 11px;
        }

        .scroll-container {
            max-height: calc(100vh - 400px);
            overflow-y: auto;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>
            📡 Event Stream
            <span id="streamingIndicator" class="streaming-indicator active">
                <span class="pulse"></span>
                LIVE
            </span>
        </h1>
        <div class="controls">
            <button onclick="toggleStreaming()">
                <span id="streamToggleIcon">⏸️</span>
                <span id="streamToggleText">Pause</span>
            </button>
            <button onclick="refresh()">🔄 Refresh</button>
            <button class="secondary" onclick="exportEvents()">💾 Export</button>
            <button class="danger" onclick="clearEvents()">🗑️ Clear</button>
        </div>
    </div>

    <div id="stats" class="stats"></div>

    <div class="filters">
        <input 
            type="text" 
            id="searchInput"
            placeholder="Search events..." 
            oninput="filterEvents()"
        />
        <select id="typeFilter" onchange="filterEvents()">
            <option value="">All Types</option>
            <option value="Normal">Normal</option>
            <option value="Warning">Warning</option>
        </select>
        <select id="namespaceFilter" onchange="filterEvents()">
            <option value="">All Namespaces</option>
        </select>
        <select id="kindFilter" onchange="filterEvents()">
            <option value="">All Resources</option>
        </select>
    </div>

    <div class="scroll-container">
        <table class="events-table">
            <thead>
                <tr>
                    <th>Type</th>
                    <th>Namespace</th>
                    <th>Resource</th>
                    <th>Reason</th>
                    <th>Message</th>
                    <th>Count</th>
                    <th>Age</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody id="eventsBody">
                <tr>
                    <td colspan="8" class="loading">Loading events...</td>
                </tr>
            </tbody>
        </table>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allEvents = [];
        let filteredEvents = [];
        let isStreaming = true;
        let previousEventCount = 0;

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateEvents') {
                const hadEvents = allEvents.length > 0;
                allEvents = message.events || [];
                
                if (hadEvents && allEvents.length > previousEventCount) {
                    // New events arrived
                    const newCount = allEvents.length - previousEventCount;
                    console.log(\`Received \${newCount} new events\`);
                }
                
                previousEventCount = allEvents.length;
                
                updateFilters();
                filterEvents();
                renderStats(message.stats);
            } else if (message.command === 'streamingStatus') {
                isStreaming = message.isStreaming;
                updateStreamingIndicator();
            }
        });

        function updateStreamingIndicator() {
            const indicator = document.getElementById('streamingIndicator');
            const toggleIcon = document.getElementById('streamToggleIcon');
            const toggleText = document.getElementById('streamToggleText');
            
            if (isStreaming) {
                indicator.className = 'streaming-indicator active';
                indicator.innerHTML = '<span class="pulse"></span> LIVE';
                toggleIcon.textContent = '⏸️';
                toggleText.textContent = 'Pause';
            } else {
                indicator.className = 'streaming-indicator paused';
                indicator.innerHTML = '⏹️ PAUSED';
                toggleIcon.textContent = '▶️';
                toggleText.textContent = 'Resume';
            }
        }

        function updateFilters() {
            const namespaces = new Set(allEvents.map(e => e.involvedObject?.namespace).filter(Boolean));
            const kinds = new Set(allEvents.map(e => e.involvedObject?.kind).filter(Boolean));
            
            const nsFilter = document.getElementById('namespaceFilter');
            const currentNs = nsFilter.value;
            nsFilter.innerHTML = '<option value="">All Namespaces</option>' + 
                Array.from(namespaces).sort().map(ns => 
                    \`<option value="\${ns}" \${ns === currentNs ? 'selected' : ''}>\${ns}</option>\`
                ).join('');
            
            const kindFilter = document.getElementById('kindFilter');
            const currentKind = kindFilter.value;
            kindFilter.innerHTML = '<option value="">All Resources</option>' + 
                Array.from(kinds).sort().map(kind => 
                    \`<option value="\${kind}" \${kind === currentKind ? 'selected' : ''}>\${kind}</option>\`
                ).join('');
        }

        function filterEvents() {
            const searchTerm = document.getElementById('searchInput').value.toLowerCase();
            const typeFilter = document.getElementById('typeFilter').value;
            const namespaceFilter = document.getElementById('namespaceFilter').value;
            const kindFilter = document.getElementById('kindFilter').value;
            
            filteredEvents = allEvents.filter(event => {
                const matchesSearch = !searchTerm || 
                    event.reason?.toLowerCase().includes(searchTerm) ||
                    event.message?.toLowerCase().includes(searchTerm) ||
                    event.involvedObject?.name?.toLowerCase().includes(searchTerm);
                
                const matchesType = !typeFilter || event.type === typeFilter;
                const matchesNamespace = !namespaceFilter || event.involvedObject?.namespace === namespaceFilter;
                const matchesKind = !kindFilter || event.involvedObject?.kind === kindFilter;
                
                return matchesSearch && matchesType && matchesNamespace && matchesKind;
            });
            
            renderEvents();
        }

        function renderEvents() {
            const tbody = document.getElementById('eventsBody');
            
            if (filteredEvents.length === 0) {
                tbody.innerHTML = \`
                    <tr>
                        <td colspan="8">
                            <div class="empty-state">
                                <div class="empty-state-icon">📭</div>
                                <div>No events found</div>
                            </div>
                        </td>
                    </tr>
                \`;
                return;
            }

            tbody.innerHTML = filteredEvents.map((event, index) => \`
                <tr class="\${index < 5 && isStreaming ? 'new-event' : ''}">
                    <td>
                        <span class="event-type \${event.type?.toLowerCase() || 'normal'}">
                            \${event.type === 'Warning' ? '⚠️' : '✓'} \${event.type || 'Normal'}
                        </span>
                    </td>
                    <td>
                        <span class="namespace-badge">\${event.involvedObject?.namespace || '-'}</span>
                    </td>
                    <td>
                        <div class="resource-badge">
                            \${event.involvedObject?.kind || '-'}/\${event.involvedObject?.name || '-'}
                        </div>
                    </td>
                    <td>
                        <span class="reason">\${event.reason || '-'}</span>
                    </td>
                    <td>
                        <div class="message">\${event.message || '-'}</div>
                    </td>
                    <td>
                        <span class="event-count">\${event.count || 1}</span>
                    </td>
                    <td>
                        <span class="age">\${event.age || '-'}</span>
                    </td>
                    <td>
                        <div class="event-actions">
                            <button class="secondary" onclick='viewEventYaml(\${JSON.stringify(event).replace(/'/g, "\\\\'")})'
>📄</button>
                        </div>
                    </td>
                </tr>
            \`).join('');
        }

        function renderStats(stats) {
            document.getElementById('stats').innerHTML = \`
                <div class="stat-card">
                    <div class="stat-label">Total Events</div>
                    <div class="stat-value">\${stats.total}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Warnings</div>
                    <div class="stat-value warning">\${stats.warnings}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Normal</div>
                    <div class="stat-value success">\${stats.normal}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Recent (5m)</div>
                    <div class="stat-value">\${stats.recent}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Namespaces</div>
                    <div class="stat-value">\${stats.namespaces}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Resource Types</div>
                    <div class="stat-value">\${stats.kinds}</div>
                </div>
            \`;
        }

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function toggleStreaming() {
            vscode.postMessage({ command: 'toggleStreaming' });
        }

        function clearEvents() {
            if (confirm('Clear all events from view? (This will not delete events from the cluster)')) {
                vscode.postMessage({ command: 'clearEvents' });
            }
        }

        function viewEventYaml(event) {
            vscode.postMessage({ command: 'viewEventYaml', event });
        }

        function exportEvents() {
            vscode.postMessage({ command: 'exportEvents', events: filteredEvents });
        }
    </script>
</body>
</html>`;
    }
}
