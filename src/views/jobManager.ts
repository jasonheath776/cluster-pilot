import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';

export class JobManagerPanel {
    private panel: vscode.WebviewPanel;
    private refreshInterval?: NodeJS.Timeout;

    constructor(
        private context: vscode.ExtensionContext,
        private k8sClient: K8sClient,
        private jobName?: string,
        private jobType?: 'job' | 'cronjob'
    ) {
        const title = jobName ? `Job: ${jobName}` : 'Job Manager';
        
        this.panel = vscode.window.createWebviewPanel(
            'jobManager',
            title,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getLoadingContent();
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            undefined,
            context.subscriptions
        );

        this.panel.onDidDispose(() => {
            if (this.refreshInterval) {
                clearInterval(this.refreshInterval);
            }
        });

        this.updateContent();
        
        // Auto-refresh every 5 seconds
        this.refreshInterval = setInterval(() => {
            this.updateContent();
        }, 5000);
    }

    private async handleMessage(message: { command: string; jobName?: string; namespace?: string }) {
        switch (message.command) {
            case 'refresh':
                await this.updateContent();
                break;
            case 'deleteJob':
                if (message.jobName && message.namespace) {
                    await this.deleteJob(message.jobName, message.namespace);
                }
                break;
            case 'triggerCronJob':
                if (message.jobName && message.namespace) {
                    await this.triggerCronJob(message.jobName, message.namespace);
                }
                break;
            case 'suspendCronJob':
                if (message.jobName && message.namespace) {
                    await this.toggleCronJobSuspend(message.jobName, message.namespace, true);
                }
                break;
            case 'resumeCronJob':
                if (message.jobName && message.namespace) {
                    await this.toggleCronJobSuspend(message.jobName, message.namespace, false);
                }
                break;
        }
    }

    private async deleteJob(jobName: string, namespace: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete job ${jobName}?`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            try {
                await this.k8sClient.deleteJob(jobName, namespace);
                vscode.window.showInformationMessage(`Job ${jobName} deleted`);
                this.updateContent();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete job: ${error}`);
            }
        }
    }

    private async triggerCronJob(cronJobName: string, namespace: string): Promise<void> {
        try {
            await this.k8sClient.triggerCronJob(cronJobName, namespace);
            vscode.window.showInformationMessage(`CronJob ${cronJobName} triggered`);
            this.updateContent();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to trigger CronJob: ${error}`);
        }
    }

    private async toggleCronJobSuspend(cronJobName: string, namespace: string, suspend: boolean): Promise<void> {
        try {
            await this.k8sClient.toggleCronJobSuspend(cronJobName, namespace, suspend);
            const action = suspend ? 'suspended' : 'resumed';
            vscode.window.showInformationMessage(`CronJob ${cronJobName} ${action}`);
            this.updateContent();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update CronJob: ${error}`);
        }
    }

    private async updateContent(): Promise<void> {
        try {
            const html = await this.getWebviewContent();
            this.panel.webview.html = html;
        } catch (error) {
            this.panel.webview.html = this.getErrorContent(String(error));
        }
    }

    private getLoadingContent(): string {
        return `<!DOCTYPE html>
<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;">
<div>Loading job information...</div>
</body></html>`;
    }

    private getErrorContent(error: string): string {
        return `<!DOCTYPE html>
<html><body style="padding:20px;color:var(--vscode-errorForeground);">
<h2>Error</h2><p>${this.escapeHtml(error)}</p>
</body></html>`;
    }

    private async getWebviewContent(): Promise<string> {
        const jobs = await this.k8sClient.getJobs();
        const cronJobs = await this.k8sClient.getCronJobs();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Job Manager</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        h1, h2 {
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 10px;
        }
        h2 {
            margin-top: 30px;
            font-size: 1.3em;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .stat-card {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            padding: 15px;
        }
        .stat-value {
            font-size: 24px;
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }
        .stat-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 5px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
        }
        th, td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        th {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-descriptionForeground);
            font-weight: 600;
            font-size: 12px;
            text-transform: uppercase;
        }
        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .badge {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 600;
        }
        .badge-success { background-color: #28a745; color: white; }
        .badge-failed { background-color: #dc3545; color: white; }
        .badge-running { background-color: #007acc; color: white; }
        .badge-pending { background-color: #6c757d; color: white; }
        .badge-suspended { background-color: #ffc107; color: black; }
        .actions {
            display: flex;
            gap: 8px;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-danger {
            background-color: var(--vscode-errorForeground);
            color: white;
        }
        .btn-danger:hover {
            opacity: 0.9;
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .refresh-btn {
            float: right;
            margin-top: -40px;
        }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <h1>⚙️ Job Manager</h1>
    
    <div class="stats">
        <div class="stat-card">
            <div class="stat-value">${jobs.length}</div>
            <div class="stat-label">Total Jobs</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${jobs.filter(j => (j.status?.succeeded || 0) > 0).length}</div>
            <div class="stat-label">Succeeded Jobs</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${jobs.filter(j => (j.status?.failed || 0) > 0).length}</div>
            <div class="stat-label">Failed Jobs</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${cronJobs.length}</div>
            <div class="stat-label">CronJobs</div>
        </div>
    </div>

    <h2>Jobs
        <button class="refresh-btn" onclick="refresh()">🔄 Refresh</button>
    </h2>
    ${this.renderJobsTable(jobs)}

    <h2>CronJobs</h2>
    ${this.renderCronJobsTable(cronJobs)}

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function deleteJob(jobName, namespace) {
            vscode.postMessage({
                command: 'deleteJob',
                jobName: jobName,
                namespace: namespace
            });
        }

        function triggerCronJob(jobName, namespace) {
            vscode.postMessage({
                command: 'triggerCronJob',
                jobName: jobName,
                namespace: namespace
            });
        }

        function suspendCronJob(jobName, namespace) {
            vscode.postMessage({
                command: 'suspendCronJob',
                jobName: jobName,
                namespace: namespace
            });
        }

        function resumeCronJob(jobName, namespace) {
            vscode.postMessage({
                command: 'resumeCronJob',
                jobName: jobName,
                namespace: namespace
            });
        }
    </script>
</body>
</html>`;
    }

    private renderJobsTable(jobs: k8s.V1Job[]): string {
        if (jobs.length === 0) {
            return '<div class="empty-state">No jobs found</div>';
        }

        let html = '<table><thead><tr><th>Name</th><th>Namespace</th><th>Status</th><th>Succeeded</th><th>Failed</th><th>Active</th><th>Duration</th><th>Actions</th></tr></thead><tbody>';

        for (const job of jobs) {
            const name = job.metadata?.name || 'unknown';
            const namespace = job.metadata?.namespace || 'default';
            const succeeded = job.status?.succeeded || 0;
            const failed = job.status?.failed || 0;
            const active = job.status?.active || 0;
            
            let status = 'Pending';
            let badge = 'badge-pending';
            if (succeeded > 0) {
                status = 'Succeeded';
                badge = 'badge-success';
            } else if (failed > 0) {
                status = 'Failed';
                badge = 'badge-failed';
            } else if (active > 0) {
                status = 'Running';
                badge = 'badge-running';
            }

            const startTime = job.status?.startTime;
            const completionTime = job.status?.completionTime;
            let duration = 'N/A';
            if (startTime) {
                const start = new Date(startTime).getTime();
                const end = completionTime ? new Date(completionTime).getTime() : Date.now();
                const seconds = Math.floor((end - start) / 1000);
                duration = this.formatDuration(seconds);
            }

            html += `<tr>
                <td>${this.escapeHtml(name)}</td>
                <td>${this.escapeHtml(namespace)}</td>
                <td><span class="badge ${badge}">${status}</span></td>
                <td>${succeeded}</td>
                <td>${failed}</td>
                <td>${active}</td>
                <td>${duration}</td>
                <td>
                    <div class="actions">
                        <button class="btn-danger" onclick="deleteJob('${this.escapeHtml(name)}', '${this.escapeHtml(namespace)}')">Delete</button>
                    </div>
                </td>
            </tr>`;
        }

        html += '</tbody></table>';
        return html;
    }

    private renderCronJobsTable(cronJobs: k8s.V1CronJob[]): string {
        if (cronJobs.length === 0) {
            return '<div class="empty-state">No cronjobs found</div>';
        }

        let html = '<table><thead><tr><th>Name</th><th>Namespace</th><th>Schedule</th><th>Suspended</th><th>Last Schedule</th><th>Active</th><th>Actions</th></tr></thead><tbody>';

        for (const cronJob of cronJobs) {
            const name = cronJob.metadata?.name || 'unknown';
            const namespace = cronJob.metadata?.namespace || 'default';
            const schedule = cronJob.spec?.schedule || 'N/A';
            const suspended = cronJob.spec?.suspend || false;
            const lastSchedule = cronJob.status?.lastScheduleTime;
            const active = cronJob.status?.active?.length || 0;
            
            const lastScheduleStr = lastSchedule ? this.formatTime(new Date(lastSchedule)) : 'Never';

            html += `<tr>
                <td>${this.escapeHtml(name)}</td>
                <td>${this.escapeHtml(namespace)}</td>
                <td><code>${this.escapeHtml(schedule)}</code></td>
                <td>${suspended ? '<span class="badge badge-suspended">Suspended</span>' : '<span class="badge badge-success">Active</span>'}</td>
                <td>${lastScheduleStr}</td>
                <td>${active}</td>
                <td>
                    <div class="actions">
                        <button onclick="triggerCronJob('${this.escapeHtml(name)}', '${this.escapeHtml(namespace)}')">Trigger Now</button>
                        ${suspended ? 
                            `<button class="btn-secondary" onclick="resumeCronJob('${this.escapeHtml(name)}', '${this.escapeHtml(namespace)}')">Resume</button>` :
                            `<button class="btn-secondary" onclick="suspendCronJob('${this.escapeHtml(name)}', '${this.escapeHtml(namespace)}')">Suspend</button>`
                        }
                    </div>
                </td>
            </tr>`;
        }

        html += '</tbody></table>';
        return html;
    }

    private formatDuration(seconds: number): string {
        if (seconds < 60) {
            return `${seconds}s`;
        } else if (seconds < 3600) {
            return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return `${hours}h ${minutes}m`;
        }
    }

    private formatTime(date: Date): string {
        const now = Date.now();
        const diff = now - date.getTime();
        const seconds = Math.floor(diff / 1000);
        
        if (seconds < 60) {
            return `${seconds}s ago`;
        } else if (seconds < 3600) {
            return `${Math.floor(seconds / 60)}m ago`;
        } else if (seconds < 86400) {
            return `${Math.floor(seconds / 3600)}h ago`;
        } else {
            return `${Math.floor(seconds / 86400)}d ago`;
        }
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
