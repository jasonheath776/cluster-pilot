import * as vscode from 'vscode';
import { K8sClient } from '../utils/k8sClient';

export class AdvancedLogViewer {
    private panel: vscode.WebviewPanel;
    private logStream?: NodeJS.Timeout;
    private isStreaming = false;
    private currentLogs: string[] = [];
    private maxLines = 5000;

    constructor(
        private context: vscode.ExtensionContext,
        private k8sClient: K8sClient,
        private podName: string,
        private namespace: string,
        private containerName?: string
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'advancedLogViewer',
            `Logs: ${podName}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getWebviewContent();
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            undefined,
            context.subscriptions
        );

        this.panel.onDidDispose(() => {
            this.stopStreaming();
        });

        // Load initial logs
        this.loadLogs(100);
    }

    private async handleMessage(message: { 
        command: string; 
        lines?: number; 
        filter?: string;
        filterType?: 'contains' | 'regex' | 'level';
        follow?: boolean;
        since?: string;
    }) {
        switch (message.command) {
            case 'refresh':
                await this.loadLogs(message.lines || 100);
                break;
            case 'toggleStream':
                if (this.isStreaming) {
                    this.stopStreaming();
                } else {
                    this.startStreaming();
                }
                break;
            case 'clear':
                this.currentLogs = [];
                this.updateLogs();
                break;
            case 'download':
                this.downloadLogs();
                break;
            case 'loadMore':
                await this.loadLogs(message.lines || 500);
                break;
        }
    }

    private async loadLogs(tailLines: number): Promise<void> {
        try {
            const logs = await this.k8sClient.getLogs(
                this.namespace,
                this.podName,
                this.containerName,
                tailLines
            );
            
            this.currentLogs = logs.split('\n');
            this.updateLogs();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load logs: ${error}`);
        }
    }

    private startStreaming(): void {
        this.isStreaming = true;
        this.panel.webview.postMessage({ 
            command: 'streamingStatus', 
            streaming: true 
        });

        // Poll for new logs every 2 seconds
        this.logStream = setInterval(async () => {
            try {
                const logs = await this.k8sClient.getLogs(
                    this.namespace,
                    this.podName,
                    this.containerName,
                    50  // Get last 50 lines
                );
                
                const newLines = logs.split('\n');
                
                // Append new unique lines
                const lastLine = this.currentLogs[this.currentLogs.length - 1];
                const newStartIndex = newLines.findIndex(line => line === lastLine);
                
                if (newStartIndex >= 0 && newStartIndex < newLines.length - 1) {
                    const trulyNewLines = newLines.slice(newStartIndex + 1);
                    this.currentLogs.push(...trulyNewLines);
                    
                    // Trim if too many lines
                    if (this.currentLogs.length > this.maxLines) {
                        this.currentLogs = this.currentLogs.slice(-this.maxLines);
                    }
                    
                    this.updateLogs();
                }
            } catch (error) {
                console.error('Error streaming logs:', error);
            }
        }, 2000);
    }

    private stopStreaming(): void {
        this.isStreaming = false;
        if (this.logStream) {
            clearInterval(this.logStream);
            this.logStream = undefined;
        }
        this.panel.webview.postMessage({ 
            command: 'streamingStatus', 
            streaming: false 
        });
    }

    private updateLogs(): void {
        this.panel.webview.postMessage({
            command: 'updateLogs',
            logs: this.currentLogs
        });
    }

    private async downloadLogs(): Promise<void> {
        const content = this.currentLogs.join('\n');
        const fileName = `${this.podName}-${this.containerName || 'logs'}-${Date.now()}.log`;
        
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(fileName),
            filters: {
                'Log Files': ['log', 'txt']
            }
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            vscode.window.showInformationMessage(`Logs saved to ${uri.fsPath}`);
        }
    }

    private getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Advanced Log Viewer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }
        .toolbar {
            display: flex;
            gap: 10px;
            padding: 10px;
            background-color: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            align-items: center;
            flex-wrap: wrap;
        }
        .toolbar-group {
            display: flex;
            gap: 5px;
            align-items: center;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 12px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button.active {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        input, select {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 5px 8px;
            border-radius: 3px;
            font-size: 12px;
        }
        input:focus, select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .filter-input {
            min-width: 250px;
            flex: 1;
        }
        .log-container {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            font-family: 'Consolas', 'Courier New', monospace;
            font-size: 12px;
            line-height: 1.4;
        }
        .log-line {
            white-space: pre-wrap;
            word-break: break-all;
            padding: 2px 5px;
            border-left: 3px solid transparent;
        }
        .log-line:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .log-line.error {
            color: var(--vscode-errorForeground);
            border-left-color: var(--vscode-errorForeground);
            background-color: rgba(255, 0, 0, 0.1);
        }
        .log-line.warn {
            color: var(--vscode-notificationsWarningIcon-foreground);
            border-left-color: var(--vscode-notificationsWarningIcon-foreground);
            background-color: rgba(255, 165, 0, 0.1);
        }
        .log-line.info {
            color: var(--vscode-notificationsInfoIcon-foreground);
            border-left-color: var(--vscode-notificationsInfoIcon-foreground);
        }
        .log-line.debug {
            color: var(--vscode-descriptionForeground);
            opacity: 0.8;
        }
        .log-line.highlight {
            background-color: rgba(255, 255, 0, 0.2);
        }
        .status-bar {
            padding: 5px 10px;
            background-color: var(--vscode-statusBar-background);
            color: var(--vscode-statusBar-foreground);
            border-top: 1px solid var(--vscode-panel-border);
            font-size: 11px;
            display: flex;
            justify-content: space-between;
        }
        .streaming-indicator {
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .streaming-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: var(--vscode-charts-green);
            animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }
        .stats {
            display: flex;
            gap: 15px;
        }
        label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <div class="toolbar-group">
            <button id="refreshBtn" title="Refresh logs">🔄 Refresh</button>
            <button id="streamBtn" title="Toggle live streaming">▶️ Stream</button>
            <button id="clearBtn" title="Clear logs">🗑️ Clear</button>
            <button id="downloadBtn" title="Download logs">💾 Download</button>
        </div>
        <div class="toolbar-group">
            <label>Lines:</label>
            <select id="linesSelect">
                <option value="100">100</option>
                <option value="500" selected>500</option>
                <option value="1000">1000</option>
                <option value="5000">5000</option>
                <option value="all">All</option>
            </select>
        </div>
        <div class="toolbar-group" style="flex: 1;">
            <label>Filter:</label>
            <input type="text" id="filterInput" class="filter-input" placeholder="Search logs..." />
            <select id="filterType">
                <option value="contains">Contains</option>
                <option value="regex">Regex</option>
                <option value="level">Log Level</option>
            </select>
        </div>
    </div>
    
    <div class="log-container" id="logContainer"></div>
    
    <div class="status-bar">
        <div class="stats">
            <span>Lines: <strong id="lineCount">0</strong></span>
            <span>Filtered: <strong id="filteredCount">0</strong></span>
        </div>
        <div id="streamingStatus"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allLogs = [];
        let isStreaming = false;
        
        const logContainer = document.getElementById('logContainer');
        const filterInput = document.getElementById('filterInput');
        const filterType = document.getElementById('filterType');
        const streamBtn = document.getElementById('streamBtn');
        const lineCount = document.getElementById('lineCount');
        const filteredCount = document.getElementById('filteredCount');
        const streamingStatus = document.getElementById('streamingStatus');
        const linesSelect = document.getElementById('linesSelect');

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateLogs':
                    allLogs = message.logs || [];
                    renderLogs();
                    break;
                case 'streamingStatus':
                    isStreaming = message.streaming;
                    updateStreamingUI();
                    break;
            }
        });

        function renderLogs() {
            const filterText = filterInput.value.toLowerCase();
            const filterMode = filterType.value;
            
            let filteredLogs = allLogs;
            
            if (filterText) {
                filteredLogs = allLogs.filter(line => {
                    switch (filterMode) {
                        case 'contains':
                            return line.toLowerCase().includes(filterText);
                        case 'regex':
                            try {
                                return new RegExp(filterText, 'i').test(line);
                            } catch {
                                return true;
                            }
                        case 'level':
                            const level = filterText.toUpperCase();
                            return line.includes(level);
                        default:
                            return true;
                    }
                });
            }
            
            const html = filteredLogs.map((line, index) => {
                const level = detectLogLevel(line);
                const isHighlight = filterText && line.toLowerCase().includes(filterText);
                return \`<div class="log-line \${level} \${isHighlight ? 'highlight' : ''}" data-line="\${index}">\${escapeHtml(line)}</div>\`;
            }).join('');
            
            const wasAtBottom = isScrolledToBottom();
            logContainer.innerHTML = html;
            
            if (wasAtBottom || isStreaming) {
                scrollToBottom();
            }
            
            lineCount.textContent = allLogs.length;
            filteredCount.textContent = filteredLogs.length;
        }

        function detectLogLevel(line) {
            const upperLine = line.toUpperCase();
            if (upperLine.includes('ERROR') || upperLine.includes('FATAL') || upperLine.includes('SEVERE')) {
                return 'error';
            }
            if (upperLine.includes('WARN') || upperLine.includes('WARNING')) {
                return 'warn';
            }
            if (upperLine.includes('INFO')) {
                return 'info';
            }
            if (upperLine.includes('DEBUG') || upperLine.includes('TRACE')) {
                return 'debug';
            }
            return '';
        }

        function isScrolledToBottom() {
            const threshold = 100;
            return logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < threshold;
        }

        function scrollToBottom() {
            logContainer.scrollTop = logContainer.scrollHeight;
        }

        function updateStreamingUI() {
            if (isStreaming) {
                streamBtn.textContent = '⏸️ Pause';
                streamBtn.classList.add('active');
                streamingStatus.innerHTML = '<div class="streaming-indicator"><div class="streaming-dot"></div>Live streaming</div>';
            } else {
                streamBtn.textContent = '▶️ Stream';
                streamBtn.classList.remove('active');
                streamingStatus.innerHTML = '';
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Event listeners
        document.getElementById('refreshBtn').addEventListener('click', () => {
            const lines = linesSelect.value === 'all' ? 10000 : parseInt(linesSelect.value);
            vscode.postMessage({ command: 'refresh', lines });
        });

        streamBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'toggleStream' });
        });

        document.getElementById('clearBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'clear' });
        });

        document.getElementById('downloadBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'download' });
        });

        filterInput.addEventListener('input', renderLogs);
        filterType.addEventListener('change', renderLogs);

        // Auto-scroll toggle on user scroll
        let userScrolling = false;
        logContainer.addEventListener('scroll', () => {
            userScrolling = !isScrolledToBottom();
        });

        // Initial load
        vscode.postMessage({ command: 'refresh', lines: 500 });
    </script>
</body>
</html>`;
    }
}
