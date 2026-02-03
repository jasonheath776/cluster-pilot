import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { Writable, Readable } from 'stream';
import WebSocket from 'ws';
import { validateNamespace, validateResourceName, validateContainerName } from './validation';
import { logger } from './logger';

export class TerminalManager {
    private terminals: Map<string, vscode.Terminal> = new Map();
    private kc: k8s.KubeConfig;

    constructor(kc: k8s.KubeConfig) {
        this.kc = kc;
    }

    async execInPod(
        namespace: string,
        podName: string,
        container?: string,
        command?: string
    ): Promise<void> {
        try {
            // Validate inputs
            const validatedNamespace = validateNamespace(namespace);
            const validatedPodName = validateResourceName(podName);
            
            const exec = new k8s.Exec(this.kc);
        
        // Get available containers if not specified
        if (!container) {
            const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
            const pod = await coreApi.readNamespacedPod(validatedPodName, validatedNamespace);
            
            if (pod.body.spec?.containers && pod.body.spec.containers.length > 1) {
                const selected = await vscode.window.showQuickPick(
                    pod.body.spec.containers.map(c => ({
                        label: c.name,
                        container: c.name
                    })),
                    { placeHolder: 'Select container' }
                );
                
                if (!selected) {
                    return;
                }
                container = selected.container;
            } else if (pod.body.spec?.containers && pod.body.spec.containers.length === 1) {
                container = pod.body.spec.containers[0].name;
            } else {
                vscode.window.showErrorMessage('No containers found in pod');
                return;
            }
        }
        
        // Validate container name
        const validatedContainer = validateContainerName(container);

        // Select shell if command not provided
        if (!command) {
            const shellOptions = [
                { label: '/bin/bash', description: 'Bash shell', shell: '/bin/bash' },
                { label: '/bin/sh', description: 'Bourne shell', shell: '/bin/sh' },
                { label: '/bin/zsh', description: 'Z shell', shell: '/bin/zsh' },
                { label: 'Custom', description: 'Enter custom command', shell: 'custom' }
            ];

            const selected = await vscode.window.showQuickPick(shellOptions, {
                placeHolder: 'Select shell to use'
            });

            if (!selected) {
                return;
            }

            if (selected.shell === 'custom') {
                const customCommand = await vscode.window.showInputBox({
                    prompt: 'Enter command to execute',
                    placeHolder: '/bin/bash -c "ls -la"'
                });
                if (!customCommand) {
                    return;
                }
                command = customCommand;
            } else {
                command = selected.shell;
            }
        }

        const terminalId = `${validatedNamespace}/${validatedPodName}/${validatedContainer}`;
        
        // Reuse existing terminal if available
        let terminal = this.terminals.get(terminalId);
        if (!terminal) {
            const pty = new K8sTerminalPty(
                exec,
                validatedNamespace,
                validatedPodName,
                validatedContainer,
                command || '/bin/sh'
            );
            
            terminal = vscode.window.createTerminal({
                name: `${validatedPodName} (${validatedContainer})`,
                pty
            });
            
            this.terminals.set(terminalId, terminal);
            
            // Clean up on terminal close
            vscode.window.onDidCloseTerminal(t => {
                if (t === terminal) {
                    this.terminals.delete(terminalId);
                    pty.close();
                }
            });
        }
        
        terminal.show();
        logger.info(`Opened terminal for pod ${validatedPodName} in namespace ${validatedNamespace}`);
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('Failed to exec in pod', error);
            vscode.window.showErrorMessage(`Failed to open terminal: ${errorMessage}`);
        }
    }

    dispose(): void {
        for (const terminal of this.terminals.values()) {
            terminal.dispose();
        }
        this.terminals.clear();
    }
}

class K8sTerminalPty implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number>();
    
    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private ws?: any;
    private exec: k8s.Exec;
    private namespace: string;
    private podName: string;
    private container: string;
    private command: string;
    private dimensions: vscode.TerminalDimensions | undefined;

    constructor(
        exec: k8s.Exec,
        namespace: string,
        podName: string,
        container: string,
        command: string
    ) {
        this.exec = exec;
        this.namespace = namespace;
        this.podName = podName;
        this.container = container;
        this.command = command;
    }

    async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
        this.dimensions = initialDimensions;
        
        try {
            const stdout = new Writable({
                write: (chunk, encoding, callback) => {
                    this.writeEmitter.fire(chunk.toString());
                    callback();
                }
            });

            const stderr = new Writable({
                write: (chunk, encoding, callback) => {
                    this.writeEmitter.fire(chunk.toString());
                    callback();
                }
            });

            const stdin = new Readable({
                read: () => {}
            });

            this.ws = await this.exec.exec(
                this.namespace,
                this.podName,
                this.container,
                [this.command],
                stdout,
                stderr,
                stdin,
                true,
                (status: k8s.V1Status) => {
                    if (status.status === 'Failure') {
                        this.writeEmitter.fire(`\r\nConnection closed: ${status.message}\r\n`);
                    }
                    this.closeEmitter.fire(0);
                }
            );

            // Send initial resize
            if (this.dimensions && this.ws) {
                this.resize(this.dimensions);
            }

            // Handle WebSocket errors
            if (this.ws) {
                this.ws.on('error', (error: Error) => {
                    this.writeEmitter.fire(`\r\nError: ${error.message}\r\n`);
                    this.closeEmitter.fire(1);
                });
            }

        } catch (error) {
            this.writeEmitter.fire(`\r\nFailed to connect: ${error}\r\n`);
            this.closeEmitter.fire(1);
        }
    }

    handleInput(data: string): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Send input to stdin channel (0)
            const buffer = Buffer.from(data);
            const frame = Buffer.concat([Buffer.from([0]), buffer]);
            this.ws.send(frame);
        }
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        this.dimensions = dimensions;
        this.resize(dimensions);
    }

    private resize(dimensions: vscode.TerminalDimensions): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Send resize message on channel 4
            const resizeMessage = JSON.stringify({
                width: dimensions.columns,
                height: dimensions.rows
            });
            const buffer = Buffer.from(resizeMessage);
            const frame = Buffer.concat([Buffer.from([4]), buffer]);
            this.ws.send(frame);
        }
    }

    close(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = undefined;
        }
    }
}
