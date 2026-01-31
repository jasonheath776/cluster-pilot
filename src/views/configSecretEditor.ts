import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';

type ResourceType = 'ConfigMap' | 'Secret';

export class ConfigSecretEditorPanel {
    public static currentPanels: Map<string, ConfigSecretEditorPanel> = new Map();
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private resourceType: ResourceType;
    private resourceName: string;
    private namespace: string;

    public static createOrShow(
        extensionUri: vscode.Uri,
        k8sClient: K8sClient,
        resourceType: ResourceType,
        resourceName: string,
        namespace: string
    ) {
        const key = `${resourceType}-${namespace}-${resourceName}`;
        
        if (ConfigSecretEditorPanel.currentPanels.has(key)) {
            const existing = ConfigSecretEditorPanel.currentPanels.get(key);
            existing?.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'configSecretEditor',
            `${resourceType}: ${resourceName}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const editor = new ConfigSecretEditorPanel(
            panel,
            extensionUri,
            k8sClient,
            resourceType,
            resourceName,
            namespace
        );
        
        ConfigSecretEditorPanel.currentPanels.set(key, editor);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly k8sClient: K8sClient,
        resourceType: ResourceType,
        resourceName: string,
        namespace: string
    ) {
        this.panel = panel;
        this.resourceType = resourceType;
        this.resourceName = resourceName;
        this.namespace = namespace;
        
        this.panel.webview.html = this.getHtmlContent();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'load':
                        await this.loadResource();
                        break;
                    case 'save':
                        await this.saveResource(message.data);
                        break;
                    case 'addEntry':
                        await this.addEntry(message.key, message.value);
                        break;
                    case 'deleteEntry':
                        await this.deleteEntry(message.key);
                        break;
                    case 'decode':
                        this.panel.webview.postMessage({
                            command: 'decoded',
                            key: message.key,
                            value: this.decodeBase64(message.value)
                        });
                        break;
                    case 'encode':
                        this.panel.webview.postMessage({
                            command: 'encoded',
                            key: message.key,
                            value: this.encodeBase64(message.value)
                        });
                        break;
                }
            },
            null,
            this.disposables
        );

        this.loadResource();
    }

    private async loadResource() {
        try {
            let resource: k8s.V1ConfigMap | k8s.V1Secret | undefined;

            if (this.resourceType === 'ConfigMap') {
                const configmaps = await this.k8sClient.getConfigMaps(this.namespace);
                resource = configmaps.find(cm => cm.metadata?.name === this.resourceName);
            } else {
                const secrets = await this.k8sClient.getSecrets(this.namespace);
                resource = secrets.find(s => s.metadata?.name === this.resourceName);
            }

            if (!resource) {
                vscode.window.showErrorMessage(`${this.resourceType} ${this.resourceName} not found`);
                return;
            }

            const data: Record<string, string> = {};
            
            if (this.resourceType === 'ConfigMap') {
                const cm = resource as k8s.V1ConfigMap;
                Object.assign(data, cm.data || {});
            } else {
                const secret = resource as k8s.V1Secret;
                // Decode secret data from base64
                if (secret.data) {
                    for (const [key, value] of Object.entries(secret.data)) {
                        data[key] = this.decodeBase64(value);
                    }
                }
            }

            this.panel.webview.postMessage({
                command: 'resourceLoaded',
                resourceType: this.resourceType,
                name: this.resourceName,
                namespace: this.namespace,
                data: data,
                labels: resource.metadata?.labels || {},
                annotations: resource.metadata?.annotations || {}
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load ${this.resourceType}: ${error}`);
        }
    }

    private async saveResource(updatedData: Record<string, string>) {
        try {
            let resource: k8s.V1ConfigMap | k8s.V1Secret | undefined;

            if (this.resourceType === 'ConfigMap') {
                const configmaps = await this.k8sClient.getConfigMaps(this.namespace);
                resource = configmaps.find(cm => cm.metadata?.name === this.resourceName);
                
                if (resource) {
                    (resource as k8s.V1ConfigMap).data = updatedData;
                }
            } else {
                const secrets = await this.k8sClient.getSecrets(this.namespace);
                resource = secrets.find(s => s.metadata?.name === this.resourceName);
                
                if (resource) {
                    // Encode data to base64 for secrets
                    const encodedData: Record<string, string> = {};
                    for (const [key, value] of Object.entries(updatedData)) {
                        encodedData[key] = this.encodeBase64(value);
                    }
                    (resource as k8s.V1Secret).data = encodedData;
                }
            }

            if (!resource) {
                vscode.window.showErrorMessage(`${this.resourceType} not found`);
                return;
            }

            // Update the resource
            if (this.resourceType === 'ConfigMap') {
                await this.k8sClient.updateConfigMap(
                    this.resourceName,
                    this.namespace,
                    resource as k8s.V1ConfigMap
                );
            } else {
                await this.k8sClient.updateSecret(
                    this.resourceName,
                    this.namespace,
                    resource as k8s.V1Secret
                );
            }

            vscode.window.showInformationMessage(`${this.resourceType} ${this.resourceName} updated successfully`);
            this.panel.webview.postMessage({ command: 'saved' });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save ${this.resourceType}: ${error}`);
        }
    }

    private async addEntry(key: string, value: string) {
        // The addEntry is handled by the save operation
        this.panel.webview.postMessage({
            command: 'entryAdded',
            key: key,
            value: value
        });
    }

    private async deleteEntry(key: string) {
        // The deleteEntry is handled by the save operation
        this.panel.webview.postMessage({
            command: 'entryDeleted',
            key: key
        });
    }

    private decodeBase64(encoded: string): string {
        try {
            return Buffer.from(encoded, 'base64').toString('utf-8');
        } catch {
            return encoded;
        }
    }

    private encodeBase64(decoded: string): string {
        return Buffer.from(decoded).toString('base64');
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ConfigMap/Secret Editor</title>
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
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .header-info {
            flex: 1;
        }
        .header-info h1 {
            margin: 0 0 5px 0;
            font-size: 24px;
        }
        .header-info .meta {
            font-size: 12px;
            opacity: 0.8;
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
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .add-entry {
            margin-bottom: 20px;
            padding: 15px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
        }
        .add-entry h3 {
            margin-top: 0;
        }
        .add-entry-form {
            display: grid;
            grid-template-columns: 1fr 2fr auto;
            gap: 10px;
            align-items: start;
        }
        input, textarea {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 6px 8px;
            font-family: var(--vscode-font-family);
            font-size: 13px;
        }
        textarea {
            min-height: 60px;
            resize: vertical;
            font-family: var(--vscode-editor-font-family);
        }
        .entries {
            margin-top: 20px;
        }
        .entry {
            margin-bottom: 15px;
            padding: 15px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            border-left: 3px solid var(--vscode-charts-blue);
        }
        .entry-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .entry-key {
            font-weight: bold;
            font-family: var(--vscode-editor-font-family);
            font-size: 14px;
        }
        .entry-actions {
            display: flex;
            gap: 5px;
        }
        .entry-actions button {
            padding: 4px 8px;
            font-size: 12px;
        }
        .entry-value {
            background-color: var(--vscode-editor-background);
            padding: 10px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            white-space: pre-wrap;
            word-break: break-all;
            max-height: 300px;
            overflow-y: auto;
        }
        .entry-value.editable {
            border: 1px solid var(--vscode-input-border);
            outline: none;
            cursor: text;
        }
        .entry-value.editable:focus {
            border-color: var(--vscode-focusBorder);
        }
        .no-entries {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
        .secret-badge {
            display: inline-block;
            padding: 2px 8px;
            background-color: var(--vscode-charts-orange);
            color: white;
            border-radius: 3px;
            font-size: 11px;
            margin-left: 10px;
        }
        .info-section {
            margin-bottom: 20px;
            padding: 10px 15px;
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-charts-green);
            border-radius: 4px;
        }
        .info-section h4 {
            margin: 0 0 5px 0;
            font-size: 12px;
            opacity: 0.8;
        }
        .label-list {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
        }
        .label {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 11px;
            font-family: var(--vscode-editor-font-family);
        }
        .validation-error {
            color: var(--vscode-errorForeground);
            font-size: 12px;
            margin-top: 5px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-info">
            <h1 id="resourceTitle">Loading...</h1>
            <div class="meta">
                <span id="namespace"></span> | <span id="resourceType"></span>
            </div>
        </div>
        <div class="actions">
            <button onclick="save()">Save Changes</button>
            <button class="secondary" onclick="reload()">Reload</button>
        </div>
    </div>

    <div id="metadataSection" style="display: none;">
        <div class="info-section">
            <h4>Labels</h4>
            <div class="label-list" id="labelList">-</div>
        </div>
    </div>

    <div class="add-entry">
        <h3>Add New Entry</h3>
        <div class="add-entry-form">
            <input type="text" id="newKey" placeholder="Key" />
            <textarea id="newValue" placeholder="Value"></textarea>
            <button onclick="addEntry()">Add</button>
        </div>
        <div id="addError" class="validation-error" style="display: none;"></div>
    </div>

    <div class="entries" id="entriesContainer">
        <div class="no-entries">Loading...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentData = {};
        let currentResourceType = '';
        let isSecret = false;

        function save() {
            // Collect all current values from the UI
            const entries = document.querySelectorAll('.entry');
            const data = {};
            
            entries.forEach(entry => {
                const key = entry.dataset.key;
                const valueElement = entry.querySelector('.entry-value');
                data[key] = valueElement.textContent;
            });

            vscode.postMessage({
                command: 'save',
                data: data
            });
        }

        function reload() {
            vscode.postMessage({ command: 'load' });
        }

        function addEntry() {
            const keyInput = document.getElementById('newKey');
            const valueInput = document.getElementById('newValue');
            const errorDiv = document.getElementById('addError');
            
            const key = keyInput.value.trim();
            const value = valueInput.value;

            // Validation
            if (!key) {
                errorDiv.textContent = 'Key is required';
                errorDiv.style.display = 'block';
                return;
            }

            if (currentData[key]) {
                errorDiv.textContent = 'Key already exists';
                errorDiv.style.display = 'block';
                return;
            }

            errorDiv.style.display = 'none';

            // Add to current data
            currentData[key] = value;
            renderEntries();

            // Clear inputs
            keyInput.value = '';
            valueInput.value = '';
        }

        function deleteEntry(key) {
            if (confirm(\`Delete entry "\${key}"?\`)) {
                delete currentData[key];
                renderEntries();
            }
        }

        function copyValue(key) {
            const value = currentData[key];
            navigator.clipboard.writeText(value).then(() => {
                // Could show a toast notification here
            });
        }

        function toggleBase64(key, button) {
            const valueElement = button.closest('.entry').querySelector('.entry-value');
            const currentValue = valueElement.textContent;
            
            if (button.textContent === 'Decode') {
                vscode.postMessage({
                    command: 'decode',
                    key: key,
                    value: currentValue
                });
            } else {
                vscode.postMessage({
                    command: 'encode',
                    key: key,
                    value: currentValue
                });
            }
        }

        function renderEntries() {
            const container = document.getElementById('entriesContainer');
            
            if (Object.keys(currentData).length === 0) {
                container.innerHTML = '<div class="no-entries">No entries. Add one above.</div>';
                return;
            }

            const sortedKeys = Object.keys(currentData).sort();
            
            container.innerHTML = sortedKeys.map(key => {
                const value = currentData[key];
                const escapedValue = escapeHtml(value);
                
                return \`
                    <div class="entry" data-key="\${escapeHtml(key)}">
                        <div class="entry-header">
                            <span class="entry-key">\${escapeHtml(key)}</span>
                            <div class="entry-actions">
                                <button onclick="copyValue('\${escapeHtml(key)}')">Copy</button>
                                \${isSecret ? \`<button onclick="toggleBase64('\${escapeHtml(key)}', this)">Decode</button>\` : ''}
                                <button onclick="deleteEntry('\${escapeHtml(key)}')">Delete</button>
                            </div>
                        </div>
                        <div class="entry-value editable" contenteditable="true" 
                             oninput="updateValue('\${escapeHtml(key)}', this)">\${escapedValue}</div>
                    </div>
                \`;
            }).join('');
        }

        function updateValue(key, element) {
            currentData[key] = element.textContent;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'resourceLoaded':
                    currentData = message.data;
                    currentResourceType = message.resourceType;
                    isSecret = currentResourceType === 'Secret';
                    
                    document.getElementById('resourceTitle').textContent = message.name;
                    document.getElementById('namespace').textContent = message.namespace;
                    document.getElementById('resourceType').textContent = message.resourceType;
                    
                    if (isSecret) {
                        document.getElementById('resourceTitle').innerHTML = 
                            message.name + '<span class="secret-badge">SENSITIVE</span>';
                    }
                    
                    // Render labels
                    const labelList = document.getElementById('labelList');
                    const labels = message.labels;
                    if (Object.keys(labels).length > 0) {
                        labelList.innerHTML = Object.entries(labels)
                            .map(([k, v]) => \`<span class="label">\${k}=\${v}</span>\`)
                            .join('');
                        document.getElementById('metadataSection').style.display = 'block';
                    }
                    
                    renderEntries();
                    break;
                    
                case 'saved':
                    // Show success indicator
                    break;
                    
                case 'decoded':
                    currentData[message.key] = message.value;
                    renderEntries();
                    break;
                    
                case 'encoded':
                    currentData[message.key] = message.value;
                    renderEntries();
                    break;
            }
        });

        // Initial load
        vscode.postMessage({ command: 'load' });
    </script>
</body>
</html>`;
    }

    public dispose() {
        const key = `${this.resourceType}-${this.namespace}-${this.resourceName}`;
        ConfigSecretEditorPanel.currentPanels.delete(key);

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
