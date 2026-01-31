import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';

export class PVManagerPanel {
    private panel: vscode.WebviewPanel;
    private pvs: k8s.V1PersistentVolume[] = [];
    private pvcs: k8s.V1PersistentVolumeClaim[] = [];

    constructor(
        private context: vscode.ExtensionContext,
        private k8sClient: K8sClient
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'pvManager',
            'Persistent Volume Manager',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.refresh();

        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            undefined,
            context.subscriptions
        );
    }

    private async refresh(): Promise<void> {
        try {
            this.pvs = await this.k8sClient.getPersistentVolumes();
            this.pvcs = await this.k8sClient.getPersistentVolumeClaims();
            this.panel.webview.html = this.getHtmlContent();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to fetch PV data: ${error}`);
        }
    }

    private async handleMessage(message: { 
        command: string; 
        name?: string; 
        namespace?: string;
        policy?: string;
        yaml?: string;
    }): Promise<void> {
        switch (message.command) {
            case 'refresh':
                await this.refresh();
                break;
            case 'deletePV':
                if (message.name) {
                    await this.deletePV(message.name);
                }
                break;
            case 'deletePVC':
                if (message.name && message.namespace) {
                    await this.deletePVC(message.name, message.namespace);
                }
                break;
            case 'updateReclaimPolicy':
                if (message.name && message.policy) {
                    await this.updateReclaimPolicy(message.name, message.policy);
                }
                break;
            case 'viewYaml':
                if (message.name) {
                    await this.viewPVYaml(message.name);
                }
                break;
            case 'createPV':
                if (message.yaml) {
                    await this.createPV(message.yaml);
                }
                break;
            case 'showBindings':
                await this.showBindingsReport();
                break;
        }
    }

    private async deletePV(name: string): Promise<void> {
        try {
            await this.k8sClient.deleteResource('PersistentVolume', name, undefined);
            vscode.window.showInformationMessage(`PersistentVolume ${name} deleted`);
            await this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete PV: ${error}`);
        }
    }

    private async deletePVC(name: string, namespace: string): Promise<void> {
        try {
            await this.k8sClient.deleteResource('PersistentVolumeClaim', name, namespace);
            vscode.window.showInformationMessage(`PersistentVolumeClaim ${name} deleted`);
            await this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete PVC: ${error}`);
        }
    }

    private async updateReclaimPolicy(name: string, policy: string): Promise<void> {
        try {
            const pv = this.pvs.find(p => p.metadata?.name === name);
            if (pv) {
                pv.spec = pv.spec || {};
                pv.spec.persistentVolumeReclaimPolicy = policy as any;
                await this.k8sClient.updatePersistentVolume(name, pv);
                vscode.window.showInformationMessage(`Reclaim policy updated to "${policy}"`);
                await this.refresh();
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update reclaim policy: ${error}`);
        }
    }

    private async viewPVYaml(name: string): Promise<void> {
        try {
            const pv = this.pvs.find(p => p.metadata?.name === name);
            if (pv) {
                const doc = await vscode.workspace.openTextDocument({
                    content: JSON.stringify(pv, null, 2),
                    language: 'json'
                });
                await vscode.window.showTextDocument(doc);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view PV YAML: ${error}`);
        }
    }

    private async createPV(yaml: string): Promise<void> {
        try {
            const pv = JSON.parse(yaml);
            await this.k8sClient.createPersistentVolume(pv);
            vscode.window.showInformationMessage('PersistentVolume created successfully');
            await this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create PV: ${error}`);
        }
    }

    private async showBindingsReport(): Promise<void> {
        try {
            let report = '# PV/PVC Binding Report\n\n';
            
            // Bound PVs
            const boundPVs = this.pvs.filter(pv => pv.status?.phase === 'Bound');
            report += `## Bound Volumes (${boundPVs.length})\n\n`;
            for (const pv of boundPVs) {
                const pvName = pv.metadata?.name || 'Unknown';
                const claim = pv.spec?.claimRef;
                const claimStr = claim ? `${claim.namespace}/${claim.name}` : 'None';
                const capacity = pv.spec?.capacity?.storage || 'Unknown';
                report += `- **${pvName}** (${capacity}) → ${claimStr}\n`;
            }

            // Available PVs
            const availablePVs = this.pvs.filter(pv => pv.status?.phase === 'Available');
            report += `\n## Available Volumes (${availablePVs.length})\n\n`;
            for (const pv of availablePVs) {
                const pvName = pv.metadata?.name || 'Unknown';
                const capacity = pv.spec?.capacity?.storage || 'Unknown';
                const storageClass = pv.spec?.storageClassName || 'default';
                report += `- **${pvName}** (${capacity}, class: ${storageClass})\n`;
            }

            // Pending PVCs
            const pendingPVCs = this.pvcs.filter(pvc => pvc.status?.phase === 'Pending');
            report += `\n## Pending Claims (${pendingPVCs.length})\n\n`;
            for (const pvc of pendingPVCs) {
                const pvcName = pvc.metadata?.name || 'Unknown';
                const ns = pvc.metadata?.namespace || 'default';
                const request = pvc.spec?.resources?.requests?.storage || 'Unknown';
                const storageClass = pvc.spec?.storageClassName || 'default';
                report += `- **${ns}/${pvcName}** (requested: ${request}, class: ${storageClass})\n`;
            }

            // Released/Failed PVs
            const problemPVs = this.pvs.filter(pv => 
                pv.status?.phase === 'Released' || pv.status?.phase === 'Failed'
            );
            if (problemPVs.length > 0) {
                report += `\n## Problem Volumes (${problemPVs.length})\n\n`;
                for (const pv of problemPVs) {
                    const pvName = pv.metadata?.name || 'Unknown';
                    const status = pv.status?.phase || 'Unknown';
                    const reason = pv.status?.reason || 'No reason provided';
                    report += `- **${pvName}** (${status}): ${reason}\n`;
                }
            }

            const doc = await vscode.workspace.openTextDocument({
                content: report,
                language: 'markdown'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate binding report: ${error}`);
        }
    }

    private getHtmlContent(): string {
        const totalCapacity = this.pvs.reduce((sum, pv) => {
            const capacity = pv.spec?.capacity?.storage || '0';
            return sum + this.parseStorage(capacity);
        }, 0);

        const usedCapacity = this.pvcs.reduce((sum, pvc) => {
            const request = pvc.spec?.resources?.requests?.storage || '0';
            return sum + this.parseStorage(request);
        }, 0);

        const boundPVs = this.pvs.filter(pv => pv.status?.phase === 'Bound').length;
        const availablePVs = this.pvs.filter(pv => pv.status?.phase === 'Available').length;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PV Manager</title>
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
            margin-bottom: 30px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .stat-card {
            padding: 15px;
            background-color: var(--vscode-input-background);
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }
        .stat-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 5px;
        }
        .stat-value {
            font-size: 24px;
            font-weight: 600;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
        }
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        th {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            font-weight: 600;
        }
        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .badge {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 600;
        }
        .badge.bound { background-color: #4CAF50; color: white; }
        .badge.available { background-color: #2196F3; color: white; }
        .badge.released { background-color: #FF9800; color: white; }
        .badge.failed { background-color: #F44336; color: white; }
        .badge.pending { background-color: #FFC107; color: black; }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 3px;
            cursor: pointer;
            margin-right: 5px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button.danger {
            background-color: #F44336;
            color: white;
        }
        button.danger:hover {
            background-color: #D32F2F;
        }
        h2 {
            margin-top: 40px;
            margin-bottom: 15px;
        }
        .tabs {
            display: flex;
            gap: 5px;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin: 20px 0;
        }
        .tab {
            padding: 10px 20px;
            cursor: pointer;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
        }
        .tab.active {
            border-bottom: 2px solid var(--vscode-textLink-foreground);
            color: var(--vscode-textLink-foreground);
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        select {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 4px 8px;
            border-radius: 2px;
            margin-right: 5px;
        }
        .actions {
            display: flex;
            gap: 5px;
            align-items: center;
        }
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 1000;
        }
        .modal.active {
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .modal-content {
            background-color: var(--vscode-editor-background);
            padding: 20px;
            border-radius: 4px;
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        }
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        .close-button {
            background: transparent;
            color: var(--vscode-foreground);
            border: none;
            font-size: 1.5em;
            cursor: pointer;
            padding: 0;
        }
        textarea {
            width: 100%;
            min-height: 300px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 10px;
            font-family: 'Courier New', monospace;
            font-size: 0.9em;
        }
        .template-selector {
            margin-bottom: 20px;
        }
        .template-selector select {
            width: 100%;
            padding: 8px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>💾 Persistent Volume Manager</h1>
        <div>
            <button onclick="refresh()">Refresh</button>
            <button onclick="showBindingsReport()">View Bindings</button>
            <button onclick="showCreateModal()">Create PV</button>
        </div>
    </div>

    <div class="stats">
        <div class="stat-card">
            <div class="stat-label">Total PVs</div>
            <div class="stat-value">${this.pvs.length}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Bound / Available</div>
            <div class="stat-value">${boundPVs} / ${availablePVs}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Total Capacity</div>
            <div class="stat-value">${this.formatStorage(totalCapacity)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Used Capacity</div>
            <div class="stat-value">${this.formatStorage(usedCapacity)}</div>
        </div>
    </div>

    <div class="tabs">
        <button class="tab active" onclick="switchTab('pvs')">Persistent Volumes</button>
        <button class="tab" onclick="switchTab('pvcs')">Claims</button>
        <button class="tab" onclick="switchTab('lifecycle')">Lifecycle</button>
    </div>

    <div id="pvs-tab" class="tab-content active">
        <table>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Capacity</th>
                    <th>Access Modes</th>
                    <th>Reclaim Policy</th>
                    <th>Status</th>
                    <th>Claim</th>
                    <th>Storage Class</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${this.pvs.map(pv => this.renderPVRow(pv)).join('')}
            </tbody>
        </table>
    </div>

    <div id="pvcs-tab" class="tab-content">
        <table>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Namespace</th>
                    <th>Status</th>
                    <th>Volume</th>
                    <th>Capacity</th>
                    <th>Access Modes</th>
                    <th>Storage Class</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${this.pvcs.map(pvc => this.renderPVCRow(pvc)).join('')}
            </tbody>
        </table>
    </div>

    <div id="lifecycle-tab" class="tab-content">
        <h2>PV Lifecycle States</h2>
        <div style="margin-top: 20px;">
            <h3>Available</h3>
            <p>A free resource not yet bound to a claim. The PV is ready to be claimed.</p>
            
            <h3>Bound</h3>
            <p>The volume is bound to a PVC and in use.</p>
            
            <h3>Released</h3>
            <p>The claim has been deleted, but the resource is not yet reclaimed by the cluster.</p>
            
            <h3>Failed</h3>
            <p>The volume has failed its automatic reclamation.</p>
        </div>

        <h2 style="margin-top: 30px;">Reclaim Policies</h2>
        <div style="margin-top: 20px;">
            <h3>Retain</h3>
            <p>When a PVC is deleted, the PV moves to "Released" state. Manual cleanup is required. The data is preserved.</p>
            
            <h3>Delete</h3>
            <p>Both the PV and the underlying storage asset (e.g., AWS EBS, GCE PD) are deleted when the PVC is deleted.</p>
            
            <h3>Recycle (Deprecated)</h3>
            <p>Performs a basic scrub (rm -rf /thevolume/*) and makes the volume available again for a new claim.</p>
        </div>
    </div>

    <!-- Create PV Modal -->
    <div id="createModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>Create Persistent Volume</h2>
                <button class="close-button" onclick="closeCreateModal()">&times;</button>
            </div>
            <div class="template-selector">
                <label>Template:</label>
                <select id="templateSelect" onchange="loadTemplate()">
                    <option value="hostpath">HostPath</option>
                    <option value="nfs">NFS</option>
                    <option value="local">Local</option>
                    <option value="csi">CSI Driver</option>
                </select>
            </div>
            <textarea id="pvYaml"></textarea>
            <div style="margin-top: 20px; text-align: right;">
                <button onclick="closeCreateModal()">Cancel</button>
                <button onclick="createPV()">Create</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        const templates = {
            hostpath: \`{
  "apiVersion": "v1",
  "kind": "PersistentVolume",
  "metadata": { "name": "pv-hostpath" },
  "spec": {
    "capacity": { "storage": "10Gi" },
    "accessModes": ["ReadWriteOnce"],
    "persistentVolumeReclaimPolicy": "Retain",
    "storageClassName": "manual",
    "hostPath": { "path": "/mnt/data" }
  }
}\`,
            nfs: \`{
  "apiVersion": "v1",
  "kind": "PersistentVolume",
  "metadata": { "name": "pv-nfs" },
  "spec": {
    "capacity": { "storage": "100Gi" },
    "accessModes": ["ReadWriteMany"],
    "persistentVolumeReclaimPolicy": "Retain",
    "storageClassName": "nfs",
    "nfs": { "server": "nfs-server.example.com", "path": "/exports/data" }
  }
}\`,
            local: \`{
  "apiVersion": "v1",
  "kind": "PersistentVolume",
  "metadata": { "name": "pv-local" },
  "spec": {
    "capacity": { "storage": "50Gi" },
    "accessModes": ["ReadWriteOnce"],
    "persistentVolumeReclaimPolicy": "Delete",
    "storageClassName": "local-storage",
    "local": { "path": "/mnt/disks/ssd1" },
    "nodeAffinity": {
      "required": {
        "nodeSelectorTerms": [{
          "matchExpressions": [{
            "key": "kubernetes.io/hostname",
            "operator": "In",
            "values": ["node1"]
          }]
        }]
      }
    }
  }
}\`,
            csi: \`{
  "apiVersion": "v1",
  "kind": "PersistentVolume",
  "metadata": { "name": "pv-csi" },
  "spec": {
    "capacity": { "storage": "10Gi" },
    "accessModes": ["ReadWriteOnce"],
    "persistentVolumeReclaimPolicy": "Delete",
    "storageClassName": "csi-storage",
    "csi": {
      "driver": "csi.example.com",
      "volumeHandle": "volume-id",
      "fsType": "ext4"
    }
  }
}\`
        };

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabName + '-tab').classList.add('active');
        }

        function showBindingsReport() {
            vscode.postMessage({ command: 'showBindings' });
        }

        function showCreateModal() {
            document.getElementById('createModal').classList.add('active');
            loadTemplate();
        }

        function closeCreateModal() {
            document.getElementById('createModal').classList.remove('active');
        }

        function loadTemplate() {
            const templateType = document.getElementById('templateSelect').value;
            document.getElementById('pvYaml').value = templates[templateType];
        }

        function createPV() {
            const yaml = document.getElementById('pvYaml').value;
            vscode.postMessage({ command: 'createPV', yaml });
            closeCreateModal();
        }

        function viewYaml(name) {
            vscode.postMessage({ command: 'viewYaml', name });
        }

        function updateReclaimPolicy(name, policy) {
            if (policy) {
                vscode.postMessage({ command: 'updateReclaimPolicy', name, policy });
            }
        }

        function deletePV(name) {
            if (confirm(\`Delete PV \${name}?\`)) {
                vscode.postMessage({ command: 'deletePV', name });
            }
        }

        function deletePVC(name, namespace) {
            if (confirm(\`Delete PVC \${name} in namespace \${namespace}?\`)) {
                vscode.postMessage({ command: 'deletePVC', name, namespace });
            }
        }
    </script>
</body>
</html>`;
    }

    private renderPVRow(pv: k8s.V1PersistentVolume): string {
        const name = pv.metadata?.name || '';
        const capacity = pv.spec?.capacity?.storage || 'N/A';
        const accessModes = pv.spec?.accessModes?.join(', ') || 'N/A';
        const reclaimPolicy = pv.spec?.persistentVolumeReclaimPolicy || 'N/A';
        const status = pv.status?.phase || 'Unknown';
        const claim = pv.spec?.claimRef ? `${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}` : '-';
        const storageClass = pv.spec?.storageClassName || '-';

        return `
            <tr>
                <td><strong>${this.escapeHtml(name)}</strong></td>
                <td>${capacity}</td>
                <td>${accessModes}</td>
                <td>${reclaimPolicy}</td>
                <td><span class="badge ${status.toLowerCase()}">${status}</span></td>
                <td>${this.escapeHtml(claim)}</td>
                <td>${this.escapeHtml(storageClass)}</td>
                <td>
                    <div class="actions">
                        <button onclick="viewYaml('${this.escapeHtml(name)}')">View</button>
                        <select onchange="updateReclaimPolicy('${this.escapeHtml(name)}', this.value); this.selectedIndex=0;">
                            <option value="">Policy...</option>
                            <option value="Retain">Retain</option>
                            <option value="Delete">Delete</option>
                            <option value="Recycle">Recycle</option>
                        </select>
                        <button class="danger" onclick="deletePV('${this.escapeHtml(name)}')" 
                            ${status === 'Bound' ? 'disabled' : ''}>Delete</button>
                    </div>
                </td>
            </tr>
        `;
    }

    private renderPVCRow(pvc: k8s.V1PersistentVolumeClaim): string {
        const name = pvc.metadata?.name || '';
        const namespace = pvc.metadata?.namespace || '';
        const status = pvc.status?.phase || 'Unknown';
        const volumeName = pvc.spec?.volumeName || '-';
        const capacity = pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || 'N/A';
        const accessModes = pvc.spec?.accessModes?.join(', ') || 'N/A';
        const storageClass = pvc.spec?.storageClassName || '-';

        return `
            <tr>
                <td><strong>${this.escapeHtml(name)}</strong></td>
                <td>${this.escapeHtml(namespace)}</td>
                <td><span class="badge ${status.toLowerCase()}">${status}</span></td>
                <td>${this.escapeHtml(volumeName)}</td>
                <td>${capacity}</td>
                <td>${accessModes}</td>
                <td>${this.escapeHtml(storageClass)}</td>
                <td>
                    <button class="danger" onclick="deletePVC('${this.escapeHtml(name)}', '${this.escapeHtml(namespace)}')">Delete</button>
                </td>
            </tr>
        `;
    }

    private parseStorage(storage: string): number {
        const units: Record<string, number> = {
            Ki: 1024,
            Mi: 1024 ** 2,
            Gi: 1024 ** 3,
            Ti: 1024 ** 4,
            Pi: 1024 ** 5
        };

        for (const [unit, multiplier] of Object.entries(units)) {
            if (storage.endsWith(unit)) {
                return parseFloat(storage.slice(0, -2)) * multiplier;
            }
        }

        return parseFloat(storage) || 0;
    }

    private formatStorage(bytes: number): string {
        const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
        let value = bytes;
        let unitIndex = 0;

        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }

        return `${value.toFixed(2)} ${units[unitIndex]}`;
    }

    private escapeHtml(text: string): string {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
}
