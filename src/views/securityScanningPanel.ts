import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';
import { SecurityScanner, SecurityIssue, VulnerabilityScan } from '../utils/securityScanner';

export class SecurityScanningPanel {
    private static currentPanel: SecurityScanningPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private securityScanner: SecurityScanner;
    private securityIssues: SecurityIssue[] = [];
    private imageScans: Map<string, VulnerabilityScan> = new Map();
    private isScanning: boolean = false;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private k8sClient: K8sClient
    ) {
        this.panel = panel;
        this.securityScanner = new SecurityScanner();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this.disposables
        );
        
        this.panel.webview.html = this.getHtmlContent();
        this.performSecurityScan();
    }

    public static async show(extensionUri: vscode.Uri, k8sClient: K8sClient): Promise<void> {
        const column = vscode.ViewColumn.One;

        if (SecurityScanningPanel.currentPanel) {
            SecurityScanningPanel.currentPanel.panel.reveal(column);
            SecurityScanningPanel.currentPanel.performSecurityScan();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'securityScanning',
            '🛡️ Security Scanning',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        SecurityScanningPanel.currentPanel = new SecurityScanningPanel(panel, extensionUri, k8sClient);
    }

    private async performSecurityScan(): Promise<void> {
        if (this.isScanning) {
            return;
        }

        this.isScanning = true;
        this.panel.webview.postMessage({ command: 'scanStart' });

        try {
            const hastrivy = await this.securityScanner.checkTrivyInstalled();
            
            this.securityIssues = [];
            this.imageScans.clear();

            // Scan all pods
            const pods = await this.k8sClient.getPods();
            for (const pod of pods) {
                const podIssues = await this.securityScanner.scanPodSecurityIssues(pod);
                this.securityIssues.push(...podIssues);

                // Scan container images if Trivy is available
                if (hastrivy) {
                    const images = new Set<string>();
                    pod.spec?.containers?.forEach(container => {
                        if (container.image) {
                            images.add(container.image);
                        }
                    });

                    for (const image of images) {
                        if (!this.imageScans.has(image)) {
                            const scan = await this.securityScanner.scanImage(image);
                            if (scan) {
                                this.imageScans.set(image, scan);
                            }
                        }
                    }
                }
            }

            // Scan services
            const services = await this.k8sClient.getServices();
            for (const service of services) {
                const serviceIssues = await this.securityScanner.scanServiceSecurityIssues(service);
                this.securityIssues.push(...serviceIssues);
            }

            // Scan namespaces
            const namespaces = await this.k8sClient.getNamespaces();
            for (const namespace of namespaces) {
                const nsIssues = await this.securityScanner.scanNamespaceSecurityIssues(namespace);
                this.securityIssues.push(...nsIssues);
            }

            this.updateWebview();
        } catch (error) {
            vscode.window.showErrorMessage(`Security scan failed: ${error}`);
        } finally {
            this.isScanning = false;
            this.panel.webview.postMessage({ command: 'scanComplete' });
        }
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'refresh':
                await this.performSecurityScan();
                break;
            case 'installTrivy':
                await this.showTrivyInstallInstructions();
                break;
            case 'exportReport':
                await this.exportSecurityReport();
                break;
            case 'viewIssueDetails':
                await this.viewIssueDetails(message.issue);
                break;
        }
    }

    private updateWebview(): void {
        const score = this.securityScanner.calculateSecurityScore(this.securityIssues);
        const grade = this.securityScanner.getScoreGrade(score);

        const criticalCount = this.securityIssues.filter(i => i.severity === 'critical').length;
        const highCount = this.securityIssues.filter(i => i.severity === 'high').length;
        const mediumCount = this.securityIssues.filter(i => i.severity === 'medium').length;
        const lowCount = this.securityIssues.filter(i => i.severity === 'low').length;

        const imageScans = Array.from(this.imageScans.values());
        const totalVulnerabilities = imageScans.reduce((sum, scan) => sum + scan.total, 0);
        const criticalVulns = imageScans.reduce((sum, scan) => sum + scan.critical, 0);
        const highVulns = imageScans.reduce((sum, scan) => sum + scan.high, 0);

        this.panel.webview.postMessage({
            command: 'update',
            data: {
                score,
                grade,
                issues: this.securityIssues,
                imageScans,
                stats: {
                    totalIssues: this.securityIssues.length,
                    critical: criticalCount,
                    high: highCount,
                    medium: mediumCount,
                    low: lowCount,
                    totalVulnerabilities,
                    criticalVulns,
                    highVulns,
                    imagesScanned: imageScans.length
                }
            }
        });
    }

    private async showTrivyInstallInstructions(): Promise<void> {
        const selected = await vscode.window.showInformationMessage(
            'Trivy is required for image vulnerability scanning. Would you like installation instructions?',
            'Open Documentation',
            'Copy Install Command'
        );

        if (selected === 'Open Documentation') {
            vscode.env.openExternal(vscode.Uri.parse('https://aquasecurity.github.io/trivy/latest/getting-started/installation/'));
        } else if (selected === 'Copy Install Command') {
            const command = 'curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin';
            await vscode.env.clipboard.writeText(command);
            vscode.window.showInformationMessage('Install command copied to clipboard');
        }
    }

    private async exportSecurityReport(): Promise<void> {
        try {
            const yaml = require('yaml');
            const report = {
                scanDate: new Date().toISOString(),
                securityScore: this.securityScanner.calculateSecurityScore(this.securityIssues),
                issues: this.securityIssues,
                vulnerabilities: Array.from(this.imageScans.values())
            };

            const content = yaml.stringify(report);
            
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`security-report-${new Date().toISOString().split('T')[0]}.yaml`),
                filters: {
                    'YAML': ['yaml', 'yml'],
                    'JSON': ['json']
                }
            });
            
            if (uri) {
                const encoder = new TextEncoder();
                await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
                vscode.window.showInformationMessage(`Security report exported to ${uri.fsPath}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export report: ${error}`);
        }
    }

    private async viewIssueDetails(issue: SecurityIssue): Promise<void> {
        const panel = vscode.window.createWebviewPanel(
            'issueDetails',
            `Security Issue: ${issue.title}`,
            vscode.ViewColumn.Two,
            { enableScripts: false }
        );

        panel.webview.html = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { 
                        font-family: var(--vscode-font-family); 
                        padding: 20px;
                        color: var(--vscode-foreground);
                    }
                    .severity { 
                        display: inline-block;
                        padding: 4px 12px;
                        border-radius: 4px;
                        font-weight: 600;
                        text-transform: uppercase;
                        font-size: 12px;
                    }
                    .severity.critical { background: rgba(244, 67, 54, 0.2); color: #f44336; }
                    .severity.high { background: rgba(255, 152, 0, 0.2); color: #ff9800; }
                    .severity.medium { background: rgba(255, 193, 7, 0.2); color: #ffc107; }
                    .severity.low { background: rgba(33, 150, 243, 0.2); color: #2196f3; }
                    h1 { margin-top: 0; }
                    .section { margin: 20px 0; }
                    .label { 
                        font-weight: 600; 
                        color: var(--vscode-descriptionForeground);
                        margin-bottom: 8px;
                    }
                    .content {
                        background: var(--vscode-textBlockQuote-background);
                        padding: 12px;
                        border-radius: 4px;
                        border-left: 4px solid var(--vscode-textLink-foreground);
                    }
                </style>
            </head>
            <body>
                <h1>${issue.title}</h1>
                <div class="section">
                    <div class="label">Severity</div>
                    <span class="severity ${issue.severity}">${issue.severity}</span>
                </div>
                <div class="section">
                    <div class="label">Resource</div>
                    <div>${issue.resource} (${issue.namespace})</div>
                </div>
                <div class="section">
                    <div class="label">Category</div>
                    <div>${issue.category}</div>
                </div>
                <div class="section">
                    <div class="label">Description</div>
                    <div class="content">${issue.description}</div>
                </div>
                <div class="section">
                    <div class="label">Remediation</div>
                    <div class="content">${issue.remediation}</div>
                </div>
            </body>
            </html>
        `;
    }

    private dispose(): void {
        SecurityScanningPanel.currentPanel = undefined;

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
    <title>Security Scanning</title>
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

        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .score-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 12px;
            padding: 32px;
            margin-bottom: 24px;
            color: white;
            text-align: center;
        }

        .score-value {
            font-size: 72px;
            font-weight: 700;
            margin: 16px 0;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
        }

        .score-grade {
            font-size: 48px;
            font-weight: 700;
            opacity: 0.9;
        }

        .score-label {
            font-size: 18px;
            opacity: 0.9;
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }

        .stat-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 20px;
            text-align: center;
        }

        .stat-value {
            font-size: 36px;
            font-weight: 700;
            margin: 8px 0;
        }

        .stat-value.critical { color: #f44336; }
        .stat-value.high { color: #ff9800; }
        .stat-value.medium { color: #ffc107; }
        .stat-value.low { color: #2196f3; }
        .stat-value.success { color: #4caf50; }

        .stat-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .tabs {
            display: flex;
            gap: 2px;
            margin-bottom: 24px;
            border-bottom: 2px solid var(--vscode-panel-border);
        }

        .tab {
            padding: 12px 24px;
            cursor: pointer;
            border: none;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border-bottom: 3px solid transparent;
            transition: all 0.2s;
        }

        .tab.active {
            color: var(--vscode-foreground);
            border-bottom-color: var(--vscode-textLink-foreground);
            font-weight: 600;
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        .issue-list {
            display: grid;
            gap: 12px;
        }

        .issue-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 16px;
            border-left: 4px solid;
            transition: transform 0.2s;
        }

        .issue-card:hover {
            transform: translateX(4px);
            cursor: pointer;
        }

        .issue-card.critical { border-left-color: #f44336; }
        .issue-card.high { border-left-color: #ff9800; }
        .issue-card.medium { border-left-color: #ffc107; }
        .issue-card.low { border-left-color: #2196f3; }

        .issue-header {
            display: flex;
            justify-content: space-between;
            align-items: start;
            margin-bottom: 8px;
        }

        .issue-title {
            font-weight: 600;
            font-size: 15px;
        }

        .severity-badge {
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
        }

        .severity-badge.critical {
            background: rgba(244, 67, 54, 0.2);
            color: #f44336;
        }

        .severity-badge.high {
            background: rgba(255, 152, 0, 0.2);
            color: #ff9800;
        }

        .severity-badge.medium {
            background: rgba(255, 193, 7, 0.2);
            color: #ffc107;
        }

        .severity-badge.low {
            background: rgba(33, 150, 243, 0.2);
            color: #2196f3;
        }

        .issue-meta {
            display: flex;
            gap: 16px;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            margin-top: 8px;
        }

        .issue-description {
            margin-top: 12px;
            font-size: 13px;
            line-height: 1.6;
            color: var(--vscode-descriptionForeground);
        }

        .image-scan-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 20px;
            margin-bottom: 16px;
        }

        .image-name {
            font-family: monospace;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 12px;
            word-break: break-all;
        }

        .vuln-stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
            gap: 12px;
            margin-top: 12px;
        }

        .vuln-stat {
            text-align: center;
            padding: 8px;
            border-radius: 4px;
            background: var(--vscode-textBlockQuote-background);
        }

        .scanning-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }

        .scanning-overlay.active {
            display: flex;
        }

        .scanning-message {
            background: var(--vscode-editor-background);
            padding: 40px;
            border-radius: 8px;
            text-align: center;
        }

        .spinner {
            border: 4px solid var(--vscode-panel-border);
            border-top: 4px solid var(--vscode-textLink-foreground);
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
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

        .trivy-warning {
            background: rgba(255, 152, 0, 0.1);
            border: 1px solid rgba(255, 152, 0, 0.3);
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .trivy-warning button {
            margin-left: auto;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🛡️ Security Scanning</h1>
        <div class="controls">
            <button onclick="refresh()" id="refreshBtn">🔄 Scan Now</button>
            <button class="secondary" onclick="exportReport()">💾 Export Report</button>
        </div>
    </div>

    <div id="trivyWarning" class="trivy-warning" style="display: none;">
        ⚠️ <span>Trivy not installed. Image vulnerability scanning is disabled.</span>
        <button class="secondary" onclick="installTrivy()">Install Trivy</button>
    </div>

    <div class="score-card">
        <div class="score-label">Security Score</div>
        <div class="score-value" id="scoreValue">--</div>
        <div class="score-grade" id="scoreGrade">Grade: --</div>
    </div>

    <div class="stats-grid" id="statsGrid"></div>

    <div class="tabs">
        <button class="tab active" onclick="switchTab('issues')">🔍 Security Issues</button>
        <button class="tab" onclick="switchTab('vulnerabilities')">🐛 Vulnerabilities</button>
    </div>

    <div id="issues-tab" class="tab-content active">
        <div id="issuesList" class="issue-list">
            <div class="empty-state">
                <div class="empty-state-icon">🛡️</div>
                <div>No security scan performed yet</div>
            </div>
        </div>
    </div>

    <div id="vulnerabilities-tab" class="tab-content">
        <div id="vulnerabilitiesList">
            <div class="empty-state">
                <div class="empty-state-icon">🐛</div>
                <div>No vulnerability scans available</div>
            </div>
        </div>
    </div>

    <div id="scanningOverlay" class="scanning-overlay">
        <div class="scanning-message">
            <div class="spinner"></div>
            <div>Performing security scan...</div>
            <div style="font-size: 13px; margin-top: 8px; color: var(--vscode-descriptionForeground);">
                This may take a few minutes
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentData = null;

        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'update':
                    currentData = message.data;
                    renderData();
                    break;
                case 'scanStart':
                    document.getElementById('scanningOverlay').classList.add('active');
                    document.getElementById('refreshBtn').disabled = true;
                    break;
                case 'scanComplete':
                    document.getElementById('scanningOverlay').classList.remove('active');
                    document.getElementById('refreshBtn').disabled = false;
                    break;
            }
        });

        function renderData() {
            if (!currentData) { return; }

            // Update score
            document.getElementById('scoreValue').textContent = currentData.score;
            document.getElementById('scoreGrade').textContent = \`Grade: \${currentData.grade}\`;

            // Update stats
            document.getElementById('statsGrid').innerHTML = \`
                <div class="stat-card">
                    <div class="stat-label">Total Issues</div>
                    <div class="stat-value">\${currentData.stats.totalIssues}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Critical</div>
                    <div class="stat-value critical">\${currentData.stats.critical}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">High</div>
                    <div class="stat-value high">\${currentData.stats.high}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Medium</div>
                    <div class="stat-value medium">\${currentData.stats.medium}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Low</div>
                    <div class="stat-value low">\${currentData.stats.low}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Images Scanned</div>
                    <div class="stat-value success">\${currentData.stats.imagesScanned}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Vulnerabilities</div>
                    <div class="stat-value">\${currentData.stats.totalVulnerabilities}</div>
                </div>
            \`;

            // Render issues
            renderIssues();
            
            // Render vulnerabilities
            renderVulnerabilities();

            // Show Trivy warning if no image scans
            if (currentData.imageScans.length === 0 && currentData.stats.totalIssues > 0) {
                document.getElementById('trivyWarning').style.display = 'flex';
            }
        }

        function renderIssues() {
            const container = document.getElementById('issuesList');
            
            if (!currentData.issues || currentData.issues.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">✅</div>
                        <div>No security issues found!</div>
                        <div style="font-size: 13px; margin-top: 8px;">Your cluster is secure</div>
                    </div>
                \`;
                return;
            }

            container.innerHTML = currentData.issues.map(issue => \`
                <div class="issue-card \${issue.severity}" onclick='viewIssue(\${JSON.stringify(issue)})'>
                    <div class="issue-header">
                        <div class="issue-title">\${issue.title}</div>
                        <span class="severity-badge \${issue.severity}">\${issue.severity}</span>
                    </div>
                    <div class="issue-meta">
                        <span>📦 \${issue.resource}</span>
                        <span>🏷️ \${issue.category}</span>
                        <span>📍 \${issue.namespace}</span>
                    </div>
                    <div class="issue-description">\${issue.description}</div>
                </div>
            \`).join('');
        }

        function renderVulnerabilities() {
            const container = document.getElementById('vulnerabilitiesList');
            
            if (!currentData.imageScans || currentData.imageScans.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">🐛</div>
                        <div>No vulnerability scans available</div>
                        <div style="font-size: 13px; margin-top: 8px;">Install Trivy to scan container images</div>
                    </div>
                \`;
                return;
            }

            container.innerHTML = currentData.imageScans.map(scan => \`
                <div class="image-scan-card">
                    <div class="image-name">\${scan.image}</div>
                    <div>Scanned: \${new Date(scan.scanTime).toLocaleString()}</div>
                    <div class="vuln-stats">
                        <div class="vuln-stat">
                            <div style="font-size: 24px; font-weight: 700; color: #f44336;">\${scan.critical}</div>
                            <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">CRITICAL</div>
                        </div>
                        <div class="vuln-stat">
                            <div style="font-size: 24px; font-weight: 700; color: #ff9800;">\${scan.high}</div>
                            <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">HIGH</div>
                        </div>
                        <div class="vuln-stat">
                            <div style="font-size: 24px; font-weight: 700; color: #ffc107;">\${scan.medium}</div>
                            <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">MEDIUM</div>
                        </div>
                        <div class="vuln-stat">
                            <div style="font-size: 24px; font-weight: 700; color: #2196f3;">\${scan.low}</div>
                            <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">LOW</div>
                        </div>
                        <div class="vuln-stat">
                            <div style="font-size: 24px; font-weight: 700;">\${scan.total}</div>
                            <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">TOTAL</div>
                        </div>
                    </div>
                </div>
            \`).join('');
        }

        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(\`\${tabName}-tab\`).classList.add('active');
        }

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function installTrivy() {
            vscode.postMessage({ command: 'installTrivy' });
        }

        function exportReport() {
            vscode.postMessage({ command: 'exportReport' });
        }

        function viewIssue(issue) {
            vscode.postMessage({ command: 'viewIssueDetails', issue });
        }
    </script>
</body>
</html>`;
    }
}
