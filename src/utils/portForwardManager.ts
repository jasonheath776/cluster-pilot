import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import * as net from 'net';

export interface PortForward {
    id: string;
    namespace: string;
    podName: string;
    localPort: number;
    remotePort: number;
    server: net.Server;
    statusBarItem: vscode.StatusBarItem;
}

export class PortForwardManager {
    private forwards: Map<string, PortForward> = new Map();
    private kc: k8s.KubeConfig;

    constructor(kc: k8s.KubeConfig) {
        this.kc = kc;
    }

    async startPortForward(
        namespace: string,
        podName: string,
        remotePort: number,
        localPort?: number
    ): Promise<PortForward> {
        // Find available local port if not specified
        if (!localPort) {
            localPort = await this.findAvailablePort();
        }

        const id = `${namespace}/${podName}:${localPort}->${remotePort}`;
        
        // Check if already forwarding
        if (this.forwards.has(id)) {
            throw new Error(`Port forward already exists: ${id}`);
        }

        const forward = new k8s.PortForward(this.kc);
        const server = net.createServer(async (socket) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const forwardStream = await forward.portForward(
                    namespace,
                    podName,
                    [remotePort],
                    socket,
                    null,
                    socket
                ) as any;

                socket.on('close', () => {
                    if (forwardStream && forwardStream.destroy) {
                        forwardStream.destroy();
                    }
                });

                if (forwardStream && forwardStream.on) {
                    forwardStream.on('close', () => {
                        socket.destroy();
                    });
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Port forward error: ${error}`);
                socket.destroy();
            }
        });

        await new Promise<void>((resolve, reject) => {
            server.listen(localPort, '127.0.0.1', () => {
                resolve();
            });
            server.on('error', reject);
        });

        // Create status bar item
        const statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        statusBarItem.text = `$(radio-tower) ${podName}:${localPort}→${remotePort}`;
        statusBarItem.tooltip = `Port forward: ${namespace}/${podName}\nLocal: ${localPort} → Remote: ${remotePort}\nClick to stop`;
        statusBarItem.command = {
            command: 'clusterPilot.stopPortForward',
            title: 'Stop Port Forward',
            arguments: [id]
        };
        statusBarItem.show();

        const portForward: PortForward = {
            id,
            namespace,
            podName,
            localPort,
            remotePort,
            server,
            statusBarItem
        };

        this.forwards.set(id, portForward);

        vscode.window.showInformationMessage(
            `Port forwarding started: localhost:${localPort} → ${podName}:${remotePort}`,
            'Open in Browser'
        ).then(action => {
            if (action === 'Open in Browser') {
                vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${localPort}`));
            }
        });

        return portForward;
    }

    async stopPortForward(id: string): Promise<void> {
        const forward = this.forwards.get(id);
        if (!forward) {
            throw new Error(`Port forward not found: ${id}`);
        }

        forward.server.close();
        forward.statusBarItem.dispose();
        this.forwards.delete(id);

        vscode.window.showInformationMessage(`Port forward stopped: ${id}`);
    }

    stopAllPortForwards(): void {
        for (const [id] of this.forwards) {
            this.stopPortForward(id);
        }
    }

    getActiveForwards(): PortForward[] {
        return Array.from(this.forwards.values());
    }

    private async findAvailablePort(startPort: number = 8080): Promise<number> {
        for (let port = startPort; port < startPort + 100; port++) {
            if (await this.isPortAvailable(port)) {
                return port;
            }
        }
        throw new Error('No available ports found');
    }

    private async isPortAvailable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => {
                resolve(false);
            });
            server.once('listening', () => {
                server.close();
                resolve(true);
            });
            server.listen(port, '127.0.0.1');
        });
    }

    dispose(): void {
        this.stopAllPortForwards();
    }
}
