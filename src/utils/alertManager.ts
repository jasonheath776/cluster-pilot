import * as vscode from 'vscode';
import { ResourceHealth } from './healthMonitor';

export interface Alert {
    id: string;
    timestamp: Date;
    severity: 'warning' | 'critical';
    resourceType: string;
    resourceName: string;
    namespace?: string;
    message: string;
    health: ResourceHealth;
    acknowledged: boolean;
}

export class AlertManager {
    private alerts: Map<string, Alert> = new Map();
    private statusBarItem: vscode.StatusBarItem;
    private _onDidAlertsChange = new vscode.EventEmitter<Alert[]>();
    readonly onDidAlertsChange = this._onDidAlertsChange.event;

    constructor(private context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'clusterPilot.showAlerts';
        this.updateStatusBar();
        this.statusBarItem.show();
        
        context.subscriptions.push(this.statusBarItem);
    }

    addAlert(alert: Omit<Alert, 'id' | 'timestamp' | 'acknowledged'>): void {
        const id = `${alert.resourceType}-${alert.namespace || 'cluster'}-${alert.resourceName}-${Date.now()}`;
        const newAlert: Alert = {
            ...alert,
            id,
            timestamp: new Date(),
            acknowledged: false
        };

        this.alerts.set(id, newAlert);
        this.updateStatusBar();
        this._onDidAlertsChange.fire(Array.from(this.alerts.values()));

        // Show notification for critical alerts
        if (alert.severity === 'critical') {
            const message = `${alert.resourceType} ${alert.resourceName}: ${alert.message}`;
            vscode.window.showErrorMessage(message, 'View Alerts', 'Dismiss').then(action => {
                if (action === 'View Alerts') {
                    vscode.commands.executeCommand('clusterPilot.showAlerts');
                }
            });
        }
    }

    acknowledgeAlert(id: string): void {
        const alert = this.alerts.get(id);
        if (alert) {
            alert.acknowledged = true;
            this.updateStatusBar();
            this._onDidAlertsChange.fire(Array.from(this.alerts.values()));
        }
    }

    clearAlert(id: string): void {
        this.alerts.delete(id);
        this.updateStatusBar();
        this._onDidAlertsChange.fire(Array.from(this.alerts.values()));
    }

    clearAllAlerts(): void {
        this.alerts.clear();
        this.updateStatusBar();
        this._onDidAlertsChange.fire([]);
    }

    getActiveAlerts(): Alert[] {
        return Array.from(this.alerts.values())
            .filter(a => !a.acknowledged)
            .sort((a, b) => {
                // Sort by severity (critical first) then timestamp (newest first)
                if (a.severity !== b.severity) {
                    return a.severity === 'critical' ? -1 : 1;
                }
                return b.timestamp.getTime() - a.timestamp.getTime();
            });
    }

    getAllAlerts(): Alert[] {
        return Array.from(this.alerts.values())
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    private updateStatusBar(): void {
        const activeAlerts = this.getActiveAlerts();
        const criticalCount = activeAlerts.filter(a => a.severity === 'critical').length;
        const warningCount = activeAlerts.filter(a => a.severity === 'warning').length;

        if (activeAlerts.length === 0) {
            this.statusBarItem.text = '$(check) No Alerts';
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = 'All resources healthy';
        } else {
            const parts = [];
            if (criticalCount > 0) {
                parts.push(`$(error) ${criticalCount}`);
            }
            if (warningCount > 0) {
                parts.push(`$(warning) ${warningCount}`);
            }
            this.statusBarItem.text = parts.join(' ');
            this.statusBarItem.backgroundColor = criticalCount > 0 
                ? new vscode.ThemeColor('statusBarItem.errorBackground')
                : new vscode.ThemeColor('statusBarItem.warningBackground');
            this.statusBarItem.tooltip = `${criticalCount} critical, ${warningCount} warnings - Click to view`;
        }
    }

    dispose(): void {
        this.statusBarItem.dispose();
        this._onDidAlertsChange.dispose();
    }
}
