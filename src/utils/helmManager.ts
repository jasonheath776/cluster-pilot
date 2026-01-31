import * as vscode from 'vscode';
import * as cp from 'child_process';
import { promisify } from 'util';
import { validateResourceName, validateNamespace, escapeShellArg } from './validation';
import { logger } from './logger';
import { NETWORK, PATTERNS } from './constants';
import { withRetry } from './retry';

const execAsync = promisify(cp.exec);

export interface HelmRelease {
    name: string;
    namespace: string;
    revision: string;
    updated: string;
    status: string;
    chart: string;
    appVersion: string;
}

export interface HelmRepo {
    name: string;
    url: string;
}

export interface HelmChart {
    name: string;
    version: string;
    appVersion: string;
    description: string;
}

export class HelmManager {
    private kubeconfig: string;

    constructor(kubeconfigPath?: string) {
        this.kubeconfig = kubeconfigPath || '';
    }

    private async execHelm(args: string[]): Promise<string> {
        // Validate that args don't contain dangerous characters
        // Only check for the most critical shell injection patterns
        for (const arg of args) {
            if (typeof arg === 'string') {
                // Check for actual command injection attempts, but allow normal helm arguments
                if (arg.includes(';') || arg.includes('|') || arg.includes('&') || 
                    arg.includes('$(') || arg.includes('`') || arg.includes('\n')) {
                    throw new Error(`Invalid characters in helm argument: ${arg}`);
                }
            }
        }
        
        const kubeconfigArg = this.kubeconfig ? `--kubeconfig ${escapeShellArg(this.kubeconfig)}` : '';
        // Add --kube-insecure-skip-tls-verify to work around certificate conflicts
        const tlsFlag = '--kube-insecure-skip-tls-verify';
        const command = `helm ${args.join(' ')} ${kubeconfigArg} ${tlsFlag}`;
        
        logger.debug('Executing helm command:', command);
        
        try {
            const { stdout, stderr } = await withRetry(
                async () => await execAsync(command, {
                    maxBuffer: NETWORK.MAX_BUFFER_SIZE
                }),
                {
                    maxRetries: 2, // Helm operations are often slower, use fewer retries
                    retryDelay: 2000 // Longer delay for helm operations
                }
            );
            
            if (stderr && !stderr.includes('WARNING')) {
                logger.warn('Helm stderr:', stderr);
            }
            
            return stdout;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('Helm command failed', error);
            throw new Error(`Helm command failed: ${errorMessage}`);
        }
    }

    async checkHelmInstalled(): Promise<boolean> {
        try {
            await execAsync('helm version --short');
            return true;
        } catch {
            return false;
        }
    }

    async listReleases(namespace?: string): Promise<HelmRelease[]> {
        const args = ['list', '--output', 'json'];
        
        if (namespace) {
            args.push('--namespace', namespace);
        } else {
            args.push('--all-namespaces');
        }

        const output = await this.execHelm(args);
        
        if (!output.trim()) {
            return [];
        }

        return JSON.parse(output);
    }

    async getReleaseDetails(name: string, namespace: string): Promise<any> {
        const args = ['get', 'all', name, '--namespace', namespace];
        const output = await this.execHelm(args);
        return output;
    }

    async getReleaseValues(name: string, namespace: string): Promise<string> {
        const args = ['get', 'values', name, '--namespace', namespace, '--all'];
        return await this.execHelm(args);
    }

    async getReleaseHistory(name: string, namespace: string): Promise<any[]> {
        const args = ['history', name, '--namespace', namespace, '--output', 'json'];
        const output = await this.execHelm(args);
        return JSON.parse(output);
    }

    async installChart(
        releaseName: string,
        chart: string,
        namespace: string,
        values?: string,
        version?: string
    ): Promise<void> {
        // Validate inputs
        const validatedName = validateResourceName(releaseName);
        const validatedNamespace = validateNamespace(namespace);
        
        const args = ['install', validatedName, chart, '--namespace', validatedNamespace, '--create-namespace'];
        
        if (version) {
            args.push('--version', version);
        }

        if (values) {
            // Write values to temp file
            const tempFile = await this.writeTempFile(values);
            args.push('--values', tempFile);
        }

        await this.execHelm(args);
    }

    async upgradeRelease(
        name: string,
        chart: string,
        namespace: string,
        values?: string,
        version?: string
    ): Promise<void> {
        const args = ['upgrade', name, chart, '--namespace', namespace];
        
        if (version) {
            args.push('--version', version);
        }

        if (values) {
            const tempFile = await this.writeTempFile(values);
            args.push('--values', tempFile);
        }

        await this.execHelm(args);
    }

    async uninstallRelease(name: string, namespace: string): Promise<void> {
        const validatedName = validateResourceName(name);
        const validatedNamespace = validateNamespace(namespace);
        const args = ['uninstall', validatedName, '--namespace', validatedNamespace];
        await this.execHelm(args);
    }

    async rollbackRelease(name: string, namespace: string, revision?: number): Promise<void> {
        const args = ['rollback', name];
        
        if (revision !== undefined) {
            args.push(revision.toString());
        }
        
        args.push('--namespace', namespace);
        await this.execHelm(args);
    }

    async listRepos(): Promise<HelmRepo[]> {
        const args = ['repo', 'list', '--output', 'json'];
        
        try {
            const output = await this.execHelm(args);
            if (!output.trim()) {
                return [];
            }
            return JSON.parse(output);
        } catch {
            return [];
        }
    }

    async addRepo(name: string, url: string): Promise<void> {
        const args = ['repo', 'add', name, url];
        await this.execHelm(args);
    }

    async removeRepo(name: string): Promise<void> {
        const args = ['repo', 'remove', name];
        await this.execHelm(args);
    }

    async updateRepos(): Promise<void> {
        const args = ['repo', 'update'];
        await this.execHelm(args);
    }

    async searchCharts(keyword: string, repo?: string): Promise<HelmChart[]> {
        const args = ['search', 'repo'];
        
        if (repo) {
            args.push(`${repo}/${keyword}`);
        } else {
            args.push(keyword);
        }
        
        args.push('--output', 'json', '--max-col-width', '0');

        try {
            const output = await this.execHelm(args);
            if (!output.trim()) {
                return [];
            }
            return JSON.parse(output);
        } catch {
            return [];
        }
    }

    async getChartVersions(chart: string): Promise<HelmChart[]> {
        const args = ['search', 'repo', chart, '--versions', '--output', 'json'];
        
        try {
            const output = await this.execHelm(args);
            if (!output.trim()) {
                return [];
            }
            return JSON.parse(output);
        } catch {
            return [];
        }
    }

    private async writeTempFile(content: string): Promise<string> {
        const fs = require('fs').promises;
        const path = require('path');
        const os = require('os');
        
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `helm-values-${Date.now()}.yaml`);
        
        await fs.writeFile(tempFile, content, 'utf8');
        return tempFile;
    }

    async testRelease(name: string, namespace: string): Promise<string> {
        const args = ['test', name, '--namespace', namespace];
        return await this.execHelm(args);
    }
}
