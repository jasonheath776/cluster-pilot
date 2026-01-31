import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';

interface SearchResult {
    kind: string;
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
    status?: string;
}

export class GlobalSearchPanel {
    public static currentPanel: GlobalSearchPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, k8sClient: K8sClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (GlobalSearchPanel.currentPanel) {
            GlobalSearchPanel.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'globalSearch',
            'Global Resource Search',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        GlobalSearchPanel.currentPanel = new GlobalSearchPanel(panel, extensionUri, k8sClient);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly k8sClient: K8sClient
    ) {
        this.panel = panel;
        this.panel.webview.html = this.getHtmlContent();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'search':
                        await this.performSearch(
                            message.query,
                            message.kinds,
                            message.namespace,
                            message.labelSelector
                        );
                        break;
                    case 'viewResource':
                        await this.viewResource(
                            message.kind,
                            message.name,
                            message.namespace
                        );
                        break;
                    case 'deleteResource':
                        await this.deleteResource(
                            message.kind,
                            message.name,
                            message.namespace
                        );
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    private async performSearch(
        query: string,
        kinds: string[],
        namespace: string,
        labelSelector: string
    ) {
        try {
            const results: SearchResult[] = [];
            const searchKinds = kinds.length > 0 ? kinds : [
                'Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Service',
                'ConfigMap', 'Secret', 'Ingress', 'PersistentVolumeClaim',
                'Job', 'CronJob', 'Namespace'
            ];

            for (const kind of searchKinds) {
                const kindResults = await this.searchByKind(kind, query, namespace, labelSelector);
                results.push(...kindResults);
            }

            this.panel.webview.postMessage({
                command: 'searchResults',
                results: results
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Search failed: ${error}`);
        }
    }

    private async searchByKind(
        kind: string,
        query: string,
        namespace: string,
        labelSelector: string
    ): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        const lowerQuery = query.toLowerCase();

        try {
            switch (kind) {
                case 'Pod': {
                    const pods = await this.k8sClient.getPods(namespace || undefined);
                    pods.forEach(pod => {
                        if (this.matchesSearch(pod.metadata?.name || '', lowerQuery, pod.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'Pod',
                                name: pod.metadata?.name || '',
                                namespace: pod.metadata?.namespace,
                                labels: pod.metadata?.labels,
                                creationTimestamp: pod.metadata?.creationTimestamp?.toISOString(),
                                status: pod.status?.phase
                            });
                        }
                    });
                    break;
                }
                case 'Deployment': {
                    const deployments = await this.k8sClient.getDeployments(namespace || undefined);
                    deployments.forEach(deployment => {
                        if (this.matchesSearch(deployment.metadata?.name || '', lowerQuery, deployment.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'Deployment',
                                name: deployment.metadata?.name || '',
                                namespace: deployment.metadata?.namespace,
                                labels: deployment.metadata?.labels,
                                creationTimestamp: deployment.metadata?.creationTimestamp?.toISOString(),
                                status: `${deployment.status?.readyReplicas || 0}/${deployment.status?.replicas || 0}`
                            });
                        }
                    });
                    break;
                }
                case 'StatefulSet': {
                    const statefulsets = await this.k8sClient.getStatefulSets(namespace || undefined);
                    statefulsets.forEach(sts => {
                        if (this.matchesSearch(sts.metadata?.name || '', lowerQuery, sts.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'StatefulSet',
                                name: sts.metadata?.name || '',
                                namespace: sts.metadata?.namespace,
                                labels: sts.metadata?.labels,
                                creationTimestamp: sts.metadata?.creationTimestamp?.toISOString(),
                                status: `${sts.status?.readyReplicas || 0}/${sts.status?.replicas || 0}`
                            });
                        }
                    });
                    break;
                }
                case 'DaemonSet': {
                    const daemonsets = await this.k8sClient.getDaemonSets(namespace || undefined);
                    daemonsets.forEach(ds => {
                        if (this.matchesSearch(ds.metadata?.name || '', lowerQuery, ds.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'DaemonSet',
                                name: ds.metadata?.name || '',
                                namespace: ds.metadata?.namespace,
                                labels: ds.metadata?.labels,
                                creationTimestamp: ds.metadata?.creationTimestamp?.toISOString(),
                                status: `${ds.status?.numberReady || 0}/${ds.status?.desiredNumberScheduled || 0}`
                            });
                        }
                    });
                    break;
                }
                case 'Service': {
                    const services = await this.k8sClient.getServices(namespace || undefined);
                    services.forEach(svc => {
                        if (this.matchesSearch(svc.metadata?.name || '', lowerQuery, svc.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'Service',
                                name: svc.metadata?.name || '',
                                namespace: svc.metadata?.namespace,
                                labels: svc.metadata?.labels,
                                creationTimestamp: svc.metadata?.creationTimestamp?.toISOString(),
                                status: svc.spec?.type
                            });
                        }
                    });
                    break;
                }
                case 'ConfigMap': {
                    const configmaps = await this.k8sClient.getConfigMaps(namespace || undefined);
                    configmaps.forEach(cm => {
                        if (this.matchesSearch(cm.metadata?.name || '', lowerQuery, cm.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'ConfigMap',
                                name: cm.metadata?.name || '',
                                namespace: cm.metadata?.namespace,
                                labels: cm.metadata?.labels,
                                creationTimestamp: cm.metadata?.creationTimestamp?.toISOString()
                            });
                        }
                    });
                    break;
                }
                case 'Secret': {
                    const secrets = await this.k8sClient.getSecrets(namespace || undefined);
                    secrets.forEach(secret => {
                        if (this.matchesSearch(secret.metadata?.name || '', lowerQuery, secret.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'Secret',
                                name: secret.metadata?.name || '',
                                namespace: secret.metadata?.namespace,
                                labels: secret.metadata?.labels,
                                creationTimestamp: secret.metadata?.creationTimestamp?.toISOString(),
                                status: secret.type
                            });
                        }
                    });
                    break;
                }
                case 'Ingress': {
                    const ingresses = await this.k8sClient.getIngresses(namespace || undefined);
                    ingresses.forEach(ing => {
                        if (this.matchesSearch(ing.metadata?.name || '', lowerQuery, ing.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'Ingress',
                                name: ing.metadata?.name || '',
                                namespace: ing.metadata?.namespace,
                                labels: ing.metadata?.labels,
                                creationTimestamp: ing.metadata?.creationTimestamp?.toISOString()
                            });
                        }
                    });
                    break;
                }
                case 'PersistentVolumeClaim': {
                    const pvcs = await this.k8sClient.getPersistentVolumeClaims(namespace || undefined);
                    pvcs.forEach(pvc => {
                        if (this.matchesSearch(pvc.metadata?.name || '', lowerQuery, pvc.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'PersistentVolumeClaim',
                                name: pvc.metadata?.name || '',
                                namespace: pvc.metadata?.namespace,
                                labels: pvc.metadata?.labels,
                                creationTimestamp: pvc.metadata?.creationTimestamp?.toISOString(),
                                status: pvc.status?.phase
                            });
                        }
                    });
                    break;
                }
                case 'Job': {
                    const jobs = await this.k8sClient.getJobs(namespace || undefined);
                    jobs.forEach(job => {
                        if (this.matchesSearch(job.metadata?.name || '', lowerQuery, job.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'Job',
                                name: job.metadata?.name || '',
                                namespace: job.metadata?.namespace,
                                labels: job.metadata?.labels,
                                creationTimestamp: job.metadata?.creationTimestamp?.toISOString(),
                                status: job.status?.succeeded ? 'Succeeded' : job.status?.failed ? 'Failed' : 'Running'
                            });
                        }
                    });
                    break;
                }
                case 'CronJob': {
                    const cronjobs = await this.k8sClient.getCronJobs(namespace || undefined);
                    cronjobs.forEach(cj => {
                        if (this.matchesSearch(cj.metadata?.name || '', lowerQuery, cj.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'CronJob',
                                name: cj.metadata?.name || '',
                                namespace: cj.metadata?.namespace,
                                labels: cj.metadata?.labels,
                                creationTimestamp: cj.metadata?.creationTimestamp?.toISOString(),
                                status: cj.spec?.suspend ? 'Suspended' : 'Active'
                            });
                        }
                    });
                    break;
                }
                case 'Namespace': {
                    const namespaces = await this.k8sClient.getNamespaces();
                    namespaces.forEach(ns => {
                        if (this.matchesSearch(ns.metadata?.name || '', lowerQuery, ns.metadata?.labels, labelSelector)) {
                            results.push({
                                kind: 'Namespace',
                                name: ns.metadata?.name || '',
                                labels: ns.metadata?.labels,
                                creationTimestamp: ns.metadata?.creationTimestamp?.toISOString(),
                                status: ns.status?.phase
                            });
                        }
                    });
                    break;
                }
            }
        } catch (error) {
            console.error(`Error searching ${kind}:`, error);
        }

        return results;
    }

    private matchesSearch(
        name: string,
        query: string,
        labels?: Record<string, string>,
        labelSelector?: string
    ): boolean {
        // Check name match
        if (!name.toLowerCase().includes(query)) {
            return false;
        }

        // Check label selector if provided
        if (labelSelector && labels) {
            const labelPairs = labelSelector.split(',').map(l => l.trim());
            for (const pair of labelPairs) {
                const [key, value] = pair.split('=').map(s => s.trim());
                if (!labels[key] || labels[key] !== value) {
                    return false;
                }
            }
        }

        return true;
    }

    private async viewResource(kind: string, name: string, namespace?: string) {
        try {
            let resource: any;

            switch (kind) {
                case 'Pod':
                    const pods = await this.k8sClient.getPods(namespace);
                    resource = pods.find(p => p.metadata?.name === name);
                    break;
                case 'Deployment':
                    const deployments = await this.k8sClient.getDeployments(namespace);
                    resource = deployments.find(d => d.metadata?.name === name);
                    break;
                case 'Service':
                    const services = await this.k8sClient.getServices(namespace);
                    resource = services.find(s => s.metadata?.name === name);
                    break;
                // Add other kinds as needed
            }

            if (!resource) {
                vscode.window.showErrorMessage(`Resource ${name} not found`);
                return;
            }

            const yaml = JSON.stringify(resource, null, 2);
            const doc = await vscode.workspace.openTextDocument({
                content: yaml,
                language: 'json'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view resource: ${error}`);
        }
    }

    private async deleteResource(kind: string, name: string, namespace?: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete ${kind} ${name}${namespace ? ` in namespace ${namespace}` : ''}?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            // Use the generic deleteResource method from k8sClient
            await this.k8sClient.deleteResource(kind, name, namespace || 'default');

            vscode.window.showInformationMessage(`${kind} ${name} deleted successfully`);
            
            // Trigger a new search to refresh results
            this.panel.webview.postMessage({ command: 'refreshSearch' });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete resource: ${error}`);
        }
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Global Resource Search</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }
        .search-container {
            margin-bottom: 20px;
        }
        .search-row {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
        }
        input, select {
            flex: 1;
            padding: 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            font-family: var(--vscode-font-family);
        }
        select[multiple] {
            height: 120px;
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
        .results-info {
            margin-bottom: 10px;
            font-size: 14px;
            opacity: 0.8;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        th {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            font-weight: 600;
        }
        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .kind-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 11px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .actions {
            display: flex;
            gap: 5px;
        }
        .actions button {
            padding: 4px 8px;
            font-size: 12px;
        }
        .no-results {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }
        .labels {
            font-size: 11px;
            opacity: 0.7;
        }
    </style>
</head>
<body>
    <h1>Global Resource Search</h1>
    
    <div class="search-container">
        <div class="search-row">
            <input type="text" id="searchQuery" placeholder="Search by name..." />
            <input type="text" id="namespaceFilter" placeholder="Namespace (optional)" />
        </div>
        <div class="search-row">
            <input type="text" id="labelSelector" placeholder="Label selector (e.g., app=myapp,env=prod)" />
        </div>
        <div class="search-row">
            <select id="kindSelector" multiple>
                <option value="Pod" selected>Pod</option>
                <option value="Deployment" selected>Deployment</option>
                <option value="StatefulSet">StatefulSet</option>
                <option value="DaemonSet">DaemonSet</option>
                <option value="Service" selected>Service</option>
                <option value="ConfigMap">ConfigMap</option>
                <option value="Secret">Secret</option>
                <option value="Ingress">Ingress</option>
                <option value="PersistentVolumeClaim">PersistentVolumeClaim</option>
                <option value="Job">Job</option>
                <option value="CronJob">CronJob</option>
                <option value="Namespace">Namespace</option>
            </select>
            <button onclick="search()">Search</button>
        </div>
        <small style="opacity: 0.7;">Hold Ctrl/Cmd to select multiple resource kinds. Leave empty to search all kinds.</small>
    </div>

    <div class="results-info" id="resultsInfo"></div>

    <table id="resultsTable" style="display: none;">
        <thead>
            <tr>
                <th>Kind</th>
                <th>Name</th>
                <th>Namespace</th>
                <th>Labels</th>
                <th>Created</th>
                <th>Status</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody id="resultsBody"></tbody>
    </table>

    <div class="no-results" id="noResults">
        Enter a search query and click Search to find resources across your cluster.
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentResults = [];

        function search() {
            const query = document.getElementById('searchQuery').value;
            const namespace = document.getElementById('namespaceFilter').value;
            const labelSelector = document.getElementById('labelSelector').value;
            const kindSelector = document.getElementById('kindSelector');
            const selectedKinds = Array.from(kindSelector.selectedOptions).map(opt => opt.value);

            if (!query && !labelSelector) {
                alert('Please enter a search query or label selector');
                return;
            }

            vscode.postMessage({
                command: 'search',
                query: query || '',
                kinds: selectedKinds,
                namespace: namespace,
                labelSelector: labelSelector
            });

            document.getElementById('resultsInfo').textContent = 'Searching...';
        }

        function viewResource(kind, name, namespace) {
            vscode.postMessage({
                command: 'viewResource',
                kind: kind,
                name: name,
                namespace: namespace
            });
        }

        function deleteResource(kind, name, namespace) {
            vscode.postMessage({
                command: 'deleteResource',
                kind: kind,
                name: name,
                namespace: namespace
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'searchResults') {
                currentResults = message.results;
                displayResults(message.results);
            } else if (message.command === 'refreshSearch') {
                search();
            }
        });

        function displayResults(results) {
            const table = document.getElementById('resultsTable');
            const tbody = document.getElementById('resultsBody');
            const noResults = document.getElementById('noResults');
            const resultsInfo = document.getElementById('resultsInfo');

            if (results.length === 0) {
                table.style.display = 'none';
                noResults.style.display = 'block';
                noResults.textContent = 'No resources found matching your search criteria.';
                resultsInfo.textContent = '';
                return;
            }

            noResults.style.display = 'none';
            table.style.display = 'table';
            resultsInfo.textContent = \`Found \${results.length} resource(s)\`;

            tbody.innerHTML = results.map(result => {
                const labels = result.labels 
                    ? Object.entries(result.labels).map(([k, v]) => \`\${k}=\${v}\`).join(', ')
                    : '-';
                
                const created = result.creationTimestamp 
                    ? new Date(result.creationTimestamp).toLocaleString()
                    : '-';

                const namespace = result.namespace || '-';
                const status = result.status || '-';

                return \`
                    <tr>
                        <td><span class="kind-badge">\${result.kind}</span></td>
                        <td>\${result.name}</td>
                        <td>\${namespace}</td>
                        <td class="labels">\${labels}</td>
                        <td>\${created}</td>
                        <td>\${status}</td>
                        <td>
                            <div class="actions">
                                <button onclick="viewResource('\${result.kind}', '\${result.name}', '\${result.namespace}')">View</button>
                                \${result.kind !== 'Namespace' ? \`<button onclick="deleteResource('\${result.kind}', '\${result.name}', '\${result.namespace}')">Delete</button>\` : ''}
                            </div>
                        </td>
                    </tr>
                \`;
            }).join('');
        }

        // Allow Enter key to trigger search
        document.getElementById('searchQuery').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                search();
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        GlobalSearchPanel.currentPanel = undefined;

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
