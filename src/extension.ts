import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { ClusterProvider } from './providers/clusterProvider';
import { ResourceProvider } from './providers/resourceProvider';
import { CRDProvider } from './providers/crdProvider';
import { HelmProvider } from './providers/helmProvider';
import { RBACProvider } from './providers/rbacProvider';
import { JobProvider } from './providers/jobProvider';
import { NamespaceProvider } from './providers/namespaceProvider';
import { NodeProvider } from './providers/nodeProvider';
import { KubeconfigManager } from './utils/kubeconfig';
import { K8sClient } from './utils/k8sClient';
import { bypassProxyForLocalHosts } from './utils/proxyBypass';
import { PortForwardManager } from './utils/portForwardManager';
import { TerminalManager } from './utils/terminalManager';
import { HelmManager } from './utils/helmManager';
import { AlertManager } from './utils/alertManager';
import { HealthMonitor } from './utils/healthMonitor';
import { KubectlTerminal } from './utils/kubectlTerminal';
import { BackupRestoreManager } from './utils/backupRestoreManager';
import { YAMLEditor } from './views/yamlEditor';
import { AuditLogViewer } from './views/auditLogViewer';
import { PolicyEnforcementManager } from './utils/policyEnforcementManager';
import { logger } from './utils/logger';
import * as commands from './commands';
import * as treeCommands from './commands/treeCommands';

let k8sClient: K8sClient;
let kubeconfigManager: KubeconfigManager;

export async function activate(context: vscode.ExtensionContext) {
    // Initialize logger
    logger.updateConfiguration();
    logger.info('Cluster Pilot extension activating...');
    
    // Configure proxy bypass for local Kubernetes connections only
    const proxyConfig = vscode.workspace.getConfiguration('clusterPilot');
    const bypassProxyForLocal = proxyConfig.get<boolean>('bypassProxyForLocalConnections', true);
    
    if (bypassProxyForLocal) {
        // Only bypass proxy for known local hosts (not globally)
        bypassProxyForLocalHosts();
        logger.debug('Configured proxy bypass for local Kubernetes connections');
    }
    
    // Load .env file for environment-specific configuration
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        const envPath = path.join(workspaceRoot, '.env');
        dotenv.config({ path: envPath });
        logger.debug('Loaded .env configuration from:', envPath);
    }

    // Initialize managers
    kubeconfigManager = new KubeconfigManager();
    k8sClient = new K8sClient(kubeconfigManager);
    const portForwardManager = new PortForwardManager(kubeconfigManager.getKubeConfig());
    const terminalManager = new TerminalManager(kubeconfigManager.getKubeConfig());
    const helmManager = new HelmManager();
    const alertManager = new AlertManager(context);
    const healthMonitor = new HealthMonitor(context);
    const kubectlTerminal = new KubectlTerminal(kubeconfigManager.getKubeConfig());
    const backupRestoreManager = new BackupRestoreManager(kubeconfigManager.getKubeConfig());
    const yamlEditor = new YAMLEditor(kubeconfigManager.getKubeConfig());
    const auditLogViewer = new AuditLogViewer(kubeconfigManager.getKubeConfig());
    const policyEnforcementManager = new PolicyEnforcementManager(kubeconfigManager.getKubeConfig());

    // Test connection
    setTimeout(async () => {
        logger.debug('Testing Kubernetes API connection...');
        try {
            const namespaces = await k8sClient.getNamespaces();
            logger.info(`Connection test: Found ${namespaces.length} namespaces`);
            const pods = await k8sClient.getPods();
            logger.debug(`Connection test: Found ${pods.length} pods`);
        } catch (error) {
            logger.error('Connection test failed', error);
            vscode.window.showWarningMessage('Could not connect to Kubernetes cluster. Please check your kubeconfig.');
        }
    }, 2000);

    // Initialize providers
    const clusterProvider = new ClusterProvider(kubeconfigManager, k8sClient, context);
    const workloadsProvider = new ResourceProvider(k8sClient, 'workloads');
    const configProvider = new ResourceProvider(k8sClient, 'config');
    const networkProvider = new ResourceProvider(k8sClient, 'network');
    const storageProvider = new ResourceProvider(k8sClient, 'storage');
    const crdProvider = new CRDProvider(k8sClient);
    const rbacProvider = new RBACProvider(k8sClient);
    const jobProvider = new JobProvider(k8sClient);
    const namespaceProvider = new NamespaceProvider(k8sClient);
    const nodeProvider = new NodeProvider(k8sClient);

    // Check if Helm is installed
    const helmInstalled = await helmManager.checkHelmInstalled();
    let helmProvider: HelmProvider | undefined;
    
    if (helmInstalled) {
        helmProvider = new HelmProvider(helmManager);
        logger.info('Helm is installed - Helm view enabled');
        // Set context for conditional view visibility
        vscode.commands.executeCommand('setContext', 'clusterPilot.helmInstalled', true);
    } else {
        logger.warn('Helm is not installed - Helm view disabled');
        vscode.commands.executeCommand('setContext', 'clusterPilot.helmInstalled', false);
    }

    // Register tree views
    const clustersView = vscode.window.createTreeView('clusterPilot.clusters', {
        treeDataProvider: clusterProvider,
        showCollapseAll: true
    });

    const workloadsView = vscode.window.createTreeView('clusterPilot.workloads', {
        treeDataProvider: workloadsProvider,
        showCollapseAll: true
    });

    const configView = vscode.window.createTreeView('clusterPilot.config', {
        treeDataProvider: configProvider,
        showCollapseAll: true
    });

    const networkView = vscode.window.createTreeView('clusterPilot.network', {
        treeDataProvider: networkProvider,
        showCollapseAll: true
    });

    const storageView = vscode.window.createTreeView('clusterPilot.storage', {
        treeDataProvider: storageProvider,
        showCollapseAll: true
    });

    const crdsView = vscode.window.createTreeView('clusterPilot.crds', {
        treeDataProvider: crdProvider,
        showCollapseAll: true
    });

    // Conditionally register Helm view only if Helm is installed
    let helmView: vscode.TreeView<any> | undefined;
    if (helmProvider) {
        helmView = vscode.window.createTreeView('clusterPilot.helm', {
            treeDataProvider: helmProvider,
            showCollapseAll: true
        });
    }

    const rbacView = vscode.window.createTreeView('clusterPilot.rbac', {
        treeDataProvider: rbacProvider,
        showCollapseAll: true
    });

    const jobsView = vscode.window.createTreeView('clusterPilot.jobs', {
        treeDataProvider: jobProvider,
        showCollapseAll: true
    });

    const namespacesView = vscode.window.createTreeView('clusterPilot.namespaces', {
        treeDataProvider: namespaceProvider,
        showCollapseAll: true
    });

    const nodesView = vscode.window.createTreeView('clusterPilot.nodes', {
        treeDataProvider: nodeProvider,
        showCollapseAll: true
    });

    // Add all views to subscriptions for proper disposal
    context.subscriptions.push(
        clustersView,
        workloadsView,
        configView,
        networkView,
        storageView,
        crdsView,
        rbacView,
        jobsView,
        namespacesView,
        nodesView
    );
    
    // Add Helm view if it was created
    if (helmView) {
        context.subscriptions.push(helmView);
    }

    // Handle clicks on resource items to show details
    context.subscriptions.push(
        clustersView.onDidChangeSelection(e => {
            if (e.selection.length > 0 && e.selection[0].type === 'context') {
                // Show multi-cluster manager when a cluster is selected
                commands.showMultiClusterManager(k8sClient, kubeconfigManager);
            }
        }),
        workloadsView.onDidChangeSelection(e => {
            if (e.selection.length > 0 && e.selection[0].resource) {
                commands.showResourceDetails(context, e.selection[0], k8sClient);
            }
        }),
        configView.onDidChangeSelection(e => {
            if (e.selection.length > 0 && e.selection[0].resource) {
                commands.showResourceDetails(context, e.selection[0], k8sClient);
            }
        }),
        networkView.onDidChangeSelection(e => {
            if (e.selection.length > 0 && e.selection[0].resource) {
                commands.showResourceDetails(context, e.selection[0], k8sClient);
            }
        }),
        storageView.onDidChangeSelection(e => {
            if (e.selection.length > 0 && e.selection[0].resource) {
                commands.showResourceDetails(context, e.selection[0], k8sClient);
            }
        }),
        crdsView.onDidChangeSelection(e => {
            if (e.selection.length > 0 && e.selection[0].resource) {
                commands.showResourceDetails(context, e.selection[0], k8sClient);
            }
        })
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('clusterPilot.addCluster', () => 
            commands.addCluster(kubeconfigManager, clusterProvider)),
        
        vscode.commands.registerCommand('clusterPilot.removeCluster', (item) => 
            commands.removeCluster(kubeconfigManager, clusterProvider, item)),
        
        vscode.commands.registerCommand('clusterPilot.switchContext', () => 
            commands.switchContext(kubeconfigManager, k8sClient, clusterProvider)),
        
        vscode.commands.registerCommand('clusterPilot.refresh', () => 
            commands.refreshAll(clusterProvider, workloadsProvider, configProvider, networkProvider, storageProvider, crdProvider)),
        
        vscode.commands.registerCommand('clusterPilot.viewLogs', (item) => 
            commands.viewLogs(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.viewYaml', (item) => 
            commands.viewYaml(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.editResource', (item) => 
            commands.editResource(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.deleteResource', (item) => 
            commands.deleteResource(k8sClient, item, workloadsProvider, configProvider, networkProvider, storageProvider)),
        
        vscode.commands.registerCommand('clusterPilot.describeResource', (item) => 
            commands.describeResource(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.portForward', (item) => 
            commands.portForward(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.execShell', (item) => 
            commands.execShell(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.scaleDeployment', (item) => 
            commands.scaleDeployment(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.restartDeployment', (item) => 
            commands.restartDeployment(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.showMetrics', () => 
            commands.showMetrics(context, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showResourceDetails', (item) => 
            commands.showResourceDetails(context, item, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.enableClusterMetrics', (item) => {
            commands.enableClusterMetrics(context, item);
            clusterProvider.refresh();
        }),
        
        vscode.commands.registerCommand('clusterPilot.disableClusterMetrics', (item) => {
            commands.disableClusterMetrics(context, item);
            clusterProvider.refresh();
        }),
        
        vscode.commands.registerCommand('clusterPilot.showEvents', (item) => 
            commands.showEvents(context, k8sClient, item?.id)),
        
        vscode.commands.registerCommand('clusterPilot.exportResource', (item) => 
            commands.exportResourceToYaml(item)),
        
        vscode.commands.registerCommand('clusterPilot.rollbackDeployment', (item) => 
            commands.rollbackDeployment(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.filterByNamespace', async () => {
            // Prompt user to select which view to filter
            const viewOptions = [
                { label: 'Workloads', provider: workloadsProvider },
                { label: 'Configuration', provider: configProvider },
                { label: 'Network', provider: networkProvider },
                { label: 'Storage', provider: storageProvider }
            ];

            const selected = await vscode.window.showQuickPick(
                viewOptions.map(v => v.label),
                { placeHolder: 'Select resource view to filter' }
            );

            if (selected) {
                const option = viewOptions.find(v => v.label === selected);
                if (option) {
                    await commands.setResourceNamespaceFilter(option.provider);
                }
            }
        }),
        
        vscode.commands.registerCommand('clusterPilot.startPortForward', (item) => 
            commands.startPortForward(portForwardManager, item)),
        
        vscode.commands.registerCommand('clusterPilot.stopPortForward', (id) => 
            commands.stopPortForward(portForwardManager, id)),
        
        vscode.commands.registerCommand('clusterPilot.listPortForwards', () => 
            commands.listPortForwards(portForwardManager)),
        
        vscode.commands.registerCommand('clusterPilot.execInPod', (item) => 
            commands.execInPod(terminalManager, item)),
        
        // Advanced tree view commands
        vscode.commands.registerCommand('clusterPilot.filterTreeView', async (viewName?: string) => {
            // Determine which provider to filter
            const providers = {
                'workloads': workloadsProvider,
                'config': configProvider,
                'network': networkProvider,
                'storage': storageProvider,
                'namespaces': namespaceProvider,
                'nodes': nodeProvider
            };
            
            if (viewName && viewName in providers) {
                await treeCommands.filterTreeView(providers[viewName as keyof typeof providers]);
            } else {
                // Show quick pick to select view
                const selected = await vscode.window.showQuickPick(Object.keys(providers), {
                    placeHolder: 'Select view to filter'
                });
                if (selected) {
                    await treeCommands.filterTreeView(providers[selected as keyof typeof providers]);
                }
            }
        }),
        
        vscode.commands.registerCommand('clusterPilot.clearTreeFilter', (viewName?: string) => {
            const providers = {
                'workloads': workloadsProvider,
                'config': configProvider,
                'network': networkProvider,
                'storage': storageProvider,
                'namespaces': namespaceProvider,
                'nodes': nodeProvider
            };
            
            if (viewName && viewName in providers) {
                treeCommands.clearTreeFilter(providers[viewName as keyof typeof providers]);
            }
        }),
        
        vscode.commands.registerCommand('clusterPilot.loadMore', (parentKey: string) => {
            // This will be called by load more buttons in the tree
            // The provider will handle this based on context
            logger.debug(`Load more requested for: ${parentKey}`);
        }),
        
        vscode.commands.registerCommand('clusterPilot.toggleProgressiveLoading', async (viewName?: string) => {
            const providers = {
                'workloads': workloadsProvider,
                'config': configProvider,
                'network': networkProvider,
                'storage': storageProvider
            };
            
            if (viewName && viewName in providers) {
                await treeCommands.toggleProgressiveLoading(providers[viewName as keyof typeof providers]);
            }
        }),
        
        vscode.commands.registerCommand('clusterPilot.enableWatch', (viewName?: string) => {
            if (viewName === 'namespaces') {
                treeCommands.enableWatch(namespaceProvider);
            } else if (viewName === 'nodes') {
                treeCommands.enableWatch(nodeProvider);
            }
        }),
        
        vscode.commands.registerCommand('clusterPilot.disableWatch', (viewName?: string) => {
            if (viewName === 'namespaces') {
                treeCommands.disableWatch(namespaceProvider);
            } else if (viewName === 'nodes') {
                treeCommands.disableWatch(nodeProvider);
            }
        }),
        
        vscode.commands.registerCommand('clusterPilot.viewRBACDetails', (item) => 
            commands.viewRBACDetails(context, item)),
        
        vscode.commands.registerCommand('clusterPilot.showAlerts', () => 
            commands.showAlerts(context, alertManager)),
        
        vscode.commands.registerCommand('clusterPilot.showPVManager', () => 
            commands.showPVManager(context, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.configureHealthThresholds', () => 
            commands.configureHealthThresholds(healthMonitor)),
        
        vscode.commands.registerCommand('clusterPilot.showResourceTemplates', () => 
            commands.showResourceTemplates(context)),
        
        vscode.commands.registerCommand('clusterPilot.showJobManager', () => 
            commands.showJobManager(context, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.deleteJob', (item) => 
            commands.deleteJob(k8sClient, jobProvider, item)),
        
        vscode.commands.registerCommand('clusterPilot.triggerCronJob', (item) => 
            commands.triggerCronJob(k8sClient, jobProvider, item)),
        
        vscode.commands.registerCommand('clusterPilot.suspendCronJob', (item) => 
            commands.suspendCronJob(k8sClient, jobProvider, item)),
        
        vscode.commands.registerCommand('clusterPilot.resumeCronJob', (item) => 
            commands.resumeCronJob(k8sClient, jobProvider, item))
    );

    // Register Helm commands only if Helm is installed
    if (helmProvider) {
        context.subscriptions.push(
            vscode.commands.registerCommand('clusterPilot.installHelmChart', () => 
                commands.installHelmChart(helmManager, helmProvider!)),
            
            vscode.commands.registerCommand('clusterPilot.uninstallHelmRelease', (item) => 
                commands.uninstallHelmRelease(helmManager, helmProvider!, item)),
            
            vscode.commands.registerCommand('clusterPilot.upgradeHelmRelease', (item) => 
                commands.upgradeHelmRelease(helmManager, helmProvider!, item)),
            
            vscode.commands.registerCommand('clusterPilot.rollbackHelmRelease', (item) => 
                commands.rollbackHelmRelease(helmManager, helmProvider!, item)),
            
            vscode.commands.registerCommand('clusterPilot.viewHelmReleaseDetails', (item) => 
                commands.viewHelmReleaseDetails(helmManager, item)),
            
            vscode.commands.registerCommand('clusterPilot.addHelmRepo', () => 
                commands.addHelmRepo(helmManager, helmProvider!)),
            
            vscode.commands.registerCommand('clusterPilot.removeHelmRepo', (item) => 
                commands.removeHelmRepo(helmManager, helmProvider!, item)),
            
            vscode.commands.registerCommand('clusterPilot.updateHelmRepos', () => 
                commands.updateHelmRepos(helmManager, helmProvider!))
        );
    }

    // Register additional commands
    context.subscriptions.push(
        vscode.commands.registerCommand('clusterPilot.showAdvancedLogs', (item) => 
            commands.showAdvancedLogs(context, k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.showNamespaceManager', () => 
            commands.showNamespaceManager(context, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.createNamespace', () => 
            commands.createNamespace(k8sClient, namespaceProvider)),
        
        vscode.commands.registerCommand('clusterPilot.deleteNamespace', (item) => 
            commands.deleteNamespace(k8sClient, namespaceProvider, item)),
        
        vscode.commands.registerCommand('clusterPilot.showNodeManager', () => 
            commands.showNodeManager(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.cordonNode', (item) => 
            commands.cordonNode(k8sClient, nodeProvider, item)),
        
        vscode.commands.registerCommand('clusterPilot.uncordonNode', (item) => 
            commands.uncordonNode(k8sClient, nodeProvider, item)),
        
        vscode.commands.registerCommand('clusterPilot.drainNode', (item) => 
            commands.drainNode(k8sClient, nodeProvider, item)),
        
        vscode.commands.registerCommand('clusterPilot.showGlobalSearch', () => 
            commands.showGlobalSearch(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.editConfigMap', (item) => 
            commands.editConfigMap(context.extensionUri, k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.editSecret', (item) => 
            commands.editSecret(context.extensionUri, k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.showNetworkPolicies', () => 
            commands.showNetworkPolicies(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showResourceQuotas', () => 
            commands.showResourceQuotas(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showHPAManager', () => 
            commands.showHPAManager(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showRolloutManager', (item) => 
            commands.showRolloutManager(context.extensionUri, k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.showIngressManager', () => 
            commands.showIngressManager(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showStatefulSetManager', () => 
            commands.showStatefulSetManager(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showServiceManager', () => 
            commands.showServiceManager(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showDaemonSetManager', () => 
            commands.showDaemonSetManager(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showPDBManager', () => 
            commands.showPDBManager(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showResourceUsageDashboard', () => 
            commands.showResourceUsageDashboard(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showCapacityPlanningPanel', () => 
            commands.showCapacityPlanningPanel(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showCostEstimationPanel', () => 
            commands.showCostEstimationPanel(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.compareResources', (item) => 
            commands.compareResources(k8sClient, kubeconfigManager, item)),
        
        vscode.commands.registerCommand('clusterPilot.compareWithRevision', (item) => 
            commands.compareWithRevision(k8sClient, kubeconfigManager, item)),
        
        vscode.commands.registerCommand('clusterPilot.compareAcrossNamespaces', (item) => 
            commands.compareAcrossNamespaces(k8sClient, kubeconfigManager, item)),
        
        vscode.commands.registerCommand('clusterPilot.compareAcrossClusters', (item) => 
            commands.compareAcrossClusters(k8sClient, kubeconfigManager, item)),
        
        vscode.commands.registerCommand('clusterPilot.showMultiClusterManager', () => 
            commands.showMultiClusterManager(k8sClient, kubeconfigManager)),
        
        vscode.commands.registerCommand('clusterPilot.showCRDManager', () => 
            commands.showCRDManager(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showEventStreamViewer', () => 
            commands.showEventStreamViewer(context.extensionUri, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showHelmManagerPanel', () => 
            commands.showHelmManagerPanel(context.extensionUri, helmManager)),
        
        vscode.commands.registerCommand('clusterPilot.showPortForwardPanel', () => 
            commands.showPortForwardPanel(context.extensionUri, portForwardManager, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.showSecurityScanningPanel', () => 
            commands.showSecurityScanningPanel(context.extensionUri, k8sClient)),
        
        // kubectl Terminal Commands
        vscode.commands.registerCommand('clusterPilot.openKubectlTerminal', () => 
            kubectlTerminal.openKubectlTerminal()),
        
        vscode.commands.registerCommand('clusterPilot.openNamespaceTerminal', async (item) => {
            let namespace = item?.namespace || item?.resource?.metadata?.namespace;
            if (!namespace) {
                namespace = await vscode.window.showInputBox({
                    prompt: 'Enter namespace',
                    value: 'default',
                    placeHolder: 'default'
                });
            }
            if (namespace) {
                await kubectlTerminal.openNamespaceTerminal(namespace);
            }
        }),
        
        vscode.commands.registerCommand('clusterPilot.showKubectlQuickCommands', () => 
            kubectlTerminal.showQuickCommands()),
        
        // YAML Editor Commands
        vscode.commands.registerCommand('clusterPilot.createResourceFromTemplate', () => 
            yamlEditor.createResource()),
        
        vscode.commands.registerCommand('clusterPilot.applyYamlToCluster', () => 
            yamlEditor.applyActiveDocument()),
        
        vscode.commands.registerCommand('clusterPilot.dryRunYaml', () => 
            yamlEditor.dryRunActiveDocument()),
        
        vscode.commands.registerCommand('clusterPilot.editResourceWithValidation', (item) => {
            const kind = item?.resource?.kind || item?.kind;
            const name = item?.resource?.metadata?.name || item?.name;
            const namespace = item?.resource?.metadata?.namespace || item?.namespace;
            if (kind && name) {
                yamlEditor.editResource(kind, name, namespace);
            } else {
                vscode.window.showErrorMessage('Unable to determine resource details');
            }
        }),
        
        // Backup & Restore Commands
        vscode.commands.registerCommand('clusterPilot.showBackupPanel', () => 
            backupRestoreManager.showBackupPanel()),
        
        vscode.commands.registerCommand('clusterPilot.createBackup', () => 
            backupRestoreManager.createBackupWizard()),
        
        vscode.commands.registerCommand('clusterPilot.restoreBackup', async () => {
            vscode.window.showInformationMessage('Use the Backup & Restore Manager to restore backups');
            await backupRestoreManager.showBackupPanel();
        }),
        
        // Audit Log Viewer Commands (Tier 2)
        vscode.commands.registerCommand('clusterPilot.showAuditLogViewer', () => 
            auditLogViewer.showAuditLogViewer()),
        
        // Policy Enforcement Commands (Tier 2)
        vscode.commands.registerCommand('clusterPilot.showPolicyEnforcement', () => 
            policyEnforcementManager.showPolicyPanel())
    );

    // Register views
    context.subscriptions.push(
        clustersView,
        workloadsView,
        configView,
        networkView,
        storageView,
        crdsView,
        rbacView,
        jobsView,
        namespacesView,
        nodesView,
        portForwardManager,
        terminalManager,
        alertManager,
        yamlEditor
    );

    // Setup auto-refresh if enabled
    const config = vscode.workspace.getConfiguration('clusterPilot');
    const refreshInterval = config.get<number>('refreshInterval', 5000);
    
    if (refreshInterval > 0) {
        const refreshTimer = setInterval(() => {
            commands.refreshAll(clusterProvider, workloadsProvider, configProvider, networkProvider, storageProvider, crdProvider);
        }, refreshInterval);

        context.subscriptions.push({
            dispose: () => clearInterval(refreshTimer)
        });
    }

    // Show multi-cluster manager by default on startup
    setTimeout(() => {
        commands.showMultiClusterManager(k8sClient, kubeconfigManager);
    }, 1000);

    // Register logger for cleanup
    context.subscriptions.push({
        dispose: () => logger.dispose()
    });
    
    vscode.window.showInformationMessage('Cluster Pilot is ready!');
    logger.info('Cluster Pilot extension activated successfully');
}

export function deactivate() {
    logger.info('Cluster Pilot extension is now deactivated');
    logger.dispose();
}
