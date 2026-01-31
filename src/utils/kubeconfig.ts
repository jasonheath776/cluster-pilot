import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from './logger';
import { LOCAL_HOSTS, PATHS } from './constants';

export class KubeconfigManager {
    private kc: k8s.KubeConfig;
    private configPath: string;

    constructor() {
        this.kc = new k8s.KubeConfig();
        this.configPath = this.getKubeconfigPath();
        this.loadConfig();
    }

    private getKubeconfigPath(): string {
        const config = vscode.workspace.getConfiguration('clusterPilot');
        let configPath = config.get<string>('kubeconfigPath', PATHS.DEFAULT_KUBECONFIG);
        
        // Expand tilde
        if (configPath.startsWith('~/')) {
            configPath = path.join(os.homedir(), configPath.slice(2));
        }
        
        // Check if KUBECONFIG env var is set
        if (process.env.KUBECONFIG) {
            configPath = process.env.KUBECONFIG;
        }

        return configPath;
    }

    public loadConfig(): void {
        try {
            if (fs.existsSync(this.configPath)) {
                this.kc.loadFromFile(this.configPath);
                
                // Only skip TLS verification for known local development clusters
                const clusterObj = this.kc.getCurrentCluster();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if (clusterObj && typeof clusterObj !== 'string' && (clusterObj as any).server && this.isLocalCluster((clusterObj as any).server)) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (clusterObj as any).skipTLSVerify = true;
                    logger.debug(`Skipping TLS verification for local cluster: ${(clusterObj as any).server}`);
                }
                
                const context = this.kc.getCurrentContext();
                if (!context) {
                    logger.warn('No current context configured in kubeconfig');
                }
                
                logger.info('Kubeconfig loaded from:', this.configPath);
                if (context) {
                    logger.debug('Current context:', context);
                }
            } else {
                this.kc.loadFromDefault();
                const clusterObj = this.kc.getCurrentCluster();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if (clusterObj && typeof clusterObj !== 'string' && (clusterObj as any).server && this.isLocalCluster((clusterObj as any).server)) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (clusterObj as any).skipTLSVerify = true;
                    logger.debug(`Skipping TLS verification for local cluster: ${(clusterObj as any).server}`);
                }
                logger.info('Kubeconfig loaded from default location');
            }
        } catch (error) {
            logger.error('Failed to load kubeconfig', error);
            vscode.window.showErrorMessage(`Failed to load kubeconfig: ${error instanceof Error ? error.message : String(error)}`);
            try {
                this.kc.loadFromDefault();
            } catch (defaultError) {
                logger.error('Failed to load default kubeconfig', defaultError);
            }
        }
    }

    /**
     * Checks if a cluster server URL is a local development cluster
     */
    private isLocalCluster(server: string | undefined): boolean {
        if (!server) {
            return false;
        }
        
        return LOCAL_HOSTS.some(pattern => server.includes(pattern));
    }

    public getKubeConfig(): k8s.KubeConfig {
        return this.kc;
    }

    public getCurrentContext(): string | undefined {
        return this.kc.getCurrentContext();
    }

    public getContexts(): k8s.Context[] {
        return this.kc.getContexts();
    }

    public getClusters(): k8s.Cluster[] {
        return this.kc.getClusters();
    }

    public setCurrentContext(contextName: string): void {
        this.kc.setCurrentContext(contextName);
        this.saveConfig();
    }

    public async addCluster(clusterInfo: {
        name: string;
        server: string;
        certificateAuthority?: string;
        skipTLSVerify?: boolean;
    }): Promise<void> {
        const cluster: k8s.Cluster = {
            name: clusterInfo.name,
            server: clusterInfo.server,
            skipTLSVerify: clusterInfo.skipTLSVerify || false
        };

        if (clusterInfo.certificateAuthority) {
            cluster.caFile = clusterInfo.certificateAuthority;
        }

        this.kc.addCluster(cluster);
        this.saveConfig();
    }

    public async addContext(contextInfo: {
        name: string;
        cluster: string;
        user: string;
        namespace?: string;
    }): Promise<void> {
        const context: k8s.Context = {
            name: contextInfo.name,
            cluster: contextInfo.cluster,
            user: contextInfo.user,
            namespace: contextInfo.namespace || 'default'
        };

        this.kc.addContext(context);
        this.saveConfig();
    }

    public removeContext(contextName: string): void {
        const contexts = this.kc.getContexts();
        const filteredContexts = contexts.filter(ctx => ctx.name !== contextName);
        
        // Rebuild config without the removed context
        const newKc = new k8s.KubeConfig();
        newKc.clusters = this.kc.clusters;
        newKc.users = this.kc.users;
        newKc.contexts = filteredContexts;
        
        if (this.kc.getCurrentContext() === contextName && filteredContexts.length > 0) {
            newKc.setCurrentContext(filteredContexts[0].name);
        }
        
        this.kc = newKc;
        this.saveConfig();
    }

    private saveConfig(): void {
        try {
            const configData = this.kc.exportConfig();
            const dir = path.dirname(this.configPath);
            
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(this.configPath, configData, 'utf8');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save kubeconfig: ${error}`);
        }
    }

    public reload(): void {
        this.loadConfig();
    }
}
