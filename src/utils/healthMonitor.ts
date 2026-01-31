import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';

export interface HealthThreshold {
    cpuWarning: number;      // percentage
    cpuCritical: number;     // percentage
    memoryWarning: number;   // percentage
    memoryCritical: number;  // percentage
    podRestartWarning: number;
    podRestartCritical: number;
}

export interface ResourceHealth {
    status: 'healthy' | 'warning' | 'critical' | 'unknown';
    cpuUsage?: number;
    memoryUsage?: number;
    restartCount?: number;
    message?: string;
    issues: string[];
}

export class HealthMonitor {
    private static defaultThresholds: HealthThreshold = {
        cpuWarning: 70,
        cpuCritical: 90,
        memoryWarning: 80,
        memoryCritical: 95,
        podRestartWarning: 3,
        podRestartCritical: 10
    };

    constructor(private context: vscode.ExtensionContext) {}

    getThresholds(): HealthThreshold {
        const config = vscode.workspace.getConfiguration('clusterPilot.health');
        return {
            cpuWarning: config.get('cpuWarning', HealthMonitor.defaultThresholds.cpuWarning),
            cpuCritical: config.get('cpuCritical', HealthMonitor.defaultThresholds.cpuCritical),
            memoryWarning: config.get('memoryWarning', HealthMonitor.defaultThresholds.memoryWarning),
            memoryCritical: config.get('memoryCritical', HealthMonitor.defaultThresholds.memoryCritical),
            podRestartWarning: config.get('podRestartWarning', HealthMonitor.defaultThresholds.podRestartWarning),
            podRestartCritical: config.get('podRestartCritical', HealthMonitor.defaultThresholds.podRestartCritical)
        };
    }

    async setThresholds(thresholds: Partial<HealthThreshold>): Promise<void> {
        const config = vscode.workspace.getConfiguration('clusterPilot.health');
        
        for (const [key, value] of Object.entries(thresholds)) {
            if (value !== undefined) {
                await config.update(key, value, vscode.ConfigurationTarget.Global);
            }
        }
    }

    checkPodHealth(pod: k8s.V1Pod, metrics?: k8s.PodMetric): ResourceHealth {
        const thresholds = this.getThresholds();
        const issues: string[] = [];
        let status: 'healthy' | 'warning' | 'critical' | 'unknown' = 'healthy';

        // Check pod phase
        const phase = pod.status?.phase;
        if (phase !== 'Running' && phase !== 'Succeeded') {
            if (phase === 'Failed' || phase === 'Unknown') {
                status = 'critical';
                issues.push(`Pod is in ${phase} state`);
            } else {
                status = 'warning';
                issues.push(`Pod is ${phase}`);
            }
        }

        // Check container statuses
        const containerStatuses = pod.status?.containerStatuses || [];
        for (const container of containerStatuses) {
            // Check restarts
            const restartCount = container.restartCount || 0;
            if (restartCount >= thresholds.podRestartCritical) {
                status = 'critical';
                issues.push(`Container ${container.name} has ${restartCount} restarts (critical threshold: ${thresholds.podRestartCritical})`);
            } else if (restartCount >= thresholds.podRestartWarning && status !== 'critical') {
                status = 'warning';
                issues.push(`Container ${container.name} has ${restartCount} restarts (warning threshold: ${thresholds.podRestartWarning})`);
            }

            // Check container state
            if (container.state?.waiting) {
                const reason = container.state.waiting.reason;
                if (reason === 'CrashLoopBackOff' || reason === 'ImagePullBackOff') {
                    status = 'critical';
                    issues.push(`Container ${container.name}: ${reason}`);
                } else {
                    if (status === 'healthy') {
                        status = 'warning';
                    }
                    issues.push(`Container ${container.name} is waiting: ${reason}`);
                }
            }

            if (!container.ready && phase === 'Running') {
                if (status === 'healthy') {
                    status = 'warning';
                }
                issues.push(`Container ${container.name} is not ready`);
            }
        }

        // Check conditions
        const conditions = pod.status?.conditions || [];
        for (const condition of conditions) {
            if (condition.type === 'Ready' && condition.status !== 'True') {
                if (status === 'healthy') {
                    status = 'warning';
                }
                issues.push(`Pod not ready: ${condition.reason || condition.message}`);
            }
        }

        // Check metrics if available
        let cpuUsage: number | undefined;
        let memoryUsage: number | undefined;

        if (metrics && 'containers' in metrics) {
            let totalCpu = 0;
            let totalMemory = 0;
            let requestedCpu = 0;
            let requestedMemory = 0;

            for (const container of (metrics as { containers: k8s.ContainerMetric[] }).containers) {
                // Parse CPU (e.g., "100n" for nanocores)
                const cpuStr = container.usage?.cpu || '0';
                const cpuNano = this.parseCpu(cpuStr);
                totalCpu += cpuNano;

                // Parse memory (e.g., "100Mi")
                const memStr = container.usage?.memory || '0';
                const memBytes = this.parseMemory(memStr);
                totalMemory += memBytes;
            }

            // Get requests from pod spec
            for (const container of pod.spec?.containers || []) {
                const cpuRequest = container.resources?.requests?.cpu;
                const memRequest = container.resources?.requests?.memory;
                
                if (cpuRequest) {
                    requestedCpu += this.parseCpu(cpuRequest);
                }
                if (memRequest) {
                    requestedMemory += this.parseMemory(memRequest);
                }
            }

            if (requestedCpu > 0) {
                cpuUsage = (totalCpu / requestedCpu) * 100;
                if (cpuUsage >= thresholds.cpuCritical) {
                    status = 'critical';
                    issues.push(`CPU usage at ${cpuUsage.toFixed(1)}% (critical threshold: ${thresholds.cpuCritical}%)`);
                } else if (cpuUsage >= thresholds.cpuWarning && status !== 'critical') {
                    status = 'warning';
                    issues.push(`CPU usage at ${cpuUsage.toFixed(1)}% (warning threshold: ${thresholds.cpuWarning}%)`);
                }
            }

            if (requestedMemory > 0) {
                memoryUsage = (totalMemory / requestedMemory) * 100;
                if (memoryUsage >= thresholds.memoryCritical) {
                    status = 'critical';
                    issues.push(`Memory usage at ${memoryUsage.toFixed(1)}% (critical threshold: ${thresholds.memoryCritical}%)`);
                } else if (memoryUsage >= thresholds.memoryWarning && status !== 'critical') {
                    status = 'warning';
                    issues.push(`Memory usage at ${memoryUsage.toFixed(1)}% (warning threshold: ${thresholds.memoryWarning}%)`);
                }
            }
        }

        const restartCount = containerStatuses.reduce((sum: number, c: unknown) => {
            const container = c as { restartCount?: number };
            return sum + (container.restartCount || 0);
        }, 0);

        return {
            status,
            cpuUsage,
            memoryUsage,
            restartCount,
            message: issues.length > 0 ? issues[0] : 'All checks passed',
            issues
        };
    }

    getHealthIcon(status: 'healthy' | 'warning' | 'critical' | 'unknown'): string {
        switch (status) {
            case 'healthy':
                return '✅';
            case 'warning':
                return '⚠️';
            case 'critical':
                return '❌';
            case 'unknown':
            default:
                return '❓';
        }
    }

    getHealthColor(status: 'healthy' | 'warning' | 'critical' | 'unknown'): string {
        switch (status) {
            case 'healthy':
                return '#4CAF50';
            case 'warning':
                return '#FF9800';
            case 'critical':
                return '#F44336';
            case 'unknown':
            default:
                return '#9E9E9E';
        }
    }

    private parseCpu(cpu: string): number {
        // Parse CPU strings like "100m" (millicores) or "1" (cores) to nanocores
        if (cpu.endsWith('n')) {
            return parseInt(cpu.slice(0, -1));
        } else if (cpu.endsWith('u')) {
            return parseInt(cpu.slice(0, -1)) * 1000;
        } else if (cpu.endsWith('m')) {
            return parseInt(cpu.slice(0, -1)) * 1000000;
        } else {
            return parseInt(cpu) * 1000000000;
        }
    }

    private parseMemory(memory: string): number {
        // Parse memory strings like "100Mi" to bytes
        const units: Record<string, number> = {
            Ki: 1024,
            Mi: 1024 * 1024,
            Gi: 1024 * 1024 * 1024,
            Ti: 1024 * 1024 * 1024 * 1024,
            K: 1000,
            M: 1000 * 1000,
            G: 1000 * 1000 * 1000,
            T: 1000 * 1000 * 1000 * 1000
        };

        for (const [unit, multiplier] of Object.entries(units)) {
            if (memory.endsWith(unit)) {
                return parseInt(memory.slice(0, -unit.length)) * multiplier;
            }
        }

        return parseInt(memory) || 0;
    }
}
