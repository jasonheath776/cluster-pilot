import * as vscode from 'vscode';
import { resourceTemplates, getAllCategories } from '../templates/resourceTemplates';

export class TemplateSelectorPanel {
    private panel: vscode.WebviewPanel;

    constructor(private context: vscode.ExtensionContext) {
        this.panel = vscode.window.createWebviewPanel(
            'templateSelector',
            'Resource Templates',
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
    }

    private async handleMessage(message: { command: string; template?: string; name?: string }) {
        switch (message.command) {
            case 'selectTemplate':
                if (message.template && message.name) {
                    await this.createResourceFromTemplate(message.template, message.name);
                }
                break;
        }
    }

    private async createResourceFromTemplate(template: string, name: string): Promise<void> {
        const doc = await vscode.workspace.openTextDocument({
            content: template,
            language: 'yaml'
        });
        
        await vscode.window.showTextDocument(doc, {
            preview: false,
            viewColumn: vscode.ViewColumn.Beside
        });

        vscode.window.showInformationMessage(`Created ${name} template. Edit and save to apply.`);
    }

    private getWebviewContent(): string {
        const categories = getAllCategories();
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Resource Templates</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        h1 {
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 10px;
        }
        h2 {
            color: var(--vscode-descriptionForeground);
            margin-top: 30px;
            margin-bottom: 15px;
            font-size: 1.2em;
        }
        .search-box {
            width: 100%;
            padding: 10px;
            margin-bottom: 20px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-size: 14px;
        }
        .search-box:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .templates-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .template-card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            padding: 15px;
            cursor: pointer;
            transition: all 0.2s;
            background-color: var(--vscode-editor-background);
        }
        .template-card:hover {
            border-color: var(--vscode-focusBorder);
            background-color: var(--vscode-list-hoverBackground);
            transform: translateY(-2px);
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }
        .template-name {
            font-weight: bold;
            font-size: 16px;
            margin-bottom: 8px;
            color: var(--vscode-textLink-foreground);
        }
        .template-description {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.4;
        }
        .template-type {
            display: inline-block;
            margin-top: 8px;
            padding: 3px 8px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
            font-size: 11px;
            font-family: monospace;
        }
        .category-section {
            margin-bottom: 30px;
        }
        .no-results {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <h1>📝 Resource Templates</h1>
    <input type="text" class="search-box" id="searchBox" placeholder="Search templates..." />
    
    <div id="templatesContainer"></div>

    <script>
        const vscode = acquireVsCodeApi();
        const templates = ${JSON.stringify(resourceTemplates)};
        const categories = ${JSON.stringify(categories)};

        function renderTemplates(filterText = '') {
            const container = document.getElementById('templatesContainer');
            const filter = filterText.toLowerCase();
            
            let html = '';
            let hasResults = false;

            categories.forEach(category => {
                const categoryTemplates = templates.filter(t => {
                    const matchesCategory = t.category === category;
                    const matchesFilter = !filter || 
                        t.name.toLowerCase().includes(filter) ||
                        t.description.toLowerCase().includes(filter) ||
                        t.type.toLowerCase().includes(filter);
                    return matchesCategory && matchesFilter;
                });

                if (categoryTemplates.length > 0) {
                    hasResults = true;
                    html += \`<div class="category-section">
                        <h2>\${category}</h2>
                        <div class="templates-grid">\`;
                    
                    categoryTemplates.forEach(template => {
                        html += \`
                            <div class="template-card" onclick="selectTemplate('\${template.type}')">
                                <div class="template-name">\${template.name}</div>
                                <div class="template-description">\${template.description}</div>
                                <div class="template-type">\${template.type}</div>
                            </div>
                        \`;
                    });
                    
                    html += '</div></div>';
                }
            });

            if (!hasResults) {
                html = '<div class="no-results">No templates found matching your search.</div>';
            }

            container.innerHTML = html;
        }

        function selectTemplate(type) {
            const template = templates.find(t => t.type === type);
            if (template) {
                vscode.postMessage({
                    command: 'selectTemplate',
                    template: template.template,
                    name: template.name
                });
            }
        }

        document.getElementById('searchBox').addEventListener('input', (e) => {
            renderTemplates(e.target.value);
        });

        // Initial render
        renderTemplates();
    </script>
</body>
</html>`;
    }
}
