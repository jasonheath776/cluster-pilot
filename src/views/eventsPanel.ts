import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';
import * as k8s from '@kubernetes/client-node';

export class EventsPanel {
    private static currentPanel: EventsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;
    private events: k8s.CoreV1Event[] = [];
    private namespace: string | undefined;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private k8sClient: K8sClient,
        namespace?: string
    ) {
        this.panel = panel;
        this.namespace = namespace;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this.disposables
        );
        
        this.loadEvents();
    }

    public static show(
        extensionUri: vscode.Uri,
        k8sClient: K8sClient,
        namespace?: string
    ): void {
        const column = vscode.ViewColumn.One;

        if (EventsPanel.currentPanel) {
            EventsPanel.currentPanel.namespace = namespace;
            EventsPanel.currentPanel.panel.reveal(column);
            EventsPanel.currentPanel.loadEvents();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'eventsPanel',
            namespace ? `Events: ${namespace}` : 'Cluster Events',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        EventsPanel.currentPanel = new EventsPanel(panel, extensionUri, k8sClient, namespace);
    }

    private async loadEvents(): Promise<void> {
        try {
            this.events = await this.k8sClient.getEvents(this.namespace || '');
            this.update();
            this.startAutoRefresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load events: ${error}`);
        }
    }

    private startAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        
        this.refreshInterval = setInterval(async () => {
            try {
                this.events = await this.k8sClient.getEvents(this.namespace || '');
                this.update();
            } catch (error) {
                console.error('Auto-refresh failed:', error);
            }
        }, 5000);
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'refresh':
                await this.loadEvents();
                break;
            case 'filter':
                this.namespace = message.namespace;
                this.panel.title = message.namespace ? `Events: ${message.namespace}` : 'Cluster Events';
                await this.loadEvents();
                break;
        }
    }

    private update(): void {
        this.panel.webview.html = this.getHtmlContent();
    }

    private dispose(): void {
        EventsPanel.currentPanel = undefined;

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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Kubernetes Events</title>
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
            margin-bottom: 20px;
            padding-bottom: 16px;
            border-bottom: 2px solid var(--vscode-panel-border);
        }

        h1 {
            font-size: 24px;
        }

        .controls {
            display: flex;
            gap: 12px;
            align-items: center;
        }

        .filter-group {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        label {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }

        select, input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 13px;
        }

        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 12px;
            margin-bottom: 20px;
        }

        .stat-card {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            padding: 12px;
            border-radius: 6px;
        }

        .stat-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .stat-value {
            font-size: 24px;
            font-weight: bold;
            margin-top: 4px;
        }

        .stat-value.warning { color: #ffc107; }
        .stat-value.error { color: #f44336; }
        .stat-value.normal { color: #4caf50; }

        .events-table {
            width: 100%;
            border-collapse: collapse;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 6px;
            overflow: hidden;
        }

        .events-table th {
            background: var(--vscode-editor-background);
            padding: 12px;
            text-align: left;
            font-weight: 600;
            border-bottom: 2px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
        }

        .events-table td {
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .events-table tr:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .event-type {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .event-type.normal {
            background: #4caf50;
            color: white;
        }

        .event-type.warning {
            background: #ffc107;
            color: black;
        }

        .event-type.error {
            background: #f44336;
            color: white;
        }

        .event-time {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
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

        .no-events {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }

        .refresh-indicator {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📋 Kubernetes Events</h1>
        <div class="controls">
            <div class="filter-group">
                <label>Type:</label>
                <select id="typeFilter" onchange="filterEvents()">
                    <option value="">All</option>
                    <option value="Normal">Normal</option>
                    <option value="Warning">Warning</option>
                    <option value="Error">Error</option>
                </select>
            </div>
            <div class="filter-group">
                <label>Search:</label>
                <input type="text" id="searchFilter" placeholder="Filter events..." oninput="filterEvents()">
            </div>
            <button onclick="refresh()">🔄 Refresh</button>
            <span class="refresh-indicator">Auto-refresh: 5s</span>
        </div>
    </div>

    <div class="stats">
        <div class="stat-card">
            <div class="stat-label">Total Events</div>
            <div class="stat-value" id="totalEvents">0</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Normal</div>
            <div class="stat-value normal" id="normalEvents">0</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Warnings</div>
            <div class="stat-value warning" id="warningEvents">0</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Errors</div>
            <div class="stat-value error" id="errorEvents">0</div>
        </div>
    </div>

    <table class="events-table">
        <thead>
            <tr>
                <th>Type</th>
                <th>Time</th>
                <th>Namespace</th>
                <th>Object</th>
                <th>Reason</th>
                <th>Message</th>
                <th>Count</th>
            </tr>
        </thead>
        <tbody id="eventsBody">
            ${this.renderEvents()}
        </tbody>
    </table>

    <script>
        const vscode = acquireVsCodeApi();
        const allEvents = ${JSON.stringify(this.events)};
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function filterEvents() {
            const typeFilter = document.getElementById('typeFilter').value;
            const searchText = document.getElementById('searchFilter').value.toLowerCase();
            
            const filtered = allEvents.filter(event => {
                const matchesType = !typeFilter || event.type === typeFilter;
                const matchesSearch = !searchText || 
                    JSON.stringify(event).toLowerCase().includes(searchText);
                return matchesType && matchesSearch;
            });
            
            renderFilteredEvents(filtered);
            updateStats(filtered);
        }

        function renderFilteredEvents(events) {
            const tbody = document.getElementById('eventsBody');
            if (events.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="no-events">No events found</td></tr>';
                return;
            }

            tbody.innerHTML = events.map(event => {
                const type = (event.type || 'Normal').toLowerCase();
                const time = new Date(event.lastTimestamp || event.firstTimestamp).toLocaleString();
                const namespace = event.metadata?.namespace || '-';
                const objName = event.involvedObject?.name || '-';
                const objKind = event.involvedObject?.kind || '';
                const reason = event.reason || '-';
                const message = event.message || '-';
                const count = event.count > 1 ? event.count : '';
                
                return \`
                    <tr>
                        <td><span class="event-type \${type}">\${event.type || 'Normal'}</span></td>
                        <td class="event-time">\${time}</td>
                        <td>\${namespace}</td>
                        <td>\${objKind}/\${objName}</td>
                        <td><strong>\${reason}</strong></td>
                        <td>\${message}</td>
                        <td>\${count ? '<span class="event-count">' + count + 'x</span>' : ''}</td>
                    </tr>
                \`;
            }).join('');
        }

        function updateStats(events) {
            const total = events.length;
            const normal = events.filter(e => e.type === 'Normal').length;
            const warning = events.filter(e => e.type === 'Warning').length;
            const error = events.filter(e => e.type === 'Error').length;

            document.getElementById('totalEvents').textContent = total;
            document.getElementById('normalEvents').textContent = normal;
            document.getElementById('warningEvents').textContent = warning;
            document.getElementById('errorEvents').textContent = error;
        }

        // Initialize
        updateStats(allEvents);
    </script>
</body>
</html>`;
    }

    private renderEvents(): string {
        if (this.events.length === 0) {
            return '<tr><td colspan="7" class="no-events">No events found</td></tr>';
        }

        return this.events
            .sort((a, b) => {
                const timeA = new Date(a.lastTimestamp || a.firstTimestamp || 0).getTime();
                const timeB = new Date(b.lastTimestamp || b.firstTimestamp || 0).getTime();
                return timeB - timeA;
            })
            .map(event => {
                const type = (event.type || 'Normal').toLowerCase();
                const time = new Date(event.lastTimestamp || event.firstTimestamp || '').toLocaleString();
                const namespace = event.metadata?.namespace || '-';
                const objName = event.involvedObject?.name || '-';
                const objKind = event.involvedObject?.kind || '';
                const reason = this.escapeHtml(event.reason || '-');
                const message = this.escapeHtml(event.message || '-');
                const count = event.count && event.count > 1 ? event.count : '';
                
                return `
                    <tr>
                        <td><span class="event-type ${type}">${event.type || 'Normal'}</span></td>
                        <td class="event-time">${time}</td>
                        <td>${this.escapeHtml(namespace)}</td>
                        <td>${this.escapeHtml(objKind)}/${this.escapeHtml(objName)}</td>
                        <td><strong>${reason}</strong></td>
                        <td>${message}</td>
                        <td>${count ? `<span class="event-count">${count}x</span>` : ''}</td>
                    </tr>
                `;
            }).join('');
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
}
