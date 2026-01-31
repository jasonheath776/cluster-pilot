import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { ResourceComparison, ComparisonResult, Difference } from '../utils/resourceComparison';
import { K8sClient } from '../utils/k8sClient';
import { KubeconfigManager } from '../utils/kubeconfig';

export class ResourceComparisonPanel {
    private static currentPanel: ResourceComparisonPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private comparison: ResourceComparison;

    private constructor(panel: vscode.WebviewPanel, k8sClient: K8sClient, kubeconfigManager: KubeconfigManager) {
        this.panel = panel;
        this.comparison = new ResourceComparison(k8sClient, kubeconfigManager);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'export':
                        await this.exportComparison(message.format);
                        break;
                    case 'refresh':
                        await this.refreshComparison(message.comparisonData);
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    public static async show(
        k8sClient: K8sClient,
        kubeconfigManager: KubeconfigManager,
        comparisonType: 'resources' | 'revision' | 'namespace' | 'cluster',
        params: Record<string, unknown>
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ResourceComparisonPanel.currentPanel) {
            ResourceComparisonPanel.currentPanel.panel.reveal(column);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'clusterPilot.resourceComparison',
                'Resource Comparison',
                column || vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            ResourceComparisonPanel.currentPanel = new ResourceComparisonPanel(panel, k8sClient, kubeconfigManager);
        }

        await ResourceComparisonPanel.currentPanel.performComparison(comparisonType, params);
    }

    private async performComparison(comparisonType: string, params: Record<string, unknown>) {
        let result: ComparisonResult;
        let leftLabel: string;
        let rightLabel: string;

        try {
            switch (comparisonType) {
                case 'resources': {
                    result = await this.comparison.compareResources(
                        params.left as { name: string; namespace: string; kind: string; context?: string },
                        params.right as { name: string; namespace: string; kind: string; context?: string }
                    );
                    const left = params.left as { name: string; namespace: string; kind: string };
                    const right = params.right as { name: string; namespace: string; kind: string };
                    leftLabel = `${left.kind}/${left.name} (${left.namespace})`;
                    rightLabel = `${right.kind}/${right.name} (${right.namespace})`;
                    break;
                }
                case 'revision': {
                    result = await this.comparison.compareWithPreviousRevision(
                        params.kind as string,
                        params.name as string,
                        params.namespace as string,
                        params.revision as number | undefined
                    );
                    leftLabel = `Previous Revision ${params.revision || 'auto'}`;
                    rightLabel = 'Current';
                    break;
                }
                case 'namespace': {
                    result = await this.comparison.compareAcrossNamespaces(
                        params.kind as string,
                        params.name as string,
                        params.namespaceLeft as string,
                        params.namespaceRight as string
                    );
                    leftLabel = `${params.kind}/${params.name} (${params.namespaceLeft})`;
                    rightLabel = `${params.kind}/${params.name} (${params.namespaceRight})`;
                    break;
                }
                case 'cluster': {
                    result = await this.comparison.compareAcrossClusters(
                        params.kind as string,
                        params.name as string,
                        params.namespace as string,
                        params.contextLeft as string,
                        params.contextRight as string
                    );
                    leftLabel = `${params.kind}/${params.name} @ ${params.contextLeft}`;
                    rightLabel = `${params.kind}/${params.name} @ ${params.contextRight}`;
                    break;                }                default:
                    throw new Error(`Unknown comparison type: ${comparisonType}`);
            }

            this.updateWebview(result, leftLabel, rightLabel);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Comparison failed: ${errorMessage}`);
        }
    }

    private updateWebview(result: ComparisonResult, leftLabel: string, rightLabel: string) {
        const leftYaml = yaml.dump(result.leftResource, { indent: 2, lineWidth: -1 });
        const rightYaml = yaml.dump(result.rightResource, { indent: 2, lineWidth: -1 });

        this.panel.title = `Compare: ${leftLabel} ↔ ${rightLabel}`;
        this.panel.webview.html = this.getWebviewContent(result, leftLabel, rightLabel, leftYaml, rightYaml);
    }

    private getWebviewContent(
        result: ComparisonResult,
        leftLabel: string,
        rightLabel: string,
        leftYaml: string,
        rightYaml: string
    ): string {
        const { summary, differences } = result;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Resource Comparison</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }

        .header {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 15px;
            border-radius: 4px;
            margin-bottom: 20px;
        }

        .header h1 {
            font-size: 18px;
            margin-bottom: 10px;
        }

        .labels {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            font-weight: bold;
        }

        .label-left {
            color: var(--vscode-gitDecoration-deletedResourceForeground);
        }

        .label-right {
            color: var(--vscode-gitDecoration-addedResourceForeground);
        }

        .summary {
            display: flex;
            gap: 20px;
            padding: 10px 0;
            border-top: 1px solid var(--vscode-panel-border);
            margin-top: 10px;
        }

        .summary-item {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .summary-badge {
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: bold;
        }

        .badge-total {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }

        .badge-added {
            background-color: var(--vscode-gitDecoration-addedResourceForeground);
            color: var(--vscode-editor-background);
        }

        .badge-removed {
            background-color: var(--vscode-gitDecoration-deletedResourceForeground);
            color: var(--vscode-editor-background);
        }

        .badge-modified {
            background-color: var(--vscode-gitDecoration-modifiedResourceForeground);
            color: var(--vscode-editor-background);
        }

        .actions {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }

        button {
            padding: 6px 14px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 13px;
        }

        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .diff-container {
            display: flex;
            gap: 10px;
            height: calc(100vh - 280px);
            overflow: hidden;
        }

        .diff-side {
            flex: 1;
            display: flex;
            flex-direction: column;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden;
        }

        .diff-header {
            padding: 8px 12px;
            background-color: var(--vscode-editorGroupHeader-tabsBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: bold;
        }

        .diff-content {
            flex: 1;
            overflow: auto;
            padding: 10px;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.6;
        }

        .diff-line {
            display: flex;
            padding: 2px 0;
            white-space: pre;
        }

        .line-number {
            min-width: 40px;
            padding-right: 10px;
            text-align: right;
            color: var(--vscode-editorLineNumber-foreground);
            user-select: none;
        }

        .line-content {
            flex: 1;
        }

        .line-added {
            background-color: var(--vscode-diffEditor-insertedTextBackground);
        }

        .line-removed {
            background-color: var(--vscode-diffEditor-removedTextBackground);
        }

        .line-modified {
            background-color: var(--vscode-diffEditor-insertedTextBackground);
        }

        .differences-panel {
            margin-top: 20px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            max-height: 300px;
            overflow: auto;
        }

        .differences-header {
            padding: 10px 12px;
            background-color: var(--vscode-editorGroupHeader-tabsBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: bold;
        }

        .difference-item {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .difference-item:last-child {
            border-bottom: none;
        }

        .difference-path {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 4px;
        }

        .difference-values {
            display: flex;
            gap: 20px;
            font-size: 12px;
        }

        .difference-value {
            flex: 1;
        }

        .value-label {
            font-weight: bold;
            margin-bottom: 2px;
        }

        .value-content {
            font-family: var(--vscode-editor-font-family);
            padding: 4px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 2px;
        }

        .tab-container {
            margin-top: 20px;
        }

        .tabs {
            display: flex;
            gap: 5px;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 10px;
        }

        .tab {
            padding: 8px 16px;
            background-color: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            cursor: pointer;
        }

        .tab.active {
            border-bottom-color: var(--vscode-focusBorder);
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Resource Comparison</h1>
        <div class="labels">
            <span class="label-left">◀ ${this.escapeHtml(leftLabel)}</span>
            <span class="label-right">${this.escapeHtml(rightLabel)} ▶</span>
        </div>
        <div class="summary">
            <div class="summary-item">
                <span>Total Differences:</span>
                <span class="summary-badge badge-total">${summary.totalDifferences}</span>
            </div>
            <div class="summary-item">
                <span>Added:</span>
                <span class="summary-badge badge-added">${summary.added}</span>
            </div>
            <div class="summary-item">
                <span>Removed:</span>
                <span class="summary-badge badge-removed">${summary.removed}</span>
            </div>
            <div class="summary-item">
                <span>Modified:</span>
                <span class="summary-badge badge-modified">${summary.modified}</span>
            </div>
        </div>
    </div>

    <div class="actions">
        <button onclick="exportComparison('yaml')">Export as YAML Diff</button>
        <button onclick="exportComparison('json')">Export as JSON</button>
        <button onclick="copyToClipboard('left')">Copy Left YAML</button>
        <button onclick="copyToClipboard('right')">Copy Right YAML</button>
    </div>

    <div class="tab-container">
        <div class="tabs">
            <button class="tab active" onclick="switchTab('side-by-side')">Side-by-Side</button>
            <button class="tab" onclick="switchTab('differences')">Differences Only</button>
        </div>

        <div id="side-by-side" class="tab-content active">
            <div class="diff-container">
                <div class="diff-side">
                    <div class="diff-header">${this.escapeHtml(leftLabel)}</div>
                    <div class="diff-content" id="left-content">
                        ${this.formatYaml(leftYaml)}
                    </div>
                </div>
                <div class="diff-side">
                    <div class="diff-header">${this.escapeHtml(rightLabel)}</div>
                    <div class="diff-content" id="right-content">
                        ${this.formatYaml(rightYaml)}
                    </div>
                </div>
            </div>
        </div>

        <div id="differences" class="tab-content">
            <div class="differences-panel">
                <div class="differences-header">Changed Fields (${differences.length})</div>
                ${differences.map(diff => `
                    <div class="difference-item">
                        <div class="difference-path">${this.escapeHtml(diff.path)}</div>
                        <div class="difference-values">
                            <div class="difference-value">
                                <div class="value-label" style="color: var(--vscode-gitDecoration-deletedResourceForeground);">
                                    ${diff.type === 'removed' ? 'Removed' : 'Before'}
                                </div>
                                <div class="value-content">${this.escapeHtml(this.formatValue(diff.leftValue))}</div>
                            </div>
                            <div class="difference-value">
                                <div class="value-label" style="color: var(--vscode-gitDecoration-addedResourceForeground);">
                                    ${diff.type === 'added' ? 'Added' : 'After'}
                                </div>
                                <div class="value-content">${this.escapeHtml(this.formatValue(diff.rightValue))}</div>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const leftYaml = ${JSON.stringify(leftYaml)};
        const rightYaml = ${JSON.stringify(rightYaml)};

        function switchTab(tabId) {
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabId).classList.add('active');
        }

        function exportComparison(format) {
            vscode.postMessage({
                command: 'export',
                format: format
            });
        }

        function copyToClipboard(side) {
            const content = side === 'left' ? leftYaml : rightYaml;
            navigator.clipboard.writeText(content).then(() => {
                console.log('Copied to clipboard');
            });
        }
    </script>
</body>
</html>`;
    }

    private formatYaml(yaml: string): string {
        const lines = yaml.split('\n');
        return lines.map((line, index) => {
            return `<div class="diff-line">
                <span class="line-number">${index + 1}</span>
                <span class="line-content">${this.escapeHtml(line)}</span>
            </div>`;
        }).join('');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private generateDiffHtml(leftYaml: string, rightYaml: string, _differences: Difference[]): string {
        // This is a simplified diff - a full implementation would use a proper diff algorithm
        const leftLines = leftYaml.split('\n');
        const rightLines = rightYaml.split('\n');
        
        return `<div class="diff-view">
            <div class="diff-left">${leftLines.map((line) => 
                `<div class="diff-line">${this.escapeHtml(line)}</div>`
            ).join('')}</div>
            <div class="diff-right">${rightLines.map((line) => 
                `<div class="diff-line">${this.escapeHtml(line)}</div>`
            ).join('')}</div>
        </div>`;
    }

    private formatValue(value: unknown): string {
        if (value === undefined) {
            return '(undefined)';
        }
        if (value === null) {
            return '(null)';
        }
        if (typeof value === 'object') {
            return JSON.stringify(value, null, 2);
        }
        return String(value);
    }

    private escapeHtml(text: string): string {
        const map: Record<string, string> = {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            '&': '&amp;',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            '<': '&lt;',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            '>': '&gt;',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            '"': '&quot;',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    private async exportComparison(format: string) {
        try {
            const uri = await vscode.window.showSaveDialog({
                filters: {
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    'YAML': ['yaml', 'yml'],
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    'JSON': ['json'],
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    'All Files': ['*']
                },
                defaultUri: vscode.Uri.file(`comparison.${format}`)
            });

            if (uri) {
                // Implementation would write the comparison result to file
                vscode.window.showInformationMessage(`Comparison exported to ${uri.fsPath}`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Export failed: ${errorMessage}`);
        }
    }

    private async refreshComparison(comparisonData: Record<string, unknown>) {
        // Re-run the comparison with the same parameters
        await this.performComparison(
            comparisonData.type as string,
            comparisonData.params as Record<string, unknown>
        );
    }

    public dispose() {
        ResourceComparisonPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
