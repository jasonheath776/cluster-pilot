import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

interface DeploymentRevision {
    revision: number;
    creationTimestamp: string;
    images: string[];
    replicas: number;
    changeAuse?: string;
}

interface RolloutStatus {
    name: string;
    namespace: string;
    replicas: number;
    updatedReplicas: number;
    availableReplicas: number;
    readyReplicas: number;
    unavailableReplicas: number;
    currentRevision: number;
    strategy: string;
    maxSurge?: string;
    maxUnavailable?: string;
    paused: boolean;
    progressDeadlineSeconds?: number;
    conditions: Array<{
        type: string;
        status: string;
        reason?: string;
        message?: string;
        lastTransitionTime?: string;
    }>;
}

export class RolloutManagerPanel {
    public static currentPanel: RolloutManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private currentDeployment: { name: string; namespace: string } | undefined;
    private refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(
        extensionUri: vscode.Uri,
        k8sClient: K8sClient,
        deploymentName?: string,
        namespace?: string
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (RolloutManagerPanel.currentPanel) {
            RolloutManagerPanel.currentPanel.panel.reveal(column);
            if (deploymentName && namespace) {
                RolloutManagerPanel.currentPanel.loadDeployment(deploymentName, namespace);
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'rolloutManager',
            'Rollout Manager',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        RolloutManagerPanel.currentPanel = new RolloutManagerPanel(
            panel,
            extensionUri,
            k8sClient,
            deploymentName,
            namespace
        );
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly k8sClient: K8sClient,
        deploymentName?: string,
        namespace?: string
    ) {
        this.panel = panel;
        this.panel.webview.html = this.getHtmlContent();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'selectDeployment':
                        await this.selectDeployment();
                        break;
                    case 'refresh':
                        await this.refresh();
                        break;
                    case 'rollback':
                        await this.rollbackToRevision(message.revision);
                        break;
                    case 'pause':
                        await this.pauseRollout();
                        break;
                    case 'resume':
                        await this.resumeRollout();
                        break;
                    case 'restart':
                        await this.restartRollout();
                        break;
                    case 'viewRevisionDiff':
                        await this.viewRevisionDiff(message.revision1, message.revision2);
                        break;
                }
            },
            null,
            this.disposables
        );

        if (deploymentName && namespace) {
            this.loadDeployment(deploymentName, namespace);
        } else {
            this.selectDeployment();
        }

        this.startAutoRefresh();
    }

    private startAutoRefresh() {
        this.refreshInterval = setInterval(() => {
            if (this.currentDeployment) {
                this.refresh();
            }
        }, 5000); // Refresh every 5 seconds during rollouts
    }

    private async selectDeployment() {
        try {
            const deployments = await this.k8sClient.getDeployments();
            
            if (deployments.length === 0) {
                vscode.window.showInformationMessage('No deployments found');
                return;
            }

            const items = deployments.map(d => ({
                label: d.metadata?.name || 'unknown',
                description: `namespace: ${d.metadata?.namespace || 'default'}`,
                deployment: d
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a deployment to manage rollouts'
            });

            if (selected) {
                const name = selected.deployment.metadata?.name;
                const namespace = selected.deployment.metadata?.namespace || 'default';
                if (name) {
                    this.loadDeployment(name, namespace);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to list deployments: ${error}`);
        }
    }

    private async loadDeployment(name: string, namespace: string) {
        this.currentDeployment = { name, namespace };
        this.panel.title = `Rollout: ${name}`;
        await this.refresh();
    }

    private async refresh() {
        if (!this.currentDeployment) {
            return;
        }

        try {
            const { name, namespace } = this.currentDeployment;
            
            // Get deployment
            const deployments = await this.k8sClient.getDeployments(namespace);
            const deployment = deployments.find(d => d.metadata?.name === name);

            if (!deployment) {
                vscode.window.showErrorMessage(`Deployment ${name} not found`);
                return;
            }

            // Parse rollout status
            const status: RolloutStatus = {
                name,
                namespace,
                replicas: deployment.spec?.replicas || 0,
                updatedReplicas: deployment.status?.updatedReplicas || 0,
                availableReplicas: deployment.status?.availableReplicas || 0,
                readyReplicas: deployment.status?.readyReplicas || 0,
                unavailableReplicas: deployment.status?.unavailableReplicas || 0,
                currentRevision: parseInt(
                    deployment.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '0'
                ),
                strategy: deployment.spec?.strategy?.type || 'RollingUpdate',
                maxSurge: deployment.spec?.strategy?.rollingUpdate?.maxSurge?.toString(),
                maxUnavailable: deployment.spec?.strategy?.rollingUpdate?.maxUnavailable?.toString(),
                paused: deployment.spec?.paused || false,
                progressDeadlineSeconds: deployment.spec?.progressDeadlineSeconds,
                conditions: (deployment.status?.conditions || []).map(c => ({
                    type: c.type || 'Unknown',
                    status: c.status || 'Unknown',
                    reason: c.reason,
                    message: c.message,
                    lastTransitionTime: c.lastTransitionTime?.toISOString()
                }))
            };

            // Get revision history
            const revisions = await this.getRevisionHistory(name, namespace);

            this.panel.webview.postMessage({
                command: 'updateData',
                status,
                revisions,
                deployment: {
                    spec: deployment.spec,
                    metadata: deployment.metadata
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh rollout status: ${error}`);
        }
    }

    private async getRevisionHistory(
        deploymentName: string,
        namespace: string
    ): Promise<DeploymentRevision[]> {
        try {
            // Get ReplicaSets owned by this deployment
            const replicaSets = await this.k8sClient.getReplicaSets(namespace);
            
            const deploymentRS = replicaSets.filter(rs => {
                const ownerRefs = rs.metadata?.ownerReferences || [];
                return ownerRefs.some(
                    ref => ref.kind === 'Deployment' && ref.name === deploymentName
                );
            });

            const revisions = deploymentRS
                .map(rs => {
                    const revision = parseInt(
                        rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '0'
                    );
                    
                    const images = (rs.spec?.template?.spec?.containers || []).map(
                        c => c.image || 'unknown'
                    );

                    const changeCause = rs.metadata?.annotations?.[
                        'kubernetes.io/change-cause'
                    ];

                    return {
                        revision,
                        creationTimestamp: rs.metadata?.creationTimestamp?.toISOString() || '',
                        images,
                        replicas: rs.status?.replicas || 0,
                        changeCause
                    };
                })
                .filter(r => r.revision > 0)
                .sort((a, b) => b.revision - a.revision);

            return revisions;
        } catch (error) {
            console.error('Failed to get revision history:', error);
            return [];
        }
    }

    private async rollbackToRevision(revision: number) {
        if (!this.currentDeployment) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Rollback ${this.currentDeployment.name} to revision ${revision}?`,
            { modal: true },
            'Rollback'
        );

        if (confirm !== 'Rollback') {
            return;
        }

        try {
            await this.k8sClient.rollbackDeployment(
                this.currentDeployment.name,
                this.currentDeployment.namespace,
                revision
            );
            vscode.window.showInformationMessage(
                `Rolling back ${this.currentDeployment.name} to revision ${revision}`
            );
            await this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to rollback: ${error}`);
        }
    }

    private async pauseRollout() {
        if (!this.currentDeployment) {
            return;
        }

        try {
            await this.k8sClient.pauseDeployment(
                this.currentDeployment.name,
                this.currentDeployment.namespace
            );
            vscode.window.showInformationMessage(
                `Paused rollout for ${this.currentDeployment.name}`
            );
            await this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to pause rollout: ${error}`);
        }
    }

    private async resumeRollout() {
        if (!this.currentDeployment) {
            return;
        }

        try {
            await this.k8sClient.resumeDeployment(
                this.currentDeployment.name,
                this.currentDeployment.namespace
            );
            vscode.window.showInformationMessage(
                `Resumed rollout for ${this.currentDeployment.name}`
            );
            await this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to resume rollout: ${error}`);
        }
    }

    private async restartRollout() {
        if (!this.currentDeployment) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Restart rollout for ${this.currentDeployment.name}? This will recreate all pods.`,
            { modal: true },
            'Restart'
        );

        if (confirm !== 'Restart') {
            return;
        }

        try {
            await this.k8sClient.restartDeployment(
                this.currentDeployment.name,
                this.currentDeployment.namespace
            );
            vscode.window.showInformationMessage(
                `Restarting ${this.currentDeployment.name}`
            );
            await this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to restart rollout: ${error}`);
        }
    }

    private async viewRevisionDiff(revision1: number, revision2: number) {
        if (!this.currentDeployment) {
            return;
        }

        try {
            const { namespace } = this.currentDeployment;
            const replicaSets = await this.k8sClient.getReplicaSets(namespace);
            
            const rs1 = replicaSets.find(rs => 
                parseInt(rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '0') === revision1
            );
            const rs2 = replicaSets.find(rs => 
                parseInt(rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '0') === revision2
            );

            if (!rs1 || !rs2) {
                vscode.window.showErrorMessage('One or both revisions not found');
                return;
            }

            const yaml1 = JSON.stringify(rs1.spec?.template, null, 2);
            const yaml2 = JSON.stringify(rs2.spec?.template, null, 2);

            const doc1 = await vscode.workspace.openTextDocument({
                content: yaml1,
                language: 'json'
            });
            const doc2 = await vscode.workspace.openTextDocument({
                content: yaml2,
                language: 'json'
            });

            await vscode.commands.executeCommand(
                'vscode.diff',
                doc1.uri,
                doc2.uri,
                `Revision ${revision1} ↔ Revision ${revision2}`
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view diff: ${error}`);
        }
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rollout Manager</title>
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
        button.danger {
            background-color: var(--vscode-errorForeground);
        }
        button.danger:hover {
            opacity: 0.8;
        }
        .status-section {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 4px;
        }
        .progress-container {
            margin: 20px 0;
        }
        .progress-label {
            display: flex;
            justify-content: space-between;
            font-size: 12px;
            margin-bottom: 5px;
        }
        .progress-bar {
            width: 100%;
            height: 30px;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
            overflow: hidden;
            position: relative;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--vscode-charts-blue), var(--vscode-charts-green));
            transition: width 0.5s;
        }
        .progress-fill.warning {
            background: linear-gradient(90deg, var(--vscode-charts-orange), var(--vscode-charts-yellow));
        }
        .progress-fill.error {
            background: var(--vscode-charts-red);
        }
        .progress-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-weight: bold;
            font-size: 12px;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        .info-box {
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-radius: 3px;
            text-align: center;
        }
        .info-label {
            font-size: 11px;
            opacity: 0.8;
            margin-bottom: 5px;
        }
        .info-value {
            font-size: 20px;
            font-weight: bold;
        }
        .strategy-info {
            background-color: var(--vscode-editor-background);
            padding: 15px;
            border-radius: 3px;
            margin: 15px 0;
        }
        .strategy-info h3 {
            margin-top: 0;
        }
        .conditions {
            margin: 20px 0;
        }
        .condition {
            padding: 10px;
            margin: 5px 0;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
            border-left: 4px solid var(--vscode-charts-blue);
            font-size: 13px;
        }
        .condition.available {
            border-left-color: var(--vscode-charts-green);
        }
        .condition.progressing {
            border-left-color: var(--vscode-charts-orange);
        }
        .condition.failure {
            border-left-color: var(--vscode-charts-red);
        }
        .revision-history {
            margin-top: 30px;
        }
        .revision-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        .revision-table th,
        .revision-table td {
            text-align: left;
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .revision-table th {
            background-color: var(--vscode-editor-background);
            font-weight: 600;
            font-size: 13px;
        }
        .revision-table td {
            font-size: 12px;
        }
        .revision-table tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .current-revision {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            font-weight: bold;
        }
        .revision-actions {
            display: flex;
            gap: 5px;
        }
        .revision-actions button {
            padding: 4px 8px;
            font-size: 11px;
        }
        .status-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 11px;
            margin-left: 10px;
        }
        .status-badge.paused {
            background-color: var(--vscode-charts-orange);
            color: white;
        }
        .status-badge.rolling {
            background-color: var(--vscode-charts-blue);
            color: white;
        }
        .status-badge.complete {
            background-color: var(--vscode-charts-green);
            color: white;
        }
        .no-deployment {
            text-align: center;
            padding: 60px 20px;
            opacity: 0.6;
        }
        .images-list {
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
            line-height: 1.5;
        }
        .change-cause {
            font-style: italic;
            opacity: 0.8;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Rollout Manager</h1>
        <div class="actions">
            <button onclick="selectDeployment()">Select Deployment</button>
            <button onclick="refresh()">Refresh</button>
        </div>
    </div>

    <div id="content">
        <div class="no-deployment">
            <h2>No deployment selected</h2>
            <p>Click "Select Deployment" to manage rollouts</p>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentStatus = null;
        let currentRevisions = [];

        function selectDeployment() {
            vscode.postMessage({ command: 'selectDeployment' });
        }

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function rollback(revision) {
            vscode.postMessage({
                command: 'rollback',
                revision: revision
            });
        }

        function pause() {
            vscode.postMessage({ command: 'pause' });
        }

        function resume() {
            vscode.postMessage({ command: 'resume' });
        }

        function restart() {
            vscode.postMessage({ command: 'restart' });
        }

        function viewDiff(rev1, rev2) {
            vscode.postMessage({
                command: 'viewRevisionDiff',
                revision1: rev1,
                revision2: rev2
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateData') {
                currentStatus = message.status;
                currentRevisions = message.revisions;
                renderContent();
            }
        });

        function renderContent() {
            if (!currentStatus) {
                return;
            }

            const status = currentStatus;
            const revisions = currentRevisions;

            // Calculate progress
            const totalReplicas = status.replicas;
            const updatedReplicas = status.updatedReplicas;
            const availableReplicas = status.availableReplicas;
            const progressPercent = totalReplicas > 0 ? 
                (availableReplicas / totalReplicas) * 100 : 0;

            let statusBadge = '';
            let progressClass = '';
            let rolloutActions = '';

            if (status.paused) {
                statusBadge = '<span class="status-badge paused">PAUSED</span>';
                rolloutActions = '<button onclick="resume()">Resume Rollout</button>';
            } else if (updatedReplicas < totalReplicas || availableReplicas < totalReplicas) {
                statusBadge = '<span class="status-badge rolling">ROLLING OUT</span>';
                progressClass = 'warning';
                rolloutActions = '<button onclick="pause()">Pause Rollout</button>';
            } else if (availableReplicas === totalReplicas && status.unavailableReplicas === 0) {
                statusBadge = '<span class="status-badge complete">COMPLETE</span>';
                progressClass = '';
            }

            if (status.unavailableReplicas > 0 && !status.paused) {
                progressClass = 'error';
            }

            const conditionsHtml = status.conditions.map(c => {
                let className = 'condition';
                if (c.type === 'Available') {
                    className += ' available';
                } else if (c.type === 'Progressing') {
                    className += ' progressing';
                } else if (c.type.includes('Failure')) {
                    className += ' failure';
                }

                const time = c.lastTransitionTime ? 
                    new Date(c.lastTransitionTime).toLocaleString() : '';

                return \`
                    <div class="\${className}">
                        <strong>\${c.type}</strong>: \${c.status}
                        \${c.reason ? \` - \${c.reason}\` : ''}
                        \${time ? \`<br><small>\${time}</small>\` : ''}
                        \${c.message ? \`<br><small>\${c.message}</small>\` : ''}
                    </div>
                \`;
            }).join('');

            const revisionsHtml = revisions.map((rev, idx) => {
                const isCurrent = rev.revision === status.currentRevision;
                const rowClass = isCurrent ? 'current-revision' : '';
                const badge = isCurrent ? ' <span class="status-badge">CURRENT</span>' : '';

                const canCompare = idx < revisions.length - 1;
                const compareBtn = canCompare ? 
                    \`<button onclick="viewDiff(\${rev.revision}, \${revisions[idx + 1].revision})">Compare</button>\` : '';

                return \`
                    <tr class="\${rowClass}">
                        <td>\${rev.revision}\${badge}</td>
                        <td>\${new Date(rev.creationTimestamp).toLocaleString()}</td>
                        <td><div class="images-list">\${rev.images.join('<br>')}</div></td>
                        <td>\${rev.replicas}</td>
                        <td class="change-cause">\${rev.changeCause || '-'}</td>
                        <td>
                            <div class="revision-actions">
                                \${!isCurrent ? \`<button onclick="rollback(\${rev.revision})">Rollback</button>\` : ''}
                                \${compareBtn}
                            </div>
                        </td>
                    </tr>
                \`;
            }).join('');

            document.getElementById('content').innerHTML = \`
                <div class="status-section">
                    <h2>\${status.name} \${statusBadge}</h2>
                    <p>Namespace: \${status.namespace}</p>

                    <div class="progress-container">
                        <div class="progress-label">
                            <span>Rollout Progress</span>
                            <span>\${availableReplicas} / \${totalReplicas} replicas available</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill \${progressClass}" style="width: \${progressPercent}%"></div>
                            <div class="progress-text">\${Math.round(progressPercent)}%</div>
                        </div>
                    </div>

                    <div class="info-grid">
                        <div class="info-box">
                            <div class="info-label">Desired</div>
                            <div class="info-value">\${totalReplicas}</div>
                        </div>
                        <div class="info-box">
                            <div class="info-label">Updated</div>
                            <div class="info-value">\${updatedReplicas}</div>
                        </div>
                        <div class="info-box">
                            <div class="info-label">Available</div>
                            <div class="info-value">\${availableReplicas}</div>
                        </div>
                        <div class="info-box">
                            <div class="info-label">Ready</div>
                            <div class="info-value">\${status.readyReplicas}</div>
                        </div>
                        <div class="info-box">
                            <div class="info-label">Unavailable</div>
                            <div class="info-value" style="color: var(--vscode-charts-red)">
                                \${status.unavailableReplicas}
                            </div>
                        </div>
                    </div>

                    <div class="strategy-info">
                        <h3>Strategy: \${status.strategy}</h3>
                        \${status.strategy === 'RollingUpdate' ? \`
                            <p>Max Surge: \${status.maxSurge || 'N/A'}</p>
                            <p>Max Unavailable: \${status.maxUnavailable || 'N/A'}</p>
                        \` : ''}
                        \${status.progressDeadlineSeconds ? \`
                            <p>Progress Deadline: \${status.progressDeadlineSeconds}s</p>
                        \` : ''}
                    </div>

                    <div class="actions">
                        \${rolloutActions}
                        <button onclick="restart()" class="danger">Restart Rollout</button>
                    </div>

                    \${status.conditions.length > 0 ? \`
                        <div class="conditions">
                            <h3>Conditions</h3>
                            \${conditionsHtml}
                        </div>
                    \` : ''}
                </div>

                <div class="revision-history">
                    <h2>Revision History</h2>
                    \${revisions.length > 0 ? \`
                        <table class="revision-table">
                            <thead>
                                <tr>
                                    <th>Revision</th>
                                    <th>Created</th>
                                    <th>Images</th>
                                    <th>Replicas</th>
                                    <th>Change Cause</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                \${revisionsHtml}
                            </tbody>
                        </table>
                    \` : '<p>No revision history available</p>'}
                </div>
            \`;
        }
    </script>
</body>
</html>`;
    }

    public dispose() {
        RolloutManagerPanel.currentPanel = undefined;

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
