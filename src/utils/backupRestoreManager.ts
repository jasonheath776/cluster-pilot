import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import * as yaml from 'yaml';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

interface BackupMetadata {
    timestamp: string;
    context: string;
    namespaces: string[];
    resourceTypes: string[];
    description: string;
}

interface BackupResource {
    kind: string;
    apiVersion: string;
    metadata: any;
    spec?: any;
    data?: any;
}

export class BackupRestoreManager {
    private kc: k8s.KubeConfig;
    private backupDir: string;

    constructor(kc: k8s.KubeConfig) {
        this.kc = kc;
        
        // Default backup directory
        const config = vscode.workspace.getConfiguration('clusterPilot');
        let configuredPath = config.get<string>('backupDirectory', '');
        
        // Use default if not configured or empty
        if (!configuredPath || configuredPath.trim() === '') {
            configuredPath = path.join(os.homedir(), '.jas-cluster-pilot', 'backups');
        } else {
            // Expand tilde and resolve path
            if (configuredPath.startsWith('~')) {
                configuredPath = path.join(os.homedir(), configuredPath.slice(1));
            }
            configuredPath = path.resolve(configuredPath);
            
            // Validate path is not in protected system directories
            const normalizedPath = configuredPath.toLowerCase().replace(/\\/g, '/');
            const protectedPaths = [
                'c:/program files',
                'c:/windows',
                'c:/program files (x86)'
            ];
            
            if (protectedPaths.some(p => normalizedPath.includes(p))) {
                console.warn(`Configured backup directory is in a protected location: ${configuredPath}. Using default instead.`);
                configuredPath = path.join(os.homedir(), '.jas-cluster-pilot', 'backups');
                
                vscode.window.showWarningMessage(
                    `Backup directory cannot be in a protected system folder. Using default location: ${configuredPath}`,
                    'Open Settings'
                ).then(selection => {
                    if (selection === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'clusterPilot.backupDirectory');
                    }
                });
            }
        }
        this.backupDir = configuredPath;
        
        // Ensure backup directory exists
        this.ensureBackupDirectory();
    }

    /**
     * Show backup/restore panel
     */
    async showBackupPanel(): Promise<void> {
        const panel = vscode.window.createWebviewPanel(
            'clusterPilot.backup',
            'Backup & Restore',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        panel.webview.html = await this.getBackupPanelHtml();

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'createBackup':
                    await this.createBackupWizard();
                    panel.webview.postMessage({ command: 'refresh' });
                    break;
                case 'restoreBackup':
                    await this.restoreBackup(message.backupId);
                    break;
                case 'deleteBackup':
                    await this.deleteBackup(message.backupId);
                    panel.webview.postMessage({ command: 'refresh' });
                    break;
                case 'exportBackup':
                    await this.exportBackup(message.backupId);
                    break;
                case 'importBackup':
                    await this.importBackup();
                    panel.webview.postMessage({ command: 'refresh' });
                    break;
                case 'listBackups':
                    const backups = await this.listBackups();
                    panel.webview.postMessage({ command: 'backupsList', backups });
                    break;
            }
        });

        // Send initial data
        const backups = await this.listBackups();
        panel.webview.postMessage({ command: 'backupsList', backups });
    }

    /**
     * Create backup wizard
     */
    async createBackupWizard(): Promise<void> {
        // Select backup scope
        const scope = await vscode.window.showQuickPick([
            { label: '🌐 Entire Cluster', description: 'Backup all namespaces and resources', value: 'cluster' },
            { label: '📦 Selected Namespaces', description: 'Choose specific namespaces', value: 'namespaces' },
            { label: '🎯 Specific Resources', description: 'Select individual resources', value: 'resources' }
        ], {
            placeHolder: 'Select backup scope'
        });

        if (!scope) {
            return;
        }

        let namespaces: string[] = [];
        let resourceTypes: string[] = [];

        if (scope.value === 'cluster') {
            namespaces = await this.getAllNamespaces();
            resourceTypes = this.getDefaultResourceTypes();
        } else if (scope.value === 'namespaces') {
            const allNamespaces = await this.getAllNamespaces();
            const selected = await vscode.window.showQuickPick(
                allNamespaces.map(ns => ({ label: ns, picked: true })),
                {
                    canPickMany: true,
                    placeHolder: 'Select namespaces to backup'
                }
            );
            
            if (!selected || selected.length === 0) {
                return;
            }
            
            namespaces = selected.map(s => s.label);
            resourceTypes = this.getDefaultResourceTypes();
        } else {
            // Resource-specific backup
            const allNamespaces = await this.getAllNamespaces();
            const nsSelected = await vscode.window.showQuickPick(allNamespaces, {
                placeHolder: 'Select namespace'
            });
            
            if (!nsSelected) {
                return;
            }
            
            namespaces = [nsSelected];
            
            const rtSelected = await vscode.window.showQuickPick(
                this.getAllResourceTypes().map(rt => ({ label: rt, picked: true })),
                {
                    canPickMany: true,
                    placeHolder: 'Select resource types'
                }
            );
            
            if (!rtSelected || rtSelected.length === 0) {
                return;
            }
            
            resourceTypes = rtSelected.map(s => s.label);
        }

        // Get description
        const description = await vscode.window.showInputBox({
            prompt: 'Enter backup description',
            placeHolder: 'e.g., Pre-upgrade backup, Production state'
        });

        if (!description) {
            return;
        }

        // Create backup
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Creating backup...',
            cancellable: false
        }, async (progress) => {
            try {
                await this.createBackup(namespaces, resourceTypes, description);
                vscode.window.showInformationMessage('✅ Backup created successfully');
            } catch (error: any) {
                vscode.window.showErrorMessage(`❌ Backup failed: ${error.message}`);
            }
        });
    }

    /**
     * Create backup
     */
    private async createBackup(
        namespaces: string[],
        resourceTypes: string[],
        description: string
    ): Promise<void> {
        const context = this.kc.getCurrentContext();
        if (!context) {
            throw new Error('No context selected');
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupId = `backup-${timestamp}`;
        const backupPath = path.join(this.backupDir, backupId);

        // Create backup directory
        fs.mkdirSync(backupPath, { recursive: true });

        // Create metadata
        const metadata: BackupMetadata = {
            timestamp: new Date().toISOString(),
            context,
            namespaces,
            resourceTypes,
            description
        };

        fs.writeFileSync(
            path.join(backupPath, 'metadata.json'),
            JSON.stringify(metadata, null, 2)
        );

        // Backup resources
        const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
        const batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
        const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

        for (const namespace of namespaces) {
            const nsPath = path.join(backupPath, namespace);
            fs.mkdirSync(nsPath, { recursive: true });

            for (const resourceType of resourceTypes) {
                try {
                    const resources = await this.getResources(
                        resourceType,
                        namespace,
                        coreApi,
                        appsApi,
                        batchApi,
                        networkingApi
                    );

                    if (resources.length > 0) {
                        const rtPath = path.join(nsPath, `${resourceType}.yaml`);
                        const yamlContent = resources.map(r => yaml.stringify(r)).join('---\n');
                        fs.writeFileSync(rtPath, yamlContent);
                    }
                } catch (error) {
                    console.error(`Failed to backup ${resourceType} in ${namespace}:`, error);
                }
            }
        }
    }

    /**
     * Restore backup
     */
    private async restoreBackup(backupId: string): Promise<void> {
        const confirmation = await vscode.window.showWarningMessage(
            `⚠️ This will restore resources from backup "${backupId}". Existing resources may be overwritten. Continue?`,
            { modal: true },
            'Restore',
            'Cancel'
        );

        if (confirmation !== 'Restore') {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Restoring backup...',
            cancellable: false
        }, async (progress) => {
            try {
                const backupPath = path.join(this.backupDir, backupId);
                const metadataPath = path.join(backupPath, 'metadata.json');
                
                if (!fs.existsSync(metadataPath)) {
                    throw new Error('Invalid backup: metadata not found');
                }

                const metadata: BackupMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

                // Restore namespaces first
                for (const namespace of metadata.namespaces) {
                    await this.ensureNamespace(namespace);
                }

                // Restore resources
                let restored = 0;
                for (const namespace of metadata.namespaces) {
                    const nsPath = path.join(backupPath, namespace);
                    
                    if (!fs.existsSync(nsPath)) {
                        continue;
                    }

                    const files = fs.readdirSync(nsPath);
                    
                    for (const file of files) {
                        if (!file.endsWith('.yaml')) {
                            continue;
                        }

                        const filePath = path.join(nsPath, file);
                        const content = fs.readFileSync(filePath, 'utf8');
                        
                        try {
                            await this.applyYaml(content);
                            restored++;
                        } catch (error) {
                            console.error(`Failed to restore ${file}:`, error);
                        }
                    }
                }

                vscode.window.showInformationMessage(
                    `✅ Backup restored successfully. ${restored} resource type(s) restored.`
                );
            } catch (error: any) {
                vscode.window.showErrorMessage(`❌ Restore failed: ${error.message}`);
            }
        });
    }

    /**
     * Delete backup
     */
    private async deleteBackup(backupId: string): Promise<void> {
        const confirmation = await vscode.window.showWarningMessage(
            `Delete backup "${backupId}"?`,
            { modal: true },
            'Delete',
            'Cancel'
        );

        if (confirmation !== 'Delete') {
            return;
        }

        try {
            const backupPath = path.join(this.backupDir, backupId);
            this.deleteRecursive(backupPath);
            vscode.window.showInformationMessage('✅ Backup deleted');
        } catch (error: any) {
            vscode.window.showErrorMessage(`❌ Failed to delete backup: ${error.message}`);
        }
    }

    /**
     * Export backup to archive
     */
    private async exportBackup(backupId: string): Promise<void> {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(os.homedir(), `${backupId}.tar.gz`)),
            filters: {
                'Compressed Archive': ['tar.gz', 'tgz']
            }
        });

        if (!uri) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Exporting backup...'
        }, async () => {
            try {
                const backupPath = path.join(this.backupDir, backupId);
                const { exec } = require('child_process');
                const command = `tar -czf "${uri.fsPath}" -C "${this.backupDir}" "${backupId}"`;

                await new Promise((resolve, reject) => {
                    exec(command, (error: any, stdout: string, stderr: string) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(stdout);
                        }
                    });
                });

                vscode.window.showInformationMessage('✅ Backup exported successfully');
            } catch (error: any) {
                vscode.window.showErrorMessage(`❌ Export failed: ${error.message}`);
            }
        });
    }

    /**
     * Import backup from archive
     */
    private async importBackup(): Promise<void> {
        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'Compressed Archive': ['tar.gz', 'tgz']
            }
        });

        if (!uri || uri.length === 0) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Importing backup...'
        }, async () => {
            try {
                const { exec } = require('child_process');
                const command = `tar -xzf "${uri[0].fsPath}" -C "${this.backupDir}"`;

                await new Promise((resolve, reject) => {
                    exec(command, (error: any, stdout: string, stderr: string) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(stdout);
                        }
                    });
                });

                vscode.window.showInformationMessage('✅ Backup imported successfully');
            } catch (error: any) {
                vscode.window.showErrorMessage(`❌ Import failed: ${error.message}`);
            }
        });
    }

    /**
     * List all backups
     */
    private async listBackups(): Promise<any[]> {
        const backups: any[] = [];

        if (!fs.existsSync(this.backupDir)) {
            return backups;
        }

        const dirs = fs.readdirSync(this.backupDir);

        for (const dir of dirs) {
            const backupPath = path.join(this.backupDir, dir);
            const metadataPath = path.join(backupPath, 'metadata.json');

            if (fs.existsSync(metadataPath)) {
                try {
                    const metadata: BackupMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                    const stats = fs.statSync(backupPath);
                    const size = this.getFolderSize(backupPath);

                    backups.push({
                        id: dir,
                        ...metadata,
                        size: this.formatBytes(size),
                        created: stats.birthtime.toISOString()
                    });
                } catch (error) {
                    console.error(`Failed to read backup metadata for ${dir}:`, error);
                }
            }
        }

        // Sort by timestamp descending
        backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        return backups;
    }

    // Helper methods

    private async getAllNamespaces(): Promise<string[]> {
        const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        const response = await coreApi.listNamespace();
        return response.body.items.map(ns => ns.metadata?.name || '').filter(n => n);
    }

    private getDefaultResourceTypes(): string[] {
        return [
            'deployments',
            'statefulsets',
            'daemonsets',
            'services',
            'configmaps',
            'secrets',
            'ingresses',
            'persistentvolumeclaims',
            'jobs',
            'cronjobs'
        ];
    }

    private getAllResourceTypes(): string[] {
        return [
            'pods',
            'deployments',
            'statefulsets',
            'daemonsets',
            'replicasets',
            'services',
            'configmaps',
            'secrets',
            'ingresses',
            'persistentvolumeclaims',
            'jobs',
            'cronjobs',
            'horizontalpodautoscalers',
            'networkpolicies',
            'serviceaccounts',
            'roles',
            'rolebindings'
        ];
    }

    private async getResources(
        resourceType: string,
        namespace: string,
        coreApi: k8s.CoreV1Api,
        appsApi: k8s.AppsV1Api,
        batchApi: k8s.BatchV1Api,
        networkingApi: k8s.NetworkingV1Api
    ): Promise<BackupResource[]> {
        let response: any;

        try {
            switch (resourceType) {
                case 'pods':
                    response = await coreApi.listNamespacedPod(namespace);
                    break;
                case 'deployments':
                    response = await appsApi.listNamespacedDeployment(namespace);
                    break;
                case 'statefulsets':
                    response = await appsApi.listNamespacedStatefulSet(namespace);
                    break;
                case 'daemonsets':
                    response = await appsApi.listNamespacedDaemonSet(namespace);
                    break;
                case 'services':
                    response = await coreApi.listNamespacedService(namespace);
                    break;
                case 'configmaps':
                    response = await coreApi.listNamespacedConfigMap(namespace);
                    break;
                case 'secrets':
                    response = await coreApi.listNamespacedSecret(namespace);
                    break;
                case 'ingresses':
                    response = await networkingApi.listNamespacedIngress(namespace);
                    break;
                case 'persistentvolumeclaims':
                    response = await coreApi.listNamespacedPersistentVolumeClaim(namespace);
                    break;
                case 'jobs':
                    response = await batchApi.listNamespacedJob(namespace);
                    break;
                case 'cronjobs':
                    response = await batchApi.listNamespacedCronJob(namespace);
                    break;
                default:
                    return [];
            }

            // Clean up resources for backup
            return response.body.items.map((item: any) => this.cleanResource(item));
        } catch (error) {
            console.error(`Failed to get ${resourceType}:`, error);
            return [];
        }
    }

    private cleanResource(resource: any): BackupResource {
        const cleaned: any = {
            apiVersion: resource.apiVersion,
            kind: resource.kind,
            metadata: {
                name: resource.metadata?.name,
                namespace: resource.metadata?.namespace,
                labels: resource.metadata?.labels,
                annotations: resource.metadata?.annotations
            }
        };

        // Remove runtime fields
        delete cleaned.metadata?.resourceVersion;
        delete cleaned.metadata?.uid;
        delete cleaned.metadata?.selfLink;
        delete cleaned.metadata?.creationTimestamp;
        delete cleaned.metadata?.generation;
        delete cleaned.metadata?.managedFields;

        if (resource.spec) {
            cleaned.spec = resource.spec;
        }

        if (resource.data) {
            cleaned.data = resource.data;
        }

        return cleaned;
    }

    private async ensureNamespace(namespace: string): Promise<void> {
        try {
            const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
            await coreApi.readNamespace(namespace);
        } catch (error) {
            // Namespace doesn't exist, create it
            const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
            await coreApi.createNamespace({
                metadata: { name: namespace }
            });
        }
    }

    private async applyYaml(yamlContent: string): Promise<void> {
        const tmpFile = path.join(os.tmpdir(), `restore-${Date.now()}.yaml`);
        fs.writeFileSync(tmpFile, yamlContent);

        const { exec } = require('child_process');
        const command = `kubectl apply -f ${tmpFile}`;

        await new Promise((resolve, reject) => {
            exec(command, { env: { ...process.env, KUBECONFIG: this.getKubeconfigPath() } },
                (error: any, stdout: string, stderr: string) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve(stdout);
                }
            });
        });

        fs.unlinkSync(tmpFile);
    }

    private getKubeconfigPath(): string {
        const config = vscode.workspace.getConfiguration('clusterPilot');
        let kubeconfigPath = config.get<string>('kubeconfigPath', '~/.kube/config');

        if (kubeconfigPath.startsWith('~')) {
            kubeconfigPath = path.join(os.homedir(), kubeconfigPath.slice(1));
        }

        return kubeconfigPath;
    }

    private ensureBackupDirectory(): void {
        try {
            if (!fs.existsSync(this.backupDir)) {
                fs.mkdirSync(this.backupDir, { recursive: true });
            }
            // Test write permissions
            const testFile = path.join(this.backupDir, '.write-test');
            fs.writeFileSync(testFile, '');
            fs.unlinkSync(testFile);
        } catch (error: any) {
            // If we can't create/write to the configured directory, fall back to a safe location
            const fallbackDir = path.join(os.homedir(), '.jas-cluster-pilot', 'backups');
            console.warn(`Cannot use backup directory ${this.backupDir}: ${error.message}. Falling back to ${fallbackDir}`);
            vscode.window.showWarningMessage(
                `Cannot access backup directory. Using fallback location: ${fallbackDir}`,
                'Open Settings'
            ).then(selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'clusterPilot.backupDirectory');
                }
            });
            
            this.backupDir = fallbackDir;
            try {
                if (!fs.existsSync(this.backupDir)) {
                    fs.mkdirSync(this.backupDir, { recursive: true });
                }
            } catch (fallbackError: any) {
                vscode.window.showErrorMessage(`Failed to create backup directory: ${fallbackError.message}`);
                throw fallbackError;
            }
        }
    }

    private deleteRecursive(dirPath: string): void {
        if (fs.existsSync(dirPath)) {
            fs.readdirSync(dirPath).forEach(file => {
                const curPath = path.join(dirPath, file);
                if (fs.lstatSync(curPath).isDirectory()) {
                    this.deleteRecursive(curPath);
                } else {
                    fs.unlinkSync(curPath);
                }
            });
            fs.rmdirSync(dirPath);
        }
    }

    private getFolderSize(dirPath: string): number {
        let size = 0;

        if (fs.existsSync(dirPath)) {
            const files = fs.readdirSync(dirPath);
            
            for (const file of files) {
                const filePath = path.join(dirPath, file);
                const stats = fs.lstatSync(filePath);
                
                if (stats.isDirectory()) {
                    size += this.getFolderSize(filePath);
                } else {
                    size += stats.size;
                }
            }
        }

        return size;
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    private async getBackupPanelHtml(): Promise<string> {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Backup & Restore</title>
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
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .actions {
            display: flex;
            gap: 10px;
        }
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .secondary-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .backup-grid {
            display: grid;
            gap: 15px;
            margin-top: 20px;
        }
        .backup-card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 15px;
            background-color: var(--vscode-editor-background);
        }
        .backup-card:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .backup-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .backup-id {
            font-size: 16px;
            font-weight: bold;
        }
        .backup-actions {
            display: flex;
            gap: 8px;
        }
        .backup-actions button {
            padding: 4px 12px;
            font-size: 12px;
        }
        .backup-info {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
            font-size: 13px;
            margin-top: 10px;
        }
        .info-item {
            display: flex;
            flex-direction: column;
        }
        .info-label {
            opacity: 0.7;
            font-size: 11px;
            margin-bottom: 3px;
        }
        .info-value {
            font-weight: 500;
        }
        .description {
            margin-top: 10px;
            padding: 8px;
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            border-radius: 3px;
            font-style: italic;
        }
        .empty-state {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            margin-right: 5px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title">
            💾 Backup & Restore Manager
        </div>
        <div class="actions">
            <button onclick="createBackup()">+ Create Backup</button>
            <button class="secondary-button" onclick="importBackup()">📥 Import</button>
        </div>
    </div>

    <div id="backupList" class="backup-grid">
        <div class="empty-state">
            <h3>No backups found</h3>
            <p>Create your first backup to get started</p>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function createBackup() {
            vscode.postMessage({ command: 'createBackup' });
        }

        function restoreBackup(backupId) {
            vscode.postMessage({ command: 'restoreBackup', backupId });
        }

        function deleteBackup(backupId) {
            vscode.postMessage({ command: 'deleteBackup', backupId });
        }

        function exportBackup(backupId) {
            vscode.postMessage({ command: 'exportBackup', backupId });
        }

        function importBackup() {
            vscode.postMessage({ command: 'importBackup' });
        }

        function refreshBackups() {
            vscode.postMessage({ command: 'listBackups' });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'backupsList') {
                renderBackups(message.backups);
            } else if (message.command === 'refresh') {
                refreshBackups();
            }
        });

        function renderBackups(backups) {
            const container = document.getElementById('backupList');
            
            if (backups.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <h3>No backups found</h3>
                        <p>Create your first backup to get started</p>
                    </div>
                \`;
                return;
            }

            container.innerHTML = backups.map(backup => \`
                <div class="backup-card">
                    <div class="backup-header">
                        <div class="backup-id">\${backup.id}</div>
                        <div class="backup-actions">
                            <button onclick="restoreBackup('\${backup.id}')">🔄 Restore</button>
                            <button class="secondary-button" onclick="exportBackup('\${backup.id}')">📤 Export</button>
                            <button class="secondary-button" onclick="deleteBackup('\${backup.id}')">🗑️ Delete</button>
                        </div>
                    </div>
                    <div class="backup-info">
                        <div class="info-item">
                            <div class="info-label">Context</div>
                            <div class="info-value">\${backup.context}</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">Created</div>
                            <div class="info-value">\${new Date(backup.timestamp).toLocaleString()}</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">Namespaces</div>
                            <div class="info-value">
                                \${backup.namespaces.slice(0, 3).map(ns => \`<span class="badge">\${ns}</span>\`).join('')}
                                \${backup.namespaces.length > 3 ? \`<span class="badge">+\${backup.namespaces.length - 3} more</span>\` : ''}
                            </div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">Size</div>
                            <div class="info-value">\${backup.size}</div>
                        </div>
                    </div>
                    <div class="description">\${backup.description}</div>
                </div>
            \`).join('');
        }

        // Initial load
        refreshBackups();
    </script>
</body>
</html>`;
    }

    dispose(): void {
        // Cleanup if needed
    }
}
