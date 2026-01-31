import * as vscode from 'vscode';
import { HelmManager, HelmRelease } from '../utils/helmManager';

export class HelmManagerPanel {
    private static currentPanel: HelmManagerPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;
    private releases: HelmRelease[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private helmManager: HelmManager
    ) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this.disposables
        );
        
        this.panel.webview.html = this.getHtmlContent();
        this.loadReleases();
    }

    public static async show(extensionUri: vscode.Uri, helmManager: HelmManager): Promise<void> {
        const column = vscode.ViewColumn.One;

        if (HelmManagerPanel.currentPanel) {
            HelmManagerPanel.currentPanel.panel.reveal(column);
            HelmManagerPanel.currentPanel.loadReleases();
            return;
        }

        // Check if Helm is installed
        const isInstalled = await helmManager.checkHelmInstalled();
        if (!isInstalled) {
            vscode.window.showErrorMessage('Helm is not installed. Please install Helm first.');
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'helmManager',
            '⎈ Helm Manager',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        HelmManagerPanel.currentPanel = new HelmManagerPanel(panel, extensionUri, helmManager);
    }

    private async loadReleases(): Promise<void> {
        try {
            this.releases = await this.helmManager.listReleases();
            this.updateWebview();
            this.startAutoRefresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load Helm releases: ${error}`);
        }
    }

    private startAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        
        this.refreshInterval = setInterval(() => {
            this.loadReleases();
        }, 15000); // Refresh every 15 seconds
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'refresh':
                await this.loadReleases();
                break;
            case 'installChart':
                await this.installChart();
                break;
            case 'upgradeRelease':
                await this.upgradeRelease(message.release);
                break;
            case 'rollbackRelease':
                await this.rollbackRelease(message.release);
                break;
            case 'uninstallRelease':
                await this.uninstallRelease(message.release);
                break;
            case 'viewValues':
                await this.viewValues(message.release);
                break;
            case 'viewHistory':
                await this.viewHistory(message.release);
                break;
            case 'addRepo':
                await this.addRepo();
                break;
            case 'updateRepos':
                await this.updateRepos();
                break;
        }
    }

    private updateWebview(): void {
        this.panel.webview.postMessage({
            command: 'update',
            releases: this.releases,
            stats: this.calculateStats()
        });
    }

    private calculateStats() {
        const total = this.releases.length;
        const deployed = this.releases.filter(r => r.status === 'deployed').length;
        const failed = this.releases.filter(r => r.status === 'failed').length;
        const pending = this.releases.filter(r => r.status === 'pending-install' || r.status === 'pending-upgrade').length;
        const namespaces = new Set(this.releases.map(r => r.namespace)).size;

        return { total, deployed, failed, pending, namespaces };
    }

    private async installChart(): Promise<void> {
        const chartName = await vscode.window.showInputBox({
            prompt: 'Enter chart name (e.g., bitnami/nginx)',
            placeHolder: 'bitnami/nginx'
        });
        if (!chartName) { return; }

        const releaseName = await vscode.window.showInputBox({
            prompt: 'Enter release name',
            placeHolder: 'my-release'
        });
        if (!releaseName) { return; }

        const namespace = await vscode.window.showInputBox({
            prompt: 'Enter namespace',
            placeHolder: 'default',
            value: 'default'
        });
        if (!namespace) { return; }

        try {
            await this.helmManager.installChart(releaseName, chartName, namespace);
            vscode.window.showInformationMessage(`Installed ${releaseName} successfully`);
            this.loadReleases();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to install chart: ${error}`);
        }
    }

    private async upgradeRelease(release: HelmRelease): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Upgrade ${release.name} in ${release.namespace}?`,
            { modal: true },
            'Upgrade'
        );

        if (confirm === 'Upgrade') {
            try {
                await this.helmManager.upgradeRelease(release.name, release.chart, release.namespace);
                vscode.window.showInformationMessage(`Upgraded ${release.name} successfully`);
                this.loadReleases();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to upgrade release: ${error}`);
            }
        }
    }

    private async rollbackRelease(release: HelmRelease): Promise<void> {
        const revision = await vscode.window.showInputBox({
            prompt: `Rollback ${release.name} to revision (leave empty for previous)`,
            placeHolder: '0'
        });

        try {
            const rev = revision && revision !== '0' ? parseInt(revision) : undefined;
            await this.helmManager.rollbackRelease(release.name, release.namespace, rev);
            vscode.window.showInformationMessage(`Rolled back ${release.name} successfully`);
            this.loadReleases();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to rollback release: ${error}`);
        }
    }

    private async uninstallRelease(release: HelmRelease): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Uninstall ${release.name} from ${release.namespace}?`,
            { modal: true },
            'Uninstall'
        );

        if (confirm === 'Uninstall') {
            try {
                await this.helmManager.uninstallRelease(release.name, release.namespace);
                vscode.window.showInformationMessage(`Uninstalled ${release.name} successfully`);
                this.loadReleases();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to uninstall release: ${error}`);
            }
        }
    }

    private async viewValues(release: HelmRelease): Promise<void> {
        try {
            const values = await this.helmManager.getReleaseValues(release.name, release.namespace);
            const doc = await vscode.workspace.openTextDocument({
                language: 'yaml',
                content: values
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get values: ${error}`);
        }
    }

    private async viewHistory(release: HelmRelease): Promise<void> {
        try {
            const history = await this.helmManager.getReleaseHistory(release.name, release.namespace);
            const yaml = require('yaml');
            const doc = await vscode.workspace.openTextDocument({
                language: 'yaml',
                content: yaml.stringify(history)
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get history: ${error}`);
        }
    }

    private async addRepo(): Promise<void> {
        const repoName = await vscode.window.showInputBox({
            prompt: 'Enter repository name',
            placeHolder: 'bitnami'
        });
        if (!repoName) { return; }

        const repoUrl = await vscode.window.showInputBox({
            prompt: 'Enter repository URL',
            placeHolder: 'https://charts.bitnami.com/bitnami'
        });
        if (!repoUrl) { return; }

        try {
            await this.helmManager.addRepo(repoName, repoUrl);
            vscode.window.showInformationMessage(`Added repository ${repoName} successfully`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add repository: ${error}`);
        }
    }

    private async updateRepos(): Promise<void> {
        try {
            await this.helmManager.updateRepos();
            vscode.window.showInformationMessage('Updated repositories successfully');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update repositories: ${error}`);
        }
    }

    private dispose(): void {
        HelmManagerPanel.currentPanel = undefined;

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
    <title>Helm Manager</title>
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
            margin-bottom: 24px;
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

        .controls {
            display: flex;
            gap: 12px;
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

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }

        .stat-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 16px;
        }

        .stat-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }

        .stat-value {
            font-size: 28px;
            font-weight: 600;
        }

        .stat-value.success { color: #4caf50; }
        .stat-value.warning { color: #ff9800; }
        .stat-value.error { color: #f44336; }

        .search-box {
            width: 100%;
            padding: 10px 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 14px;
            margin-bottom: 20px;
        }

        .releases-grid {
            display: grid;
            gap: 16px;
        }

        .release-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 20px;
            transition: border-color 0.2s;
        }

        .release-card:hover {
            border-color: var(--vscode-focusBorder);
        }

        .release-header {
            display: flex;
            justify-content: space-between;
            align-items: start;
            margin-bottom: 16px;
        }

        .release-title {
            flex: 1;
        }

        .release-name {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 4px;
        }

        .release-chart {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }

        .release-actions {
            display: flex;
            gap: 8px;
        }

        .release-actions button {
            padding: 6px 12px;
            font-size: 12px;
        }

        .release-details {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 16px;
            margin-bottom: 16px;
        }

        .detail-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .detail-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .detail-value {
            font-size: 14px;
            font-weight: 500;
        }

        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .badge.deployed {
            background: rgba(76, 175, 80, 0.2);
            color: #4caf50;
        }

        .badge.failed {
            background: rgba(244, 67, 54, 0.2);
            color: #f44336;
        }

        .badge.pending {
            background: rgba(255, 152, 0, 0.2);
            color: #ff9800;
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
    </style>
</head>
<body>
    <div class="header">
        <h1>⎈ Helm Manager</h1>
        <div class="controls">
            <button onclick="installChart()">➕ Install Chart</button>
            <button class="secondary" onclick="addRepo()">📦 Add Repo</button>
            <button class="secondary" onclick="updateRepos()">🔄 Update Repos</button>
            <button class="secondary" onclick="refresh()">🔄 Refresh</button>
        </div>
    </div>

    <div id="stats" class="stats"></div>

    <input 
        type="text" 
        class="search-box" 
        placeholder="Search releases by name, namespace, or chart..." 
        oninput="filterReleases(this.value)"
    />

    <div id="content" class="loading">
        Loading Helm releases...
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allReleases = [];

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'update') {
                allReleases = message.releases || [];
                renderReleases(allReleases);
                renderStats(message.stats);
            }
        });

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function installChart() {
            vscode.postMessage({ command: 'installChart' });
        }

        function addRepo() {
            vscode.postMessage({ command: 'addRepo' });
        }

        function updateRepos() {
            vscode.postMessage({ command: 'updateRepos' });
        }

        function filterReleases(searchTerm) {
            const filtered = allReleases.filter(release => {
                const term = searchTerm.toLowerCase();
                return release.name.toLowerCase().includes(term) ||
                       release.namespace.toLowerCase().includes(term) ||
                       release.chart.toLowerCase().includes(term);
            });
            renderReleases(filtered);
        }

        function renderReleases(releases) {
            const content = document.getElementById('content');
            
            if (releases.length === 0) {
                content.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">⎈</div>
                        <div class="empty-state-text">No Helm releases found</div>
                        <div class="empty-state-subtext">Install a chart to get started</div>
                    </div>
                \`;
                return;
            }

            content.className = 'releases-grid';
            content.innerHTML = releases.map(release => \`
                <div class="release-card">
                    <div class="release-header">
                        <div class="release-title">
                            <div class="release-name">\${release.name}</div>
                            <div class="release-chart">\${release.chart}</div>
                        </div>
                        <div class="release-actions">
                            <button class="secondary" onclick='upgradeRelease(\${JSON.stringify(release)})'>⬆️ Upgrade</button>
                            <button class="secondary" onclick='rollbackRelease(\${JSON.stringify(release)})'>↩️ Rollback</button>
                            <button class="secondary" onclick='viewValues(\${JSON.stringify(release)})'>📄 Values</button>
                            <button class="secondary" onclick='viewHistory(\${JSON.stringify(release)})'>📜 History</button>
                            <button class="secondary" onclick='uninstallRelease(\${JSON.stringify(release)})'>🗑️ Uninstall</button>
                        </div>
                    </div>

                    <div class="release-details">
                        <div class="detail-item">
                            <div class="detail-label">Status</div>
                            <div class="detail-value">
                                <span class="badge \${release.status}">\${release.status}</span>
                            </div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Namespace</div>
                            <div class="detail-value">\${release.namespace}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Revision</div>
                            <div class="detail-value">\${release.revision}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">App Version</div>
                            <div class="detail-value">\${release.appVersion}</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">Updated</div>
                            <div class="detail-value">\${new Date(release.updated).toLocaleString()}</div>
                        </div>
                    </div>
                </div>
            \`).join('');
        }

        function renderStats(stats) {
            document.getElementById('stats').innerHTML = \`
                <div class="stat-card">
                    <div class="stat-label">Total Releases</div>
                    <div class="stat-value">\${stats.total}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Deployed</div>
                    <div class="stat-value success">\${stats.deployed}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Failed</div>
                    <div class="stat-value error">\${stats.failed}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Pending</div>
                    <div class="stat-value warning">\${stats.pending}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Namespaces</div>
                    <div class="stat-value">\${stats.namespaces}</div>
                </div>
            \`;
        }

        function upgradeRelease(release) {
            vscode.postMessage({ command: 'upgradeRelease', release });
        }

        function rollbackRelease(release) {
            vscode.postMessage({ command: 'rollbackRelease', release });
        }

        function uninstallRelease(release) {
            vscode.postMessage({ command: 'uninstallRelease', release });
        }

        function viewValues(release) {
            vscode.postMessage({ command: 'viewValues', release });
        }

        function viewHistory(release) {
            vscode.postMessage({ command: 'viewHistory', release });
        }
    </script>
</body>
</html>`;
    }
}
