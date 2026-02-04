import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';

const execAsync = promisify(cp.exec);

export class KubectlTerminal {
    private terminals: Map<string, vscode.Terminal> = new Map();
    private kc: k8s.KubeConfig;
    private currentContext: string | undefined;

    constructor(kc: k8s.KubeConfig) {
        this.kc = kc;
        this.currentContext = kc.getCurrentContext();
    }

    /**
     * Check if kubectl is installed and available
     */
    private async checkKubectlAvailable(): Promise<boolean> {
        try {
            await execAsync('kubectl version --client --short', { timeout: 5000 });
            return true;
        } catch (error) {
            logger.debug('kubectl not available:', error);
            return false;
        }
    }

    /**
     * Open an integrated kubectl terminal with the current context
     */
    async openKubectlTerminal(): Promise<void> {
        // Check if kubectl is available
        const isAvailable = await this.checkKubectlAvailable();
        if (!isAvailable) {
            const message = 'kubectl is not installed or not in PATH. Please install kubectl to use terminal features.';
            const action = await vscode.window.showWarningMessage(message, 'Learn More');
            if (action === 'Learn More') {
                vscode.env.openExternal(vscode.Uri.parse('https://kubernetes.io/docs/tasks/tools/'));
            }
            return;
        }
        
        const context = this.kc.getCurrentContext();
        if (!context) {
            vscode.window.showErrorMessage('No Kubernetes context selected');
            return;
        }

        const terminalId = `kubectl-${context}`;
        let terminal = this.terminals.get(terminalId);

        if (terminal) {
            terminal.show();
            return;
        }

        // Get kubeconfig path
        const kubeconfigPath = this.getKubeconfigPath();
        
        // Create terminal with kubectl environment
        const env: { [key: string]: string } = {
            ...process.env,
            KUBECONFIG: kubeconfigPath,
            KUBECTL_CONTEXT: context
        };

        terminal = vscode.window.createTerminal({
            name: `kubectl (${context})`,
            env: env,
            iconPath: new vscode.ThemeIcon('terminal-bash'),
            message: `📦 kubectl terminal for context: ${context}\n` +
                     `💡 Tip: Use 'kubectl' commands directly. Context is already set.\n`
        });

        this.terminals.set(terminalId, terminal);

        // Clean up on terminal close
        vscode.window.onDidCloseTerminal(t => {
            if (t === terminal) {
                this.terminals.delete(terminalId);
            }
        });

        // Send initial commands to set context and show status
        terminal.show();
        terminal.sendText(`kubectl config use-context ${context}`);
        terminal.sendText(`kubectl cluster-info`);
        terminal.sendText(`echo ""`);
        terminal.sendText(`echo "✅ Ready! Current context: ${context}"`);
    }

    /**
     * Open terminal for a specific namespace
     */
    async openNamespaceTerminal(namespace: string): Promise<void> {
        // Check if kubectl is available
        const isAvailable = await this.checkKubectlAvailable();
        if (!isAvailable) {
            vscode.window.showWarningMessage('kubectl is not installed or not in PATH. Please install kubectl to use terminal features.');
            return;
        }
        
        const context = this.kc.getCurrentContext();
        if (!context) {
            vscode.window.showErrorMessage('No Kubernetes context selected');
            return;
        }

        const terminalId = `kubectl-${context}-${namespace}`;
        let terminal = this.terminals.get(terminalId);

        if (terminal) {
            terminal.show();
            return;
        }

        const kubeconfigPath = this.getKubeconfigPath();
        
        const env: { [key: string]: string } = {
            ...process.env,
            KUBECONFIG: kubeconfigPath,
            KUBECTL_CONTEXT: context,
            KUBECTL_NAMESPACE: namespace
        };

        terminal = vscode.window.createTerminal({
            name: `kubectl (${namespace})`,
            env: env,
            iconPath: new vscode.ThemeIcon('folder'),
            message: `📦 kubectl terminal for namespace: ${namespace}\n` +
                     `💡 Commands will default to namespace: ${namespace}\n`
        });

        this.terminals.set(terminalId, terminal);

        vscode.window.onDidCloseTerminal(t => {
            if (t === terminal) {
                this.terminals.delete(terminalId);
            }
        });

        terminal.show();
        terminal.sendText(`kubectl config use-context ${context}`);
        terminal.sendText(`kubectl config set-context --current --namespace=${namespace}`);
        terminal.sendText(`kubectl get pods -n ${namespace}`);
        terminal.sendText(`echo ""`);
        terminal.sendText(`echo "✅ Ready! Namespace: ${namespace}"`);
    }

    /**
     * Execute a kubectl command in a new terminal
     */
    async executeCommand(command: string, showTerminal: boolean = true): Promise<void> {
        const context = this.kc.getCurrentContext();
        if (!context) {
            vscode.window.showErrorMessage('No Kubernetes context selected');
            return;
        }

        const kubeconfigPath = this.getKubeconfigPath();
        
        const env: { [key: string]: string } = {
            ...process.env,
            KUBECONFIG: kubeconfigPath
        };

        const terminal = vscode.window.createTerminal({
            name: 'kubectl',
            env: env,
            iconPath: new vscode.ThemeIcon('run')
        });

        if (showTerminal) {
            terminal.show();
        }

        terminal.sendText(`kubectl config use-context ${context}`);
        terminal.sendText(command);
    }

    /**
     * Quick kubectl commands picker
     */
    async showQuickCommands(): Promise<void> {
        const commands = [
            {
                label: '$(list-unordered) Get Pods',
                description: 'List all pods in current namespace',
                command: 'kubectl get pods'
            },
            {
                label: '$(list-unordered) Get All Resources',
                description: 'List all resources in namespace',
                command: 'kubectl get all'
            },
            {
                label: '$(pulse) Get Events',
                description: 'Show recent events',
                command: 'kubectl get events --sort-by=.metadata.creationTimestamp'
            },
            {
                label: '$(graph) Top Nodes',
                description: 'Show node resource usage',
                command: 'kubectl top nodes'
            },
            {
                label: '$(graph) Top Pods',
                description: 'Show pod resource usage',
                command: 'kubectl top pods'
            },
            {
                label: '$(info) Cluster Info',
                description: 'Display cluster information',
                command: 'kubectl cluster-info'
            },
            {
                label: '$(versions) Get Namespaces',
                description: 'List all namespaces',
                command: 'kubectl get namespaces'
            },
            {
                label: '$(server-environment) Get Nodes',
                description: 'List all nodes',
                command: 'kubectl get nodes'
            },
            {
                label: '$(warning) Describe Pod',
                description: 'Describe a specific pod',
                command: 'custom:describe-pod'
            },
            {
                label: '$(output) Logs',
                description: 'View pod logs',
                command: 'custom:logs'
            },
            {
                label: '$(terminal) Open kubectl Terminal',
                description: 'Open interactive kubectl terminal',
                command: 'custom:terminal'
            }
        ];

        const selected = await vscode.window.showQuickPick(commands, {
            placeHolder: 'Select a kubectl command to run',
            matchOnDescription: true
        });

        if (!selected) {
            return;
        }

        // Handle custom commands
        if (selected.command === 'custom:describe-pod') {
            await this.describePod();
        } else if (selected.command === 'custom:logs') {
            await this.showLogs();
        } else if (selected.command === 'custom:terminal') {
            await this.openKubectlTerminal();
        } else {
            await this.executeCommand(selected.command);
        }
    }

    private async describePod(): Promise<void> {
        const namespace = await vscode.window.showInputBox({
            prompt: 'Enter namespace',
            value: 'default',
            placeHolder: 'default'
        });

        if (!namespace) {
            return;
        }

        const podName = await vscode.window.showInputBox({
            prompt: 'Enter pod name',
            placeHolder: 'my-pod-123'
        });

        if (!podName) {
            return;
        }

        await this.executeCommand(`kubectl describe pod ${podName} -n ${namespace}`);
    }

    private async showLogs(): Promise<void> {
        const namespace = await vscode.window.showInputBox({
            prompt: 'Enter namespace',
            value: 'default',
            placeHolder: 'default'
        });

        if (!namespace) {
            return;
        }

        const podName = await vscode.window.showInputBox({
            prompt: 'Enter pod name',
            placeHolder: 'my-pod-123'
        });

        if (!podName) {
            return;
        }

        const follow = await vscode.window.showQuickPick(
            ['Follow logs', 'Show last 100 lines', 'Show all logs'],
            { placeHolder: 'Select log viewing mode' }
        );

        if (!follow) {
            return;
        }

        let command = `kubectl logs ${podName} -n ${namespace}`;
        if (follow === 'Follow logs') {
            command += ' -f';
        } else if (follow === 'Show last 100 lines') {
            command += ' --tail=100';
        }

        await this.executeCommand(command);
    }

    /**
     * Get kubeconfig path from config or default location
     */
    private getKubeconfigPath(): string {
        const config = vscode.workspace.getConfiguration('clusterPilot');
        let kubeconfigPath = config.get<string>('kubeconfigPath', '~/.kube/config');

        // Expand tilde
        if (kubeconfigPath.startsWith('~')) {
            kubeconfigPath = path.join(os.homedir(), kubeconfigPath.slice(1));
        }

        return kubeconfigPath;
    }

    /**
     * Update context when it changes
     */
    updateContext(context: string): void {
        this.currentContext = context;
    }

    /**
     * Close all kubectl terminals
     */
    closeAll(): void {
        this.terminals.forEach(terminal => {
            terminal.dispose();
        });
        this.terminals.clear();
    }

    /**
     * Get active terminal count
     */
    getActiveTerminalCount(): number {
        return this.terminals.size;
    }
}
