import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';

export class RBACViewerPanel {
    private panel: vscode.WebviewPanel;
    private resource: any;
    private resourceType: string;

    constructor(
        context: vscode.ExtensionContext,
        resource: any,
        resourceType: string
    ) {
        this.resource = resource;
        this.resourceType = resourceType;

        this.panel = vscode.window.createWebviewPanel(
            'rbacViewer',
            `RBAC: ${resource.metadata?.name}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getHtmlContent();
    }

    private getHtmlContent(): string {
        const name = this.resource.metadata?.name || 'Unknown';
        const namespace = this.resource.metadata?.namespace;

        let content = '';

        switch (this.resourceType) {
            case 'role':
            case 'clusterrole':
                content = this.renderRoleContent();
                break;
            case 'rolebinding':
            case 'clusterrolebinding':
                content = this.renderBindingContent();
                break;
            case 'serviceaccount':
                content = this.renderServiceAccountContent();
                break;
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RBAC Viewer</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        h1, h2, h3 {
            color: var(--vscode-editor-foreground);
        }
        .header {
            margin-bottom: 30px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 12px;
            margin-left: 10px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .section {
            margin: 20px 0;
            padding: 15px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 10px 0;
        }
        th, td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        th {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            font-weight: 600;
        }
        .rule {
            margin: 10px 0;
            padding: 10px;
            background-color: var(--vscode-input-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
        }
        .label {
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
        }
        .value {
            color: var(--vscode-descriptionForeground);
        }
        code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        .subject {
            padding: 8px;
            margin: 5px 0;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>
            ${this.escapeHtml(name)}
            <span class="badge">${this.resourceType}</span>
            ${namespace ? `<span class="badge">${this.escapeHtml(namespace)}</span>` : ''}
        </h1>
    </div>
    ${content}
</body>
</html>`;
    }

    private renderRoleContent(): string {
        const rules = this.resource.rules || [];
        
        return `
            <div class="section">
                <h2>Rules</h2>
                ${rules.length === 0 ? '<p>No rules defined</p>' : rules.map((rule: any, index: number) => `
                    <div class="rule">
                        <h3>Rule ${index + 1}</h3>
                        ${rule.apiGroups && rule.apiGroups.length > 0 ? `
                            <p><span class="label">API Groups:</span> ${rule.apiGroups.map((g: string) => `<code>${g || '""'}</code>`).join(', ')}</p>
                        ` : ''}
                        ${rule.resources && rule.resources.length > 0 ? `
                            <p><span class="label">Resources:</span> ${rule.resources.map((r: string) => `<code>${r}</code>`).join(', ')}</p>
                        ` : ''}
                        ${rule.verbs && rule.verbs.length > 0 ? `
                            <p><span class="label">Verbs:</span> ${rule.verbs.map((v: string) => `<code>${v}</code>`).join(', ')}</p>
                        ` : ''}
                        ${rule.resourceNames && rule.resourceNames.length > 0 ? `
                            <p><span class="label">Resource Names:</span> ${rule.resourceNames.map((n: string) => `<code>${n}</code>`).join(', ')}</p>
                        ` : ''}
                        ${rule.nonResourceURLs && rule.nonResourceURLs.length > 0 ? `
                            <p><span class="label">Non-Resource URLs:</span> ${rule.nonResourceURLs.map((u: string) => `<code>${u}</code>`).join(', ')}</p>
                        ` : ''}
                    </div>
                `).join('')}
            </div>
        `;
    }

    private renderBindingContent(): string {
        const roleRef = this.resource.roleRef;
        const subjects = this.resource.subjects || [];

        return `
            <div class="section">
                <h2>Role Reference</h2>
                <p><span class="label">Kind:</span> <code>${roleRef?.kind || 'Unknown'}</code></p>
                <p><span class="label">Name:</span> <code>${roleRef?.name || 'Unknown'}</code></p>
                ${roleRef?.apiGroup ? `<p><span class="label">API Group:</span> <code>${roleRef.apiGroup}</code></p>` : ''}
            </div>

            <div class="section">
                <h2>Subjects (${subjects.length})</h2>
                ${subjects.length === 0 ? '<p>No subjects</p>' : subjects.map((subject: any) => `
                    <div class="subject">
                        <p><span class="label">Kind:</span> <code>${subject.kind}</code></p>
                        <p><span class="label">Name:</span> <code>${subject.name}</code></p>
                        ${subject.namespace ? `<p><span class="label">Namespace:</span> <code>${subject.namespace}</code></p>` : ''}
                        ${subject.apiGroup ? `<p><span class="label">API Group:</span> <code>${subject.apiGroup}</code></p>` : ''}
                    </div>
                `).join('')}
            </div>
        `;
    }

    private renderServiceAccountContent(): string {
        const secrets = this.resource.secrets || [];
        const imagePullSecrets = this.resource.imagePullSecrets || [];

        return `
            <div class="section">
                <h2>Secrets (${secrets.length})</h2>
                ${secrets.length === 0 ? '<p>No secrets</p>' : `
                    <ul>
                        ${secrets.map((secret: any) => `<li><code>${secret.name}</code></li>`).join('')}
                    </ul>
                `}
            </div>

            ${imagePullSecrets.length > 0 ? `
                <div class="section">
                    <h2>Image Pull Secrets (${imagePullSecrets.length})</h2>
                    <ul>
                        ${imagePullSecrets.map((secret: any) => `<li><code>${secret.name}</code></li>`).join('')}
                    </ul>
                </div>
            ` : ''}

            ${this.resource.automountServiceAccountToken !== undefined ? `
                <div class="section">
                    <h2>Configuration</h2>
                    <p><span class="label">Automount Token:</span> ${this.resource.automountServiceAccountToken ? 'Yes' : 'No'}</p>
                </div>
            ` : ''}
        `;
    }

    private escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
}
