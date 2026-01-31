import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import * as yaml from 'yaml';
import { getErrorMessage } from '../utils/errors';

interface ValidationError {
    line: number;
    message: string;
    severity: 'error' | 'warning';
}

/**
 * CodeLens provider for Kubernetes YAML files
 */
class K8sYAMLCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] | undefined {
        if (document.languageId !== 'yaml') {
            return undefined;
        }

        const codeLenses: vscode.CodeLens[] = [];
        const text = document.getText();

        // Check if this looks like a Kubernetes resource
        if (text.includes('apiVersion:') && text.includes('kind:')) {
            const topOfDocument = new vscode.Range(0, 0, 0, 0);
            
            codeLenses.push(
                new vscode.CodeLens(topOfDocument, {
                    title: '\u2705 Apply to Cluster',
                    command: 'clusterPilot.applyYamlToCluster',
                    tooltip: 'Apply this YAML to your Kubernetes cluster'
                })
            );

            codeLenses.push(
                new vscode.CodeLens(topOfDocument, {
                    title: '\ud83e\uddea Dry Run (Validate)',
                    command: 'clusterPilot.dryRunYaml',
                    tooltip: 'Validate this YAML without applying it'
                })
            );
        }

        return codeLenses;
    }
}

export class YAMLEditor {
    private kc: k8s.KubeConfig;
    private diagnosticCollection: vscode.DiagnosticCollection;
    private codeLensProvider: K8sYAMLCodeLensProvider;
    private codeLensDisposable: vscode.Disposable | undefined;

    constructor(kc: k8s.KubeConfig) {
        this.kc = kc;
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('kubernetes-yaml');
        this.codeLensProvider = new K8sYAMLCodeLensProvider();
        
        // Register CodeLens provider for YAML files
        this.codeLensDisposable = vscode.languages.registerCodeLensProvider(
            { language: 'yaml', scheme: '*' },
            this.codeLensProvider
        );
    }

    /**
     * Apply the currently active YAML document to the cluster
     */
    async applyActiveDocument(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor found');
            return;
        }

        const document = editor.document;
        if (document.languageId !== 'yaml') {
            vscode.window.showWarningMessage('Active document is not a YAML file');
            return;
        }

        // Check if document has unsaved changes
        if (document.isDirty) {
            const save = await vscode.window.showWarningMessage(
                'Document has unsaved changes. Save before applying?',
                'Save & Apply',
                'Apply Without Saving',
                'Cancel'
            );

            if (save === 'Cancel') {
                return;
            } else if (save === 'Save & Apply') {
                await document.save();
            }
        }

        await this.applyResource(document);
    }

    /**
     * Dry run the currently active YAML document
     */
    async dryRunActiveDocument(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor found');
            return;
        }

        const document = editor.document;
        if (document.languageId !== 'yaml') {
            vscode.window.showWarningMessage('Active document is not a YAML file');
            return;
        }

        await this.dryRunResource(document);
    }

    /**
     * Create a new Kubernetes resource from template
     */
    async createResource(): Promise<void> {
        const resourceType = await vscode.window.showQuickPick([
            { label: 'Pod', value: 'pod' },
            { label: 'Deployment', value: 'deployment' },
            { label: 'Service', value: 'service' },
            { label: 'ConfigMap', value: 'configmap' },
            { label: 'Secret', value: 'secret' },
            { label: 'Namespace', value: 'namespace' },
            { label: 'PersistentVolumeClaim', value: 'pvc' },
            { label: 'Ingress', value: 'ingress' },
            { label: 'StatefulSet', value: 'statefulset' },
            { label: 'DaemonSet', value: 'daemonset' },
            { label: 'Job', value: 'job' },
            { label: 'CronJob', value: 'cronjob' },
            { label: 'Custom (blank)', value: 'custom' }
        ], {
            placeHolder: 'Select resource type to create'
        });

        if (!resourceType) {
            return;
        }

        const template = this.getResourceTemplate(resourceType.value);
        const doc = await vscode.workspace.openTextDocument({
            content: template,
            language: 'yaml'
        });

        const editor = await vscode.window.showTextDocument(doc);

        // Enable validation
        this.validateDocument(doc);

        // Watch for changes and validate
        const changeListener = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === doc) {
                this.validateDocument(e.document);
            }
        });

        // Watch for document close to clean up listeners
        const closeListener = vscode.workspace.onDidCloseTextDocument(closedDoc => {
            if (closedDoc === doc) {
                changeListener.dispose();
                closeListener.dispose();
            }
        });

        // Immediately show action prompt with modal to ensure user sees it
        const action = await vscode.window.showInformationMessage(
            `✨ Kubernetes ${resourceType.label} template ready. Edit the YAML, then choose an action:`,
            { modal: true },
            'Apply to Cluster Now',
            'Edit First'
        );

        if (action === 'Apply to Cluster Now') {
            await this.applyResource(doc);
        } else if (action === 'Edit First') {
            // Show persistent reminder
            vscode.window.showInformationMessage(
                '💡 When ready to apply: Right-click in editor → "Apply YAML to Cluster" or press Ctrl+Shift+A (Cmd+Shift+A on Mac)',
                { modal: false }
            );
        }
    }

    /**
     * Edit existing resource with validation
     */
    async editResource(resourceKind: string, resourceName: string, namespace?: string): Promise<void> {
        try {
            const context = this.kc.getCurrentContext();
            if (!context) {
                vscode.window.showErrorMessage('No Kubernetes context selected');
                return;
            }

            // Get resource YAML
            const client = this.kc.makeApiClient(k8s.CoreV1Api);
            let yamlContent: string;

            // This is simplified - in production you'd handle all resource types
            const namespaceArg = namespace ? `-n ${namespace}` : '';
            const { exec } = require('child_process');
            const command = `kubectl get ${resourceKind} ${resourceName} ${namespaceArg} -o yaml`;

            yamlContent = await new Promise((resolve, reject) => {
                exec(command, { env: { ...process.env, KUBECONFIG: this.getKubeconfigPath() } }, 
                    (error: any, stdout: string, stderr: string) => {
                    if (error) {
                        reject(new Error(stderr || error.message));
                        return;
                    }
                    resolve(stdout);
                });
            });

            // Open in editor
            const doc = await vscode.workspace.openTextDocument({
                content: yamlContent,
                language: 'yaml'
            });

            const editor = await vscode.window.showTextDocument(doc);
            this.validateDocument(doc);

            // Watch for changes
            const changeListener = vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document === doc) {
                    this.validateDocument(e.document);
                }
            });

            // Show action buttons
            const action = await vscode.window.showInformationMessage(
                `✏️ Editing ${resourceKind}/${resourceName}`,
                'Apply Changes',
                'Dry Run',
                'Cancel'
            );

            if (action === 'Apply Changes') {
                await this.applyResource(doc);
            } else if (action === 'Dry Run') {
                await this.dryRunResource(doc);
            }

            changeListener.dispose();

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to edit resource: ${error}`);
        }
    }

    /**
     * Validate YAML document against Kubernetes schemas
     */
    private validateDocument(document: vscode.TextDocument): void {
        const diagnostics: vscode.Diagnostic[] = [];
        const content = document.getText();

        try {
            // Parse YAML
            const parsed = yaml.parseAllDocuments(content);
            const errors: ValidationError[] = [];

            parsed.forEach((doc, docIndex) => {
                if (doc.errors && doc.errors.length > 0) {
                    doc.errors.forEach(error => {
                        errors.push({
                            line: error.linePos?.[0].line || 0,
                            message: error.message,
                            severity: 'error'
                        });
                    });
                }

                // Validate K8s structure
                const resource = doc.toJSON();
                if (resource) {
                    const structureErrors = this.validateK8sStructure(resource);
                    errors.push(...structureErrors);
                }
            });

            // Convert to diagnostics
            errors.forEach(error => {
                const line = error.line > 0 ? error.line - 1 : 0;
                const range = new vscode.Range(line, 0, line, 100);
                const severity = error.severity === 'error' 
                    ? vscode.DiagnosticSeverity.Error 
                    : vscode.DiagnosticSeverity.Warning;

                diagnostics.push(new vscode.Diagnostic(range, error.message, severity));
            });

        } catch (error: any) {
            const range = new vscode.Range(0, 0, 0, 100);
            diagnostics.push(new vscode.Diagnostic(
                range,
                `YAML parsing error: ${error.message}`,
                vscode.DiagnosticSeverity.Error
            ));
        }

        this.diagnosticCollection.set(document.uri, diagnostics);
    }

    /**
     * Validate Kubernetes resource structure
     */
    private validateK8sStructure(resource: any): ValidationError[] {
        const errors: ValidationError[] = [];

        // Check required fields
        if (!resource.apiVersion) {
            errors.push({
                line: 1,
                message: 'Missing required field: apiVersion',
                severity: 'error'
            });
        }

        if (!resource.kind) {
            errors.push({
                line: 1,
                message: 'Missing required field: kind',
                severity: 'error'
            });
        }

        if (!resource.metadata) {
            errors.push({
                line: 1,
                message: 'Missing required field: metadata',
                severity: 'error'
            });
        } else {
            if (!resource.metadata.name) {
                errors.push({
                    line: 1,
                    message: 'Missing required field: metadata.name',
                    severity: 'error'
                });
            }

            // Validate name format
            if (resource.metadata.name && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(resource.metadata.name)) {
                errors.push({
                    line: 1,
                    message: 'metadata.name must consist of lowercase alphanumeric characters or \'-\'',
                    severity: 'error'
                });
            }
        }

        // Validate spec based on kind
        if (resource.kind && !resource.spec && this.requiresSpec(resource.kind)) {
            errors.push({
                line: 1,
                message: `Missing required field: spec for ${resource.kind}`,
                severity: 'error'
            });
        }

        // Resource-specific validations
        if (resource.kind === 'Deployment' || resource.kind === 'StatefulSet' || resource.kind === 'DaemonSet') {
            if (resource.spec && !resource.spec.selector) {
                errors.push({
                    line: 1,
                    message: 'Missing required field: spec.selector',
                    severity: 'error'
                });
            }
            if (resource.spec && !resource.spec.template) {
                errors.push({
                    line: 1,
                    message: 'Missing required field: spec.template',
                    severity: 'error'
                });
            }
        }

        if (resource.kind === 'Service') {
            if (resource.spec && !resource.spec.selector) {
                errors.push({
                    line: 1,
                    message: 'Warning: Service has no selector (headless service?)',
                    severity: 'warning'
                });
            }
        }

        return errors;
    }

    private requiresSpec(kind: string): boolean {
        const specsRequired = [
            'Deployment', 'StatefulSet', 'DaemonSet', 'Service', 
            'Pod', 'Job', 'CronJob', 'Ingress', 'PersistentVolumeClaim'
        ];
        return specsRequired.includes(kind);
    }

    /**
     * Validate resource before applying to cluster
     * Checks for required fields and potentially dangerous operations
     */
    private async validateBeforeApply(content: string): Promise<{ valid: boolean; message?: string }> {
        try {
            const resources = yaml.parseAllDocuments(content);

            for (const doc of resources) {
                const resource = doc.toJSON();
                if (!resource) continue;

                // Check required fields
                if (!resource.apiVersion || !resource.kind) {
                    return {
                        valid: false,
                        message: '❌ Invalid YAML: Missing apiVersion or kind'
                    };
                }

                if (!resource.metadata?.name) {
                    return {
                        valid: false,
                        message: '❌ Invalid YAML: Missing metadata.name'
                    };
                }

                // Warn about privileged operations
                const dangerousKinds = ['ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding'];
                if (dangerousKinds.includes(resource.kind)) {
                    const proceed = await vscode.window.showWarningMessage(
                        `⚠️  You are about to create/modify a ${resource.kind}. This affects permissions. Continue?`,
                        { modal: true },
                        'Yes, Apply',
                        'Cancel'
                    );

                    if (proceed !== 'Yes, Apply') {
                        return { valid: false, message: 'Application cancelled' };
                    }
                }

                // Warn about standalone pods
                if (resource.kind === 'Pod' && !resource.metadata.ownerReferences) {
                    const proceed = await vscode.window.showWarningMessage(
                        '⚠️  You are creating a standalone Pod (not managed by deployment/statefulset). This is unusual. Continue?',
                        { modal: true },
                        'Yes, Apply',
                        'Cancel'
                    );

                    if (proceed !== 'Yes, Apply') {
                        return { valid: false, message: 'Application cancelled' };
                    }
                }
            }

            return { valid: true };
        } catch (error) {
            return {
                valid: false,
                message: `❌ YAML validation error: ${getErrorMessage(error)}`
            };
        }
    }

    /**
     * Apply resource to cluster
     */
    private async applyResource(document: vscode.TextDocument): Promise<void> {
        try {
            const content = document.getText();

            // Validate before applying
            const validation = await this.validateBeforeApply(content);
            if (!validation.valid) {
                vscode.window.showWarningMessage(validation.message || 'Validation failed');
                return;
            }
            
            // Save to temp file
            const tmpFile = await this.saveTempFile(content);

            // Apply using kubectl
            const { exec } = require('child_process');
            const command = `kubectl apply -f ${tmpFile}`;

            const result = await new Promise<string>((resolve, reject) => {
                exec(command, { env: { ...process.env, KUBECONFIG: this.getKubeconfigPath() } },
                    (error: any, stdout: string, stderr: string) => {
                    if (error) {
                        reject(new Error(stderr || error.message));
                        return;
                    }
                    resolve(stdout);
                });
            });

            vscode.window.showInformationMessage(`✅ ${result.trim()}`);

            // Clean up temp file
            const fs = require('fs');
            fs.unlinkSync(tmpFile);

        } catch (error: any) {
            vscode.window.showErrorMessage(`❌ Failed to apply resource: ${error.message}`);
        }
    }

    /**
     * Dry run resource validation
     */
    private async dryRunResource(document: vscode.TextDocument): Promise<void> {
        try {
            const content = document.getText();
            const tmpFile = await this.saveTempFile(content);

            const { exec } = require('child_process');
            const command = `kubectl apply -f ${tmpFile} --dry-run=server`;

            const result = await new Promise<string>((resolve, reject) => {
                exec(command, { env: { ...process.env, KUBECONFIG: this.getKubeconfigPath() } },
                    (error: any, stdout: string, stderr: string) => {
                    if (error) {
                        reject(new Error(stderr || error.message));
                        return;
                    }
                    resolve(stdout);
                });
            });

            vscode.window.showInformationMessage(`✅ Dry run successful: ${result.trim()}`);

            const fs = require('fs');
            fs.unlinkSync(tmpFile);

        } catch (error: any) {
            vscode.window.showErrorMessage(`❌ Dry run failed: ${error.message}`);
        }
    }

    private async saveTempFile(content: string): Promise<string> {
        const os = require('os');
        const path = require('path');
        const fs = require('fs');
        
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `k8s-resource-${Date.now()}.yaml`);
        fs.writeFileSync(tmpFile, content);
        
        return tmpFile;
    }

    private getKubeconfigPath(): string {
        const config = vscode.workspace.getConfiguration('clusterPilot');
        let kubeconfigPath = config.get<string>('kubeconfigPath', '~/.kube/config');

        if (kubeconfigPath.startsWith('~')) {
            const os = require('os');
            const path = require('path');
            kubeconfigPath = path.join(os.homedir(), kubeconfigPath.slice(1));
        }

        return kubeconfigPath;
    }

    /**
     * Get resource template based on type
     */
    private getResourceTemplate(type: string): string {
        const templates: { [key: string]: string } = {
            pod: `apiVersion: v1
kind: Pod
metadata:
  name: my-pod
  namespace: default
  labels:
    app: my-app
spec:
  containers:
  - name: main
    image: nginx:latest
    ports:
    - containerPort: 80
    resources:
      requests:
        memory: "64Mi"
        cpu: "250m"
      limits:
        memory: "128Mi"
        cpu: "500m"`,

            deployment: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-deployment
  namespace: default
  labels:
    app: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: main
        image: nginx:latest
        ports:
        - containerPort: 80
        resources:
          requests:
            memory: "64Mi"
            cpu: "250m"
          limits:
            memory: "128Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 80
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 80
          initialDelaySeconds: 5
          periodSeconds: 5`,

            service: `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: default
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
  - name: http
    port: 80
    targetPort: 80
    protocol: TCP`,

            configmap: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
data:
  key1: value1
  key2: value2
  config.yaml: |
    setting: value`,

            secret: `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: default
type: Opaque
stringData:
  username: admin
  password: changeme`,

            namespace: `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
  labels:
    name: my-namespace`,

            pvc: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
  namespace: default
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi`,

            ingress: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  namespace: default
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-service
            port:
              number: 80`,

            statefulset: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-statefulset
  namespace: default
spec:
  serviceName: my-service
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: main
        image: nginx:latest
        ports:
        - containerPort: 80
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      resources:
        requests:
          storage: 1Gi`,

            daemonset: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: my-daemonset
  namespace: default
spec:
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: main
        image: nginx:latest`,

            job: `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
  namespace: default
spec:
  template:
    spec:
      containers:
      - name: main
        image: busybox
        command: ["echo", "Hello Kubernetes"]
      restartPolicy: Never
  backoffLimit: 4`,

            cronjob: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cronjob
  namespace: default
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: main
            image: busybox
            command: ["echo", "Hello from CronJob"]
          restartPolicy: OnFailure`,

            custom: `apiVersion: v1
kind: 
metadata:
  name: 
  namespace: default
spec:
  `
        };

        return templates[type] || templates.custom;
    }

    dispose(): void {
        this.diagnosticCollection.dispose();
        if (this.codeLensDisposable) {
            this.codeLensDisposable.dispose();
        }
    }
}
