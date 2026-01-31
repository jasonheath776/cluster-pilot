import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import * as yaml from 'yaml';

interface PolicyViolation {
    name: string;
    kind: string;
    namespace?: string;
    enforcementAction: string;
    totalViolations: number;
    message: string;
}

interface ConstraintTemplate {
    name: string;
    kind: string;
    description: string;
    targets: string[];
    parameters?: any;
}

interface Constraint {
    name: string;
    kind: string;
    template: string;
    enforcementAction: string;
    match: any;
    parameters?: any;
    violations: number;
}

export class PolicyEnforcementManager {
    private kc: k8s.KubeConfig;
    private panel: vscode.WebviewPanel | undefined;

    constructor(kc: k8s.KubeConfig) {
        this.kc = kc;
    }

    /**
     * Show policy enforcement panel
     */
    async showPolicyPanel(): Promise<void> {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'clusterPilot.policyEnforcement',
            'Policy Enforcement (OPA/Gatekeeper)',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = await this.getWebviewContent();

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(async (message: any) => {
            switch (message.command) {
                case 'refresh':
                    await this.loadPolicyData();
                    break;
                case 'installGatekeeper':
                    await this.installGatekeeper();
                    break;
                case 'createConstraintTemplate':
                    await this.createConstraintTemplate();
                    break;
                case 'createConstraint':
                    await this.createConstraint(message.templateKind);
                    break;
                case 'viewConstraint':
                    await this.viewConstraintDetails(message.name, message.kind);
                    break;
                case 'deleteConstraint':
                    await this.deleteConstraint(message.name, message.kind);
                    break;
                case 'viewViolations':
                    await this.viewViolations(message.constraintName);
                    break;
                case 'exportPolicy':
                    await this.exportPolicy(message.name, message.kind);
                    break;
            }
        });

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });

        // Initial load
        await this.loadPolicyData();
    }

    /**
     * Check if Gatekeeper is installed
     */
    private async isGatekeeperInstalled(): Promise<boolean> {
        try {
            const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
            const deployments = await appsApi.listNamespacedDeployment('gatekeeper-system');
            return deployments.body.items.length > 0;
        } catch (error) {
            return false;
        }
    }

    /**
     * Load policy data (templates, constraints, violations)
     */
    private async loadPolicyData(): Promise<void> {
        try {
            const gatekeeperInstalled = await this.isGatekeeperInstalled();

            if (!gatekeeperInstalled) {
                this.panel?.webview.postMessage({
                    command: 'updateState',
                    gatekeeperInstalled: false
                });
                return;
            }

            const [templates, constraints, violations] = await Promise.all([
                this.getConstraintTemplates(),
                this.getConstraints(),
                this.getViolations()
            ]);

            this.panel?.webview.postMessage({
                command: 'updateState',
                gatekeeperInstalled: true,
                templates,
                constraints,
                violations,
                stats: {
                    totalTemplates: templates.length,
                    totalConstraints: constraints.length,
                    totalViolations: violations.length,
                    enforcedPolicies: constraints.filter((c: Constraint) => c.enforcementAction === 'deny').length
                }
            });

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to load policy data: ${error.message}`);
        }
    }

    /**
     * Get constraint templates
     */
    private async getConstraintTemplates(): Promise<ConstraintTemplate[]> {
        try {
            const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
            const response: any = await customApi.listClusterCustomObject(
                'templates.gatekeeper.sh',
                'v1',
                'constrainttemplates'
            );

            return response.body.items.map((item: any) => ({
                name: item.metadata.name,
                kind: item.spec?.crd?.spec?.names?.kind || 'Unknown',
                description: item.metadata?.annotations?.description || 'No description',
                targets: item.spec?.targets?.map((t: any) => t.target) || [],
                parameters: item.spec?.crd?.spec?.validation?.openAPIV3Schema
            }));
        } catch (error) {
            // Gatekeeper not installed or no templates
            return [];
        }
    }

    /**
     * Get all constraints
     */
    private async getConstraints(): Promise<Constraint[]> {
        const templates = await this.getConstraintTemplates();
        const constraints: Constraint[] = [];

        for (const template of templates) {
            try {
                const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
                const response: any = await customApi.listClusterCustomObject(
                    'constraints.gatekeeper.sh',
                    'v1beta1',
                    template.kind.toLowerCase() + 's'
                );

                for (const item of response.body.items) {
                    constraints.push({
                        name: item.metadata.name,
                        kind: template.kind,
                        template: template.name,
                        enforcementAction: item.spec?.enforcementAction || 'deny',
                        match: item.spec?.match || {},
                        parameters: item.spec?.parameters,
                        violations: item.status?.totalViolations || 0
                    });
                }
            } catch (error) {
                // No constraints for this template
                continue;
            }
        }

        return constraints;
    }

    /**
     * Get policy violations
     */
    private async getViolations(): Promise<PolicyViolation[]> {
        const constraints = await this.getConstraints();
        const violations: PolicyViolation[] = [];

        for (const constraint of constraints) {
            if (constraint.violations > 0) {
                try {
                    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
                    const response: any = await customApi.getClusterCustomObject(
                        'constraints.gatekeeper.sh',
                        'v1beta1',
                        constraint.kind.toLowerCase() + 's',
                        constraint.name
                    );

                    if (response.body.status?.violations) {
                        for (const v of response.body.status.violations) {
                            violations.push({
                                name: v.name || 'unknown',
                                kind: v.kind || 'unknown',
                                namespace: v.namespace,
                                enforcementAction: constraint.enforcementAction,
                                totalViolations: 1,
                                message: v.message || 'No message'
                            });
                        }
                    }
                } catch (error) {
                    continue;
                }
            }
        }

        return violations;
    }

    /**
     * Install Gatekeeper
     */
    private async installGatekeeper(): Promise<void> {
        const confirmation = await vscode.window.showInformationMessage(
            'Install Gatekeeper to your cluster?',
            { modal: true },
            'Install',
            'Learn More',
            'Cancel'
        );

        if (confirmation === 'Learn More') {
            vscode.env.openExternal(vscode.Uri.parse('https://open-policy-agent.github.io/gatekeeper/'));
            return;
        }

        if (confirmation !== 'Install') {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Installing Gatekeeper...',
            cancellable: false
        }, async () => {
            try {
                const childProcess = require('child_process');
                const util = require('util');
                const execPromise = util.promisify(childProcess.exec);

                // Install Gatekeeper using kubectl with timeout
                const installCmd = 'kubectl apply -f https://raw.githubusercontent.com/open-policy-agent/gatekeeper/master/deploy/gatekeeper.yaml';
                await Promise.race([
                    execPromise(installCmd),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Installation timeout after 60 seconds')), 60000)
                    )
                ]);

                vscode.window.showInformationMessage(
                    '✅ Gatekeeper installed successfully! Waiting for pods to be ready...'
                );

                // Wait for gatekeeper to be ready
                await new Promise(resolve => setTimeout(resolve, 5000));
                await this.loadPolicyData();

            } catch (error: any) {
                vscode.window.showErrorMessage(`❌ Failed to install Gatekeeper: ${error.message}`);
            }
        });
    }

    /**
     * Create constraint template
     */
    private async createConstraintTemplate(): Promise<void> {
        const templates = [
            {
                label: 'K8sRequiredLabels',
                description: 'Require specific labels on resources',
                template: this.getRequiredLabelsTemplate()
            },
            {
                label: 'K8sAllowedRepos',
                description: 'Restrict container image repositories',
                template: this.getAllowedReposTemplate()
            },
            {
                label: 'K8sBlockNodePort',
                description: 'Block NodePort services',
                template: this.getBlockNodePortTemplate()
            },
            {
                label: 'K8sRequireResourceLimits',
                description: 'Require resource limits on containers',
                template: this.getRequireResourceLimitsTemplate()
            },
            {
                label: 'Custom Template',
                description: 'Create a custom constraint template',
                template: ''
            }
        ];

        const selected = await vscode.window.showQuickPick(templates, {
            placeHolder: 'Select a constraint template to create'
        });

        if (!selected) {
            return;
        }

        let templateYaml = selected.template;

        if (selected.label === 'Custom Template') {
            const doc = await vscode.workspace.openTextDocument({
                content: this.getCustomTemplateTemplate(),
                language: 'yaml'
            });
            await vscode.window.showTextDocument(doc);
            return;
        }

        // Apply template
        await this.applyYaml(templateYaml, 'Constraint Template');
        await this.loadPolicyData();
    }

    /**
     * Create constraint from template
     */
    private async createConstraint(templateKind: string): Promise<void> {
        const constraintYaml = this.getConstraintTemplate(templateKind);

        const doc = await vscode.workspace.openTextDocument({
            content: constraintYaml,
            language: 'yaml'
        });

        const editor = await vscode.window.showTextDocument(doc);

        const action = await vscode.window.showInformationMessage(
            `Edit the constraint and apply it to your cluster`,
            'Apply',
            'Cancel'
        );

        if (action === 'Apply') {
            await this.applyYaml(editor.document.getText(), 'Constraint');
            await this.loadPolicyData();
        }
    }

    /**
     * View constraint details
     */
    private async viewConstraintDetails(name: string, kind: string): Promise<void> {
        try {
            const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
            const response: any = await customApi.getClusterCustomObject(
                'constraints.gatekeeper.sh',
                'v1beta1',
                kind.toLowerCase() + 's',
                name
            );

            const doc = await vscode.workspace.openTextDocument({
                content: yaml.stringify(response.body),
                language: 'yaml'
            });

            await vscode.window.showTextDocument(doc);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to view constraint: ${error.message}`);
        }
    }

    /**
     * Delete constraint
     */
    private async deleteConstraint(name: string, kind: string): Promise<void> {
        if (!name || !kind) {
            vscode.window.showErrorMessage('Invalid constraint name or kind');
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Delete constraint "${name}"?\n\nThis will remove the policy enforcement. Resources that were blocked by this constraint will be allowed.`,
            { modal: true },
            'Delete',
            'Cancel'
        );

        if (confirmation !== 'Delete') {
            return;
        }

        try {
            const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
            await customApi.deleteClusterCustomObject(
                'constraints.gatekeeper.sh',
                'v1beta1',
                kind.toLowerCase() + 's',
                name
            );

            vscode.window.showInformationMessage(`✅ Constraint "${name}" deleted`);
            await this.loadPolicyData();
        } catch (error: any) {
            const message = error.body?.message || error.message || 'Unknown error';
            vscode.window.showErrorMessage(`Failed to delete constraint: ${message}`);
        }
    }

    /**
     * View violations for a constraint
     */
    private async viewViolations(constraintName: string): Promise<void> {
        vscode.window.showInformationMessage(`Viewing violations for ${constraintName}`);
    }

    /**
     * Export policy to file
     */
    private async exportPolicy(name: string, kind: string): Promise<void> {
        try {
            const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
            const response: any = await customApi.getClusterCustomObject(
                'constraints.gatekeeper.sh',
                'v1beta1',
                kind.toLowerCase() + 's',
                name
            );

            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${name}-policy.yaml`),
                filters: { 'YAML': ['yaml', 'yml'] }
            });

            if (uri) {
                const fs = require('fs');
                fs.writeFileSync(uri.fsPath, yaml.stringify(response.body));
                vscode.window.showInformationMessage(`✅ Policy exported to ${uri.fsPath}`);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to export policy: ${error.message}`);
        }
    }

    /**
     * Apply YAML to cluster
     */
    private async applyYaml(yamlContent: string, resourceType: string): Promise<void> {
        try {
            const os = require('os');
            const path = require('path');
            const fs = require('fs');
            const { exec } = require('child_process');
            const util = require('util');
            const execPromise = util.promisify(exec);

            const tmpFile = path.join(os.tmpdir(), `policy-${Date.now()}.yaml`);
            fs.writeFileSync(tmpFile, yamlContent);

            await execPromise(`kubectl apply -f ${tmpFile}`);
            fs.unlinkSync(tmpFile);

            vscode.window.showInformationMessage(`✅ ${resourceType} applied successfully`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to apply ${resourceType}: ${error.message}`);
        }
    }

    // Template generators

    private getRequiredLabelsTemplate(): string {
        return `apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        violation[{"msg": msg, "details": {"missing_labels": missing}}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_]}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("you must provide labels: %v", [missing])
        }`;
    }

    private getAllowedReposTemplate(): string {
        return `apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedrepos
spec:
  crd:
    spec:
      names:
        kind: K8sAllowedRepos
      validation:
        openAPIV3Schema:
          type: object
          properties:
            repos:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sallowedrepos

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          satisfied := [good | repo = input.parameters.repos[_] ; good = startswith(container.image, repo)]
          not any(satisfied)
          msg := sprintf("container <%v> has an invalid image repo <%v>", [container.name, container.image])
        }`;
    }

    private getBlockNodePortTemplate(): string {
        return `apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sblocknodeport
spec:
  crd:
    spec:
      names:
        kind: K8sBlockNodePort
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sblocknodeport

        violation[{"msg": msg}] {
          input.review.kind.kind == "Service"
          input.review.object.spec.type == "NodePort"
          msg := "NodePort services are not allowed"
        }`;
    }

    private getRequireResourceLimitsTemplate(): string {
        return `apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequireresourcelimits
spec:
  crd:
    spec:
      names:
        kind: K8sRequireResourceLimits
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequireresourcelimits

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not container.resources.limits.cpu
          msg := sprintf("container <%v> has no CPU limit", [container.name])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not container.resources.limits.memory
          msg := sprintf("container <%v> has no memory limit", [container.name])
        }`;
    }

    private getCustomTemplateTemplate(): string {
        return `apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8scustompolicy
spec:
  crd:
    spec:
      names:
        kind: K8sCustomPolicy
      validation:
        openAPIV3Schema:
          type: object
          properties:
            # Add your parameters here
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8scustompolicy

        violation[{"msg": msg}] {
          # Add your Rego policy logic here
          msg := "Policy violation detected"
        }`;
    }

    private getConstraintTemplate(kind: string): string {
        return `apiVersion: constraints.gatekeeper.sh/v1beta1
kind: ${kind}
metadata:
  name: ${kind.toLowerCase()}-constraint
spec:
  enforcementAction: deny  # or 'dryrun' for testing
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaces:
      - default
  parameters:
    # Add constraint parameters here
`;
    }

    /**
     * Get webview HTML
     */
    private async getWebviewContent(): Promise<string> {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Policy Enforcement</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .title {
            font-size: 24px;
            font-weight: bold;
        }
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .install-banner {
            background: var(--vscode-editor-background);
            border: 2px solid var(--vscode-editorWarning-foreground);
            border-radius: 6px;
            padding: 20px;
            text-align: center;
            margin-bottom: 20px;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 15px;
        }
        .stat-value {
            font-size: 32px;
            font-weight: bold;
        }
        .section {
            margin-bottom: 30px;
        }
        .section-title {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 15px;
            margin-bottom: 10px;
        }
        .badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: bold;
        }
        .badge-deny { background: #dc3545; color: white; }
        .badge-dryrun { background: #ffc107; color: black; }
        .badge-warn { background: #fd7e14; color: white; }
        .empty-state {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title">🛡️ Policy Enforcement (OPA/Gatekeeper)</div>
        <button onclick="refresh()">🔄 Refresh</button>
    </div>

    <div id="installBanner" style="display: none;">
        <div class="install-banner">
            <h2>⚠️ Gatekeeper Not Installed</h2>
            <p>Install Gatekeeper to enforce policies in your cluster</p>
            <button onclick="installGatekeeper()">Install Gatekeeper</button>
            <button onclick="learnMore()">Learn More</button>
        </div>
    </div>

    <div id="content" style="display: none;">
        <div class="stats" id="stats"></div>

        <div class="section">
            <div class="section-title">
                <span>📋 Constraint Templates</span>
                <button onclick="createTemplate()">+ Create Template</button>
            </div>
            <div id="templates"></div>
        </div>

        <div class="section">
            <div class="section-title">
                <span>🔒 Active Constraints</span>
            </div>
            <div id="constraints"></div>
        </div>

        <div class="section">
            <div class="section-title">
                <span>⚠️ Policy Violations</span>
            </div>
            <div id="violations"></div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function installGatekeeper() {
            vscode.postMessage({ command: 'installGatekeeper' });
        }

        function learnMore() {
            // Will be handled by extension
        }

        function createTemplate() {
            vscode.postMessage({ command: 'createConstraintTemplate' });
        }

        function createConstraint(templateKind) {
            vscode.postMessage({ command: 'createConstraint', templateKind });
        }

        function viewConstraint(name, kind) {
            vscode.postMessage({ command: 'viewConstraint', name, kind });
        }

        function deleteConstraint(name, kind) {
            vscode.postMessage({ command: 'deleteConstraint', name, kind });
        }

        function exportPolicy(name, kind) {
            vscode.postMessage({ command: 'exportPolicy', name, kind });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateState') {
                if (!message.gatekeeperInstalled) {
                    document.getElementById('installBanner').style.display = 'block';
                    document.getElementById('content').style.display = 'none';
                } else {
                    document.getElementById('installBanner').style.display = 'none';
                    document.getElementById('content').style.display = 'block';
                    
                    renderStats(message.stats);
                    renderTemplates(message.templates);
                    renderConstraints(message.constraints);
                    renderViolations(message.violations);
                }
            }
        });

        function renderStats(stats) {
            if (!stats) return;
            document.getElementById('stats').innerHTML = \`
                <div class="stat-card">
                    <div style="opacity: 0.7; font-size: 12px;">Templates</div>
                    <div class="stat-value">\${stats.totalTemplates}</div>
                </div>
                <div class="stat-card">
                    <div style="opacity: 0.7; font-size: 12px;">Constraints</div>
                    <div class="stat-value">\${stats.totalConstraints}</div>
                </div>
                <div class="stat-card">
                    <div style="opacity: 0.7; font-size: 12px;">Violations</div>
                    <div class="stat-value" style="color: #dc3545;">\${stats.totalViolations}</div>
                </div>
                <div class="stat-card">
                    <div style="opacity: 0.7; font-size: 12px;">Enforced</div>
                    <div class="stat-value">\${stats.enforcedPolicies}</div>
                </div>
            \`;
        }

        function renderTemplates(templates) {
            const container = document.getElementById('templates');
            if (!templates || templates.length === 0) {
                container.innerHTML = '<div class="empty-state">No constraint templates found</div>';
                return;
            }
            container.innerHTML = templates.map(t => \`
                <div class="card">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong>\${t.kind}</strong>
                            <div style="opacity: 0.7; font-size: 12px;">\${t.description}</div>
                        </div>
                        <button onclick="createConstraint('\${t.kind}')">Create Constraint</button>
                    </div>
                </div>
            \`).join('');
        }

        function renderConstraints(constraints) {
            const container = document.getElementById('constraints');
            if (!constraints || constraints.length === 0) {
                container.innerHTML = '<div class="empty-state">No active constraints</div>';
                return;
            }
            container.innerHTML = constraints.map(c => \`
                <div class="card">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong>\${c.name}</strong>
                            <span class="badge badge-\${c.enforcementAction}">\${c.enforcementAction.toUpperCase()}</span>
                            <div style="opacity: 0.7; font-size: 12px;">Kind: \${c.kind} | Violations: \${c.violations}</div>
                        </div>
                        <div>
                            <button onclick="viewConstraint('\${c.name}', '\${c.kind}')">View</button>
                            <button onclick="exportPolicy('\${c.name}', '\${c.kind}')">Export</button>
                            <button onclick="deleteConstraint('\${c.name}', '\${c.kind}')">Delete</button>
                        </div>
                    </div>
                </div>
            \`).join('');
        }

        function renderViolations(violations) {
            const container = document.getElementById('violations');
            if (!violations || violations.length === 0) {
                container.innerHTML = '<div class="empty-state">✅ No policy violations found</div>';
                return;
            }
            container.innerHTML = violations.map(v => \`
                <div class="card">
                    <div>
                        <strong>\${v.kind}/\${v.name}</strong> 
                        \${v.namespace ? \`<span style="opacity: 0.7;">(\${v.namespace})</span>\` : ''}
                        <div style="color: #dc3545; font-size: 12px; margin-top: 5px;">\${v.message}</div>
                    </div>
                </div>
            \`).join('');
        }

        // Initial refresh
        refresh();
    </script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
    }
}
