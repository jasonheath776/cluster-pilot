import * as vscode from 'vscode';
import { AlertManager, Alert } from '../utils/alertManager';

export class AlertsPanel {
    private panel: vscode.WebviewPanel;
    private alerts: Alert[];

    constructor(
        private context: vscode.ExtensionContext,
        private alertManager: AlertManager
    ) {
        this.alerts = alertManager.getAllAlerts();

        this.panel = vscode.window.createWebviewPanel(
            'clusterPilotAlerts',
            'Cluster Alerts',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getHtmlContent();

        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            undefined,
            context.subscriptions
        );

        // Listen for alert changes
        alertManager.onDidAlertsChange(alerts => {
            this.alerts = alerts;
            this.panel.webview.html = this.getHtmlContent();
        });
    }

    private handleMessage(message: { command: string; alertId?: string }): void {
        switch (message.command) {
            case 'acknowledge':
                if (message.alertId) {
                    this.alertManager.acknowledgeAlert(message.alertId);
                }
                break;
            case 'clear':
                if (message.alertId) {
                    this.alertManager.clearAlert(message.alertId);
                }
                break;
            case 'clearAll':
                this.alertManager.clearAllAlerts();
                break;
        }
    }

    private getHtmlContent(): string {
        const activeAlerts = this.alerts.filter(a => !a.acknowledged);
        const acknowledgedAlerts = this.alerts.filter(a => a.acknowledged);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cluster Alerts</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        h1, h2 {
            color: var(--vscode-editor-foreground);
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .stats {
            display: flex;
            gap: 20px;
        }
        .stat {
            padding: 8px 16px;
            border-radius: 4px;
            font-weight: 600;
        }
        .stat.critical {
            background-color: rgba(244, 67, 54, 0.2);
            color: #F44336;
        }
        .stat.warning {
            background-color: rgba(255, 152, 0, 0.2);
            color: #FF9800;
        }
        .alert-card {
            margin: 10px 0;
            padding: 15px;
            border-radius: 4px;
            border-left: 4px solid;
        }
        .alert-card.critical {
            background-color: rgba(244, 67, 54, 0.1);
            border-left-color: #F44336;
        }
        .alert-card.warning {
            background-color: rgba(255, 152, 0, 0.1);
            border-left-color: #FF9800;
        }
        .alert-card.acknowledged {
            opacity: 0.6;
            background-color: rgba(158, 158, 158, 0.1);
            border-left-color: #9E9E9E;
        }
        .alert-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .alert-title {
            font-weight: 600;
            font-size: 14px;
        }
        .alert-meta {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin: 5px 0;
        }
        .alert-message {
            margin: 10px 0;
            padding: 10px;
            background-color: var(--vscode-textCodeBlock-background);
            border-radius: 3px;
        }
        .alert-issues {
            margin-top: 10px;
        }
        .issue {
            padding: 5px 0;
            font-size: 12px;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 3px;
            cursor: pointer;
            margin-right: 5px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .empty-state .icon {
            font-size: 48px;
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Cluster Alerts</h1>
        <div class="stats">
            <div class="stat critical">❌ ${activeAlerts.filter(a => a.severity === 'critical').length} Critical</div>
            <div class="stat warning">⚠️ ${activeAlerts.filter(a => a.severity === 'warning').length} Warnings</div>
        </div>
    </div>

    ${activeAlerts.length > 0 ? `
        <button onclick="clearAll()">Clear All</button>
    ` : ''}

    ${activeAlerts.length === 0 ? `
        <div class="empty-state">
            <div class="icon">✅</div>
            <h2>No Active Alerts</h2>
            <p>All resources are healthy</p>
        </div>
    ` : `
        <h2>Active Alerts</h2>
        ${activeAlerts.map(alert => this.renderAlert(alert, false)).join('')}
    `}

    ${acknowledgedAlerts.length > 0 ? `
        <h2 style="margin-top: 40px;">Acknowledged</h2>
        ${acknowledgedAlerts.map(alert => this.renderAlert(alert, true)).join('')}
    ` : ''}

    <script>
        const vscode = acquireVsCodeApi();

        function acknowledge(alertId) {
            vscode.postMessage({ command: 'acknowledge', alertId });
        }

        function clear(alertId) {
            vscode.postMessage({ command: 'clear', alertId });
        }

        function clearAll() {
            if (confirm('Clear all alerts?')) {
                vscode.postMessage({ command: 'clearAll' });
            }
        }
    </script>
</body>
</html>`;
    }

    private renderAlert(alert: Alert, acknowledged: boolean): string {
        const timestamp = alert.timestamp.toLocaleString();
        const namespace = alert.namespace ? ` (${alert.namespace})` : '';
        
        return `
            <div class="alert-card ${acknowledged ? 'acknowledged' : alert.severity}">
                <div class="alert-header">
                    <div class="alert-title">
                        ${alert.severity === 'critical' ? '❌' : '⚠️'} 
                        ${alert.resourceType}: ${alert.resourceName}${namespace}
                    </div>
                    <div>
                        ${!acknowledged ? `<button onclick="acknowledge('${alert.id}')">Acknowledge</button>` : ''}
                        <button class="secondary" onclick="clear('${alert.id}')">Clear</button>
                    </div>
                </div>
                <div class="alert-meta">
                    ${timestamp} | Severity: ${alert.severity.toUpperCase()}
                </div>
                <div class="alert-message">
                    ${this.escapeHtml(alert.message)}
                </div>
                ${alert.health.issues.length > 1 ? `
                    <div class="alert-issues">
                        <strong>Issues:</strong>
                        ${alert.health.issues.map(issue => `
                            <div class="issue">• ${this.escapeHtml(issue)}</div>
                        `).join('')}
                    </div>
                ` : ''}
            </div>
        `;
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
