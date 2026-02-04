import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as cp from 'child_process';
import { promisify } from 'util';
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

const execAsync = promisify(cp.exec);

// Activation guard to prevent duplicate activation
let isActivated = false;
let lastActivationTime = 0;

// Track availability of external tools
let externalTools = {
    kubectl: false,
    helm: false,
    trivy: false
};

/**
 * Check if an external command is available
 */
async function checkCommandAvailable(command: string): Promise<boolean> {
    try {
        const versionCmd = command === 'trivy' ? `${command} --version` : `${command} version --short`;
        await execAsync(versionCmd, { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

let k8sClient: K8sClient;
let kubeconfigManager: KubeconfigManager;

// Helper function to safely register commands with automatic null checking
function safeRegisterCommand(
    commandId: string,
    callback: (...args: any[]) => any,
    requiredDependencies: { [key: string]: any }
): vscode.Disposable {
    return vscode.commands.registerCommand(commandId, (...args: any[]) => {
        // Check if all required dependencies are initialized
        const missingDeps = Object.entries(requiredDependencies)
            .filter(([_, value]) => !value)
            .map(([key, _]) => key);
        
        if (missingDeps.length > 0) {
            const msg = `Command '${commandId}' unavailable: ${missingDeps.join(', ')} not initialized. The extension may have failed to start properly.`;
            vscode.window.showErrorMessage(msg);
            logger.error(msg);
            return;
        }
        
        // All dependencies present, execute callback
        return callback(...args);
    });
}

export async function activate(context: vscode.ExtensionContext) {
    // Guard against duplicate activation
    if (isActivated) {
        logger.warn('Extension already activated, skipping duplicate activation');
        return;
    }
    
    // Guard against rapid re-activation (within 1 second)
    const now = Date.now();
    if (now - lastActivationTime < 1000) {
        logger.warn('Activation attempted too soon after previous activation, ignoring');
        return;
    }
    
    isActivated = true;
    lastActivationTime = now;
    
    // Initialize logger first - this should always work
    logger.updateConfiguration();
    logger.info('Cluster Pilot extension activating...');
    
    // Check for external tool availability (non-blocking)
    try {
        externalTools.kubectl = await checkCommandAvailable('kubectl');
        externalTools.helm = await checkCommandAvailable('helm');
        externalTools.trivy = await checkCommandAvailable('trivy');
        
        logger.info('External tools availability:', externalTools);
        
        // Show info message if critical tools are missing (only if warnings are enabled)
        const config = vscode.workspace.getConfiguration('clusterPilot');
        const showWarnings = config.get<boolean>('showToolAvailabilityWarnings', true);
        
        if (showWarnings) {
            const missingTools: string[] = [];
            if (!externalTools.kubectl) { missingTools.push('kubectl'); }
            if (!externalTools.helm) { missingTools.push('helm'); }
            
            if (missingTools.length > 0) {
                const message = `Some features require ${missingTools.join(' and ')} to be installed. Core cluster viewing will work, but some advanced features may be limited.`;
                logger.warn(message);
                vscode.window.showInformationMessage(message, 'Learn More', 'Don\'t Show Again').then(selection => {
                    if (selection === 'Learn More') {
                        vscode.env.openExternal(vscode.Uri.parse('https://github.com/jasonheath776/cluster-pilot#requirements'));
                    } else if (selection === 'Don\'t Show Again') {
                        config.update('showToolAvailabilityWarnings', false, vscode.ConfigurationTarget.Global);
                    }
                });
            }
        }
    } catch (error) {
        logger.warn('Failed to check external tool availability:', error);
    }
    
    // Declare local variables - make them optional to handle initialization failures gracefully
    let portForwardManager: PortForwardManager | undefined;
    let terminalManager: TerminalManager | undefined;
    let helmManager: HelmManager | undefined;
    let alertManager: AlertManager | undefined;
    let healthMonitor: HealthMonitor | undefined;
    let kubectlTerminal: KubectlTerminal | undefined;
    let backupRestoreManager: BackupRestoreManager | undefined;
    let yamlEditor: YAMLEditor | undefined;
    let auditLogViewer: AuditLogViewer | undefined;
    let policyEnforcementManager: PolicyEnforcementManager | undefined;
    let clusterProvider: ClusterProvider | undefined;
    let workloadsProvider: ResourceProvider | undefined;
    let configProvider: ResourceProvider | undefined;
    let networkProvider: ResourceProvider | undefined;
    let storageProvider: ResourceProvider | undefined;
    let crdProvider: CRDProvider | undefined;
    let rbacProvider: RBACProvider | undefined;
    let jobProvider: JobProvider | undefined;
    let namespaceProvider: NamespaceProvider | undefined;
    let nodeProvider: NodeProvider | undefined;
    let helmProvider: HelmProvider | undefined;
    
    try {
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
        portForwardManager = new PortForwardManager(kubeconfigManager.getKubeConfig());
        terminalManager = new TerminalManager(kubeconfigManager.getKubeConfig());
        helmManager = new HelmManager();
        alertManager = new AlertManager(context);
        healthMonitor = new HealthMonitor(context);
        kubectlTerminal = new KubectlTerminal(kubeconfigManager.getKubeConfig());
        backupRestoreManager = new BackupRestoreManager(kubeconfigManager.getKubeConfig());
        yamlEditor = new YAMLEditor(kubeconfigManager.getKubeConfig());
        auditLogViewer = new AuditLogViewer(kubeconfigManager.getKubeConfig());
        policyEnforcementManager = new PolicyEnforcementManager(kubeconfigManager.getKubeConfig());

        // Test connection (async, non-blocking)
        setTimeout(async () => {
            if (!k8sClient) {
                logger.warn('k8sClient not available for connection test');
                return;
            }
            
            logger.debug('Testing Kubernetes API connection...');
            try {
                const namespaces = await k8sClient.getNamespaces();
                logger.info(`Connection test: Found ${namespaces.length} namespaces`);
                const pods = await k8sClient.getPods();
                logger.debug(`Connection test: Found ${pods.length} pods`);
            } catch (error) {
                logger.error('Connection test failed', error);
                const errorMsg = error instanceof Error ? error.message : String(error);
                vscode.window.showWarningMessage(`Could not connect to Kubernetes cluster: ${errorMsg}. Check your kubeconfig and cluster status.`);
            }
        }, 2000);

        // Initialize providers
        clusterProvider = new ClusterProvider(kubeconfigManager, k8sClient, context);
        workloadsProvider = new ResourceProvider(k8sClient, 'workloads');
        configProvider = new ResourceProvider(k8sClient, 'config');
        networkProvider = new ResourceProvider(k8sClient, 'network');
        storageProvider = new ResourceProvider(k8sClient, 'storage');
        crdProvider = new CRDProvider(k8sClient);
        rbacProvider = new RBACProvider(k8sClient);
        jobProvider = new JobProvider(k8sClient);
        namespaceProvider = new NamespaceProvider(k8sClient);
        nodeProvider = new NodeProvider(k8sClient);

        // Check if Helm is installed - don't await, do it async to not block activation
        let helmInstalled = false;
        helmManager.checkHelmInstalled()
            .then(installed => {
                helmInstalled = installed;
                if (helmInstalled && helmManager) {
                    helmProvider = new HelmProvider(helmManager);
                    logger.info('Helm is installed - Helm view enabled');
                    vscode.commands.executeCommand('setContext', 'clusterPilot.helmInstalled', true);
                } else {
                    logger.warn('Helm is not installed - Helm view disabled');
                    vscode.commands.executeCommand('setContext', 'clusterPilot.helmInstalled', false);
                }
            })
            .catch(error => {
                logger.warn('Failed to check Helm installation', error);
                vscode.commands.executeCommand('setContext', 'clusterPilot.helmInstalled', false);
            });
    } catch (error) {
        logger.error('Critical error during extension initialization', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Cluster Pilot failed to initialize: ${errorMsg}. Commands will be available but may not work until the issue is resolved.`);
        logger.error('Stack trace:', error instanceof Error ? error.stack : 'No stack trace');
        // Continue to register commands and views even if initialization failed
        // Commands will show appropriate error messages when executed
    }

    // Log initialization status but continue regardless
    const initSuccess = !!(kubeconfigManager && k8sClient && clusterProvider);
    if (!initSuccess) {
        logger.warn('Core components failed to initialize - extension running in limited mode');
        logger.warn(`Status: kubeconfigManager=${!!kubeconfigManager}, k8sClient=${!!k8sClient}, clusterProvider=${!!clusterProvider}`);
        vscode.window.showWarningMessage('Cluster Pilot: Some components failed to initialize. Commands may not work. Check the Output panel for details.');
        // DO NOT RETURN - continue to register views and commands
    } else {
        logger.info('Core components initialized successfully');
    }

    // Register tree views (will fail gracefully if providers are undefined)
    let clustersView, workloadsView, configView, networkView, storageView, crdsView, rbacView, jobsView, namespacesView, nodesView;
    let helmView: vscode.TreeView<any> | undefined;
    
    if (clusterProvider && workloadsProvider && configProvider && networkProvider && 
        storageProvider && crdProvider && rbacProvider && jobProvider && 
        namespaceProvider && nodeProvider) {
        
        clustersView = vscode.window.createTreeView('clusterPilot.clusters', {
            treeDataProvider: clusterProvider,
            showCollapseAll: true
        });

        workloadsView = vscode.window.createTreeView('clusterPilot.workloads', {
            treeDataProvider: workloadsProvider,
            showCollapseAll: true
        });

        configView = vscode.window.createTreeView('clusterPilot.config', {
            treeDataProvider: configProvider,
            showCollapseAll: true
        });

        networkView = vscode.window.createTreeView('clusterPilot.network', {
            treeDataProvider: networkProvider,
            showCollapseAll: true
        });

        storageView = vscode.window.createTreeView('clusterPilot.storage', {
            treeDataProvider: storageProvider,
            showCollapseAll: true
        });

        crdsView = vscode.window.createTreeView('clusterPilot.crds', {
            treeDataProvider: crdProvider,
            showCollapseAll: true
        });

        // Conditionally register Helm view only if Helm is installed
        if (helmProvider) {
            helmView = vscode.window.createTreeView('clusterPilot.helm', {
                treeDataProvider: helmProvider,
                showCollapseAll: true
            });
        }

        rbacView = vscode.window.createTreeView('clusterPilot.rbac', {
            treeDataProvider: rbacProvider,
            showCollapseAll: true
        });

        jobsView = vscode.window.createTreeView('clusterPilot.jobs', {
            treeDataProvider: jobProvider,
            showCollapseAll: true
        });

        namespacesView = vscode.window.createTreeView('clusterPilot.namespaces', {
            treeDataProvider: namespaceProvider,
            showCollapseAll: true
        });

        nodesView = vscode.window.createTreeView('clusterPilot.nodes', {
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
    } // End of providers check

    // ALWAYS Register commands - even if initialization failed
    // Commands will check for null/undefined and show appropriate error messages
    
    // For commands that require initialized components, add explicit checks
    const checkInit = (componentName: string, component: any) => {
        if (!component) {
            vscode.window.showErrorMessage(`Cluster Pilot: ${componentName} not initialized. Extension may have failed to start.`);
            return false;
        }
        return true;
    };
    
    context.subscriptions.push(
        vscode.commands.registerCommand('clusterPilot.addCluster', () => {
            if (!kubeconfigManager || !clusterProvider) {
                vscode.window.showErrorMessage('Cluster Pilot not properly initialized');
                return;
            }
            commands.addCluster(kubeconfigManager, clusterProvider);
        }),
        
        vscode.commands.registerCommand('clusterPilot.removeCluster', (item) => {
            if (!kubeconfigManager || !clusterProvider) {
                vscode.window.showErrorMessage('Cluster Pilot not properly initialized');
                return;
            }
            commands.removeCluster(kubeconfigManager, clusterProvider, item);
        }),
        
        vscode.commands.registerCommand('clusterPilot.switchContext', () => {
            if (!kubeconfigManager || !k8sClient || !clusterProvider) {
                vscode.window.showErrorMessage('Cluster Pilot not properly initialized');
                return;
            }
            commands.switchContext(kubeconfigManager, k8sClient, clusterProvider);
        }),
        
        vscode.commands.registerCommand('clusterPilot.refresh', () => {
            if (!clusterProvider || !workloadsProvider || !configProvider || !networkProvider || !storageProvider || !crdProvider) {
                vscode.window.showErrorMessage('Cluster Pilot not properly initialized');
                return;
            }
            commands.refreshAll(clusterProvider, workloadsProvider, configProvider, networkProvider, storageProvider, crdProvider);
        }),
        
        vscode.commands.registerCommand('clusterPilot.viewLogs', (item) => 
            commands.viewLogs(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.viewYaml', (item) => 
            commands.viewYaml(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.editResource', (item) => 
            commands.editResource(k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.deleteResource', (item) => {
            if (!workloadsProvider || !configProvider || !networkProvider || !storageProvider) {
                vscode.window.showErrorMessage('Cluster Pilot: Providers not initialized');
                return;
            }
            return commands.deleteResource(k8sClient, item, workloadsProvider, configProvider, networkProvider, storageProvider);
        }),
        
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
            if (!clusterProvider) return;
            commands.enableClusterMetrics(context, item);
            clusterProvider.refresh();
        }),
        
        vscode.commands.registerCommand('clusterPilot.disableClusterMetrics', (item) => {
            if (!clusterProvider) return;
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
            if (!workloadsProvider || !configProvider || !networkProvider || !storageProvider) {
                vscode.window.showErrorMessage('Cluster Pilot: Providers not initialized');
                return;
            }
            
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
        
        vscode.commands.registerCommand('clusterPilot.startPortForward', (item) => {
            if (!portForwardManager) { vscode.window.showErrorMessage('Port forward manager not initialized'); return; }
            return commands.startPortForward(portForwardManager, item);
        }),
        
        vscode.commands.registerCommand('clusterPilot.stopPortForward', (id) => {
            if (!portForwardManager) { vscode.window.showErrorMessage('Port forward manager not initialized'); return; }
            return commands.stopPortForward(portForwardManager, id);
        }),
        
        vscode.commands.registerCommand('clusterPilot.listPortForwards', () => {
            if (!portForwardManager) { vscode.window.showErrorMessage('Port forward manager not initialized'); return; }
            return commands.listPortForwards(portForwardManager);
        }),
        
        vscode.commands.registerCommand('clusterPilot.execInPod', (item) => {
            if (!terminalManager) { vscode.window.showErrorMessage('Terminal manager not initialized'); return; }
            return commands.execInPod(terminalManager, item);
        }),
        
        // Advanced tree view commands
        vscode.commands.registerCommand('clusterPilot.filterTreeView', async (viewName?: string) => {
            if (!workloadsProvider || !configProvider || !networkProvider || !storageProvider || !namespaceProvider || !nodeProvider) {
                vscode.window.showErrorMessage('Providers not initialized');
                return;
            }
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
                const provider = providers[viewName as keyof typeof providers];
                if (provider) {
                    treeCommands.clearTreeFilter(provider);
                }
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
                const provider = providers[viewName as keyof typeof providers];
                if (provider) {
                    await treeCommands.toggleProgressiveLoading(provider);
                }
            }
        }),
        
        vscode.commands.registerCommand('clusterPilot.enableWatch', (viewName?: string) => {
            if (viewName === 'namespaces' && namespaceProvider) {
                treeCommands.enableWatch(namespaceProvider);
            } else if (viewName === 'nodes' && nodeProvider) {
                treeCommands.enableWatch(nodeProvider);
            }
        }),
        
        vscode.commands.registerCommand('clusterPilot.disableWatch', (viewName: string) => {
            if (viewName === 'namespaces' && namespaceProvider) {
                treeCommands.disableWatch(namespaceProvider);
            } else if (viewName === 'nodes' && nodeProvider) {
                treeCommands.disableWatch(nodeProvider);
            }
        }),
        
        vscode.commands.registerCommand('clusterPilot.viewRBACDetails', (item) => 
            commands.viewRBACDetails(context, item)),
        
        vscode.commands.registerCommand('clusterPilot.showAlerts', () => {
            if (!alertManager) { vscode.window.showErrorMessage('Alert manager not initialized'); return; }
            return commands.showAlerts(context, alertManager);
        }),
        
        vscode.commands.registerCommand('clusterPilot.showPVManager', () => 
            commands.showPVManager(context, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.configureHealthThresholds', () => {
            if (!healthMonitor) { vscode.window.showErrorMessage('Health monitor not initialized'); return; }
            return commands.configureHealthThresholds(healthMonitor);
        }),
        
        vscode.commands.registerCommand('clusterPilot.showResourceTemplates', () => 
            commands.showResourceTemplates(context)),
        
        vscode.commands.registerCommand('clusterPilot.showJobManager', () => 
            commands.showJobManager(context, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.deleteJob', (item) => {
            if (!jobProvider) { vscode.window.showErrorMessage('Job provider not initialized'); return; }
            return commands.deleteJob(k8sClient, jobProvider, item);
        }),
        
        vscode.commands.registerCommand('clusterPilot.triggerCronJob', (item) => {
            if (!jobProvider) { vscode.window.showErrorMessage('Job provider not initialized'); return; }
            return commands.triggerCronJob(k8sClient, jobProvider, item);
        }),
        
        vscode.commands.registerCommand('clusterPilot.suspendCronJob', (item) => {
            if (!jobProvider) { vscode.window.showErrorMessage('Job provider not initialized'); return; }
            return commands.suspendCronJob(k8sClient, jobProvider, item);
        }),
        
        vscode.commands.registerCommand('clusterPilot.resumeCronJob', (item) => {
            if (!jobProvider) { vscode.window.showErrorMessage('Job provider not initialized'); return; }
            return commands.resumeCronJob(k8sClient, jobProvider, item);
        })
    );

    // Register Helm commands only if Helm is installed and manager is initialized
    if (helmProvider && helmManager) {
        // TypeScript needs reassignment to narrow types within this block
        const helm = helmManager;
        const helmProv = helmProvider;
        context.subscriptions.push(
            vscode.commands.registerCommand('clusterPilot.installHelmChart', () => 
                commands.installHelmChart(helm, helmProv)),
            
            vscode.commands.registerCommand('clusterPilot.uninstallHelmRelease', (item) => 
                commands.uninstallHelmRelease(helm, helmProv, item)),
            
            vscode.commands.registerCommand('clusterPilot.upgradeHelmRelease', (item) => 
                commands.upgradeHelmRelease(helm, helmProv, item)),
            
            vscode.commands.registerCommand('clusterPilot.rollbackHelmRelease', (item) => 
                commands.rollbackHelmRelease(helm, helmProv, item)),
            
            vscode.commands.registerCommand('clusterPilot.viewHelmReleaseDetails', (item) => 
                commands.viewHelmReleaseDetails(helm, item)),
            
            vscode.commands.registerCommand('clusterPilot.addHelmRepo', () => 
                commands.addHelmRepo(helm, helmProv)),
            
            vscode.commands.registerCommand('clusterPilot.removeHelmRepo', (item) => 
                commands.removeHelmRepo(helm, helmProv, item)),
            
            vscode.commands.registerCommand('clusterPilot.updateHelmRepos', () => 
                commands.updateHelmRepos(helm, helmProv))
        );
    }

    // Register additional commands
    context.subscriptions.push(
        vscode.commands.registerCommand('clusterPilot.showAdvancedLogs', (item) => 
            commands.showAdvancedLogs(context, k8sClient, item)),
        
        vscode.commands.registerCommand('clusterPilot.showNamespaceManager', () => 
            commands.showNamespaceManager(context, k8sClient)),
        
        vscode.commands.registerCommand('clusterPilot.createNamespace', () => {
            if (!namespaceProvider) { vscode.window.showErrorMessage('Namespace provider not initialized'); return; }
            return commands.createNamespace(k8sClient, namespaceProvider);
        }),
        
        vscode.commands.registerCommand('clusterPilot.deleteNamespace', (item) => {
            if (!namespaceProvider) { vscode.window.showErrorMessage('Namespace provider not initialized'); return; }
            return commands.deleteNamespace(k8sClient, namespaceProvider, item);
        }),
        
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
        
        vscode.commands.registerCommand('clusterPilot.showHelmManagerPanel', () => {
            if (!helmManager) { vscode.window.showErrorMessage('Helm manager not initialized'); return; }
            return commands.showHelmManagerPanel(context.extensionUri, helmManager);
        }),
        
        vscode.commands.registerCommand('clusterPilot.showPortForwardPanel', () => {
            if (!portForwardManager) { vscode.window.showErrorMessage('Port forward manager not initialized'); return; }
            return commands.showPortForwardPanel(context.extensionUri, portForwardManager, k8sClient);
        }),
        
        vscode.commands.registerCommand('clusterPilot.showSecurityScanningPanel', () => 
            commands.showSecurityScanningPanel(context.extensionUri, k8sClient)),
        
        // kubectl Terminal Commands
        vscode.commands.registerCommand('clusterPilot.openKubectlTerminal', () => {
            if (!kubectlTerminal) { vscode.window.showErrorMessage('kubectl terminal not initialized'); return; }
            return kubectlTerminal.openKubectlTerminal();
        }),
        
        vscode.commands.registerCommand('clusterPilot.openNamespaceTerminal', async (item) => {
            if (!kubectlTerminal) { vscode.window.showErrorMessage('kubectl terminal not initialized'); return; }
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
        
        vscode.commands.registerCommand('clusterPilot.showKubectlQuickCommands', () => {
            if (!kubectlTerminal) { vscode.window.showErrorMessage('kubectl terminal not initialized'); return; }
            return kubectlTerminal.showQuickCommands();
        }),
        
        // YAML Editor Commands
        vscode.commands.registerCommand('clusterPilot.createResourceFromTemplate', () => {
            if (!yamlEditor) { vscode.window.showErrorMessage('YAML editor not initialized'); return; }
            return yamlEditor.createResource();
        }),
        
        vscode.commands.registerCommand('clusterPilot.applyYamlToCluster', () => {
            if (!yamlEditor) { vscode.window.showErrorMessage('YAML editor not initialized'); return; }
            return yamlEditor.applyActiveDocument();
        }),
        
        vscode.commands.registerCommand('clusterPilot.dryRunYaml', () => {
            if (!yamlEditor) { vscode.window.showErrorMessage('YAML editor not initialized'); return; }
            return yamlEditor.dryRunActiveDocument();
        }),
        
        vscode.commands.registerCommand('clusterPilot.editResourceWithValidation', (item) => {
            if (!yamlEditor) { vscode.window.showErrorMessage('YAML editor not initialized'); return; }
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
        vscode.commands.registerCommand('clusterPilot.showBackupPanel', () => {
            if (!backupRestoreManager) { vscode.window.showErrorMessage('Backup manager not initialized'); return; }
            return backupRestoreManager.showBackupPanel();
        }),
        
        vscode.commands.registerCommand('clusterPilot.createBackup', () => {
            if (!backupRestoreManager) { vscode.window.showErrorMessage('Backup manager not initialized'); return; }
            return backupRestoreManager.createBackupWizard();
        }),
        
        vscode.commands.registerCommand('clusterPilot.restoreBackup', async () => {
            if (!backupRestoreManager) { vscode.window.showErrorMessage('Backup manager not initialized'); return; }
            vscode.window.showInformationMessage('Use the Backup & Restore Manager to restore backups');
            await backupRestoreManager.showBackupPanel();
        }),
        
        // Audit Log Viewer Commands (Tier 2)
        vscode.commands.registerCommand('clusterPilot.showAuditLogViewer', () => {
            if (!auditLogViewer) { vscode.window.showErrorMessage('Audit log viewer not initialized'); return; }
            return auditLogViewer.showAuditLogViewer();
        }),
        
        // Policy Enforcement Commands (Tier 2)
        vscode.commands.registerCommand('clusterPilot.showPolicyEnforcement', () => {
            if (!policyEnforcementManager) { vscode.window.showErrorMessage('Policy enforcement not initialized'); return; }
            return policyEnforcementManager.showPolicyPanel();
        })
    );

    // Register views (only if they were created)
    if (clustersView) context.subscriptions.push(clustersView);
    if (workloadsView) context.subscriptions.push(workloadsView);
    if (configView) context.subscriptions.push(configView);
    if (networkView) context.subscriptions.push(networkView);
    if (storageView) context.subscriptions.push(storageView);
    if (crdsView) context.subscriptions.push(crdsView);
    if (rbacView) context.subscriptions.push(rbacView);
    if (jobsView) context.subscriptions.push(jobsView);
    if (namespacesView) context.subscriptions.push(namespacesView);
    if (nodesView) context.subscriptions.push(nodesView);
    if (helmView) context.subscriptions.push(helmView);
    
    // Register managers (only if they were created)
    if (portForwardManager) context.subscriptions.push(portForwardManager);
    if (terminalManager) context.subscriptions.push(terminalManager);
    if (alertManager) context.subscriptions.push(alertManager);
    if (yamlEditor) context.subscriptions.push(yamlEditor);

    // Setup auto-refresh if enabled (only if providers initialized)
    if (clusterProvider && workloadsProvider && configProvider && networkProvider && storageProvider && crdProvider) {
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
    }

    // Show multi-cluster manager by default on startup (only if initialized)
    if (k8sClient && kubeconfigManager) {
        setTimeout(() => {
            commands.showMultiClusterManager(k8sClient, kubeconfigManager);
        }, 1000);
    }

    // Register logger for cleanup
    context.subscriptions.push({
        dispose: () => logger.dispose()
    });
    
    // Final activation status
    if (initSuccess) {
        vscode.window.showInformationMessage('Cluster Pilot is ready!');
        logger.info('Cluster Pilot extension activated successfully');
    } else {
        logger.warn('Cluster Pilot extension activated with errors - limited functionality available');
        logger.warn('Check the Cluster Pilot output channel for details');
    }
}

export function deactivate() {
    logger.info('Cluster Pilot extension is now deactivating...');
    
    try {
        // Managers are local variables, no need to clean up global state
        // VS Code's context.subscriptions will handle proper disposal
        
        logger.info('Cluster Pilot extension deactivated successfully');
    } catch (error) {
        logger.error('Error during deactivation:', error);
    } finally {
        // Always reset activation flag and dispose logger
        isActivated = false;
        logger.dispose();
    }
}
