import * as vscode from 'vscode';
import * as cp from 'child_process';
import { promisify } from 'util';
import * as k8s from '@kubernetes/client-node';

const execAsync = promisify(cp.exec);

export interface VulnerabilityScan {
    image: string;
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
    total: number;
    scanTime: Date;
    vulnerabilities: Vulnerability[];
}

export interface Vulnerability {
    id: string;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
    title: string;
    description: string;
    packageName: string;
    installedVersion: string;
    fixedVersion?: string;
}

export interface SecurityIssue {
    id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    category: string;
    resource: string;
    namespace: string;
    title: string;
    description: string;
    remediation: string;
}

export class SecurityScanner {
    private trivyInstalled: boolean | undefined;

    async checkTrivyInstalled(): Promise<boolean> {
        if (this.trivyInstalled !== undefined) {
            return this.trivyInstalled;
        }

        try {
            await execAsync('trivy --version');
            this.trivyInstalled = true;
            return true;
        } catch {
            this.trivyInstalled = false;
            return false;
        }
    }

    async scanImage(image: string): Promise<VulnerabilityScan | null> {
        const hastrivy = await this.checkTrivyInstalled();
        if (!hastrivy) {
            vscode.window.showWarningMessage('Trivy is not installed. Image vulnerability scanning requires Trivy. Install from https://aquasecurity.github.io/trivy/');
            return null;
        }

        try {
            const { stdout } = await execAsync(
                `trivy image --format json --quiet "${image}"`,
                { maxBuffer: 50 * 1024 * 1024 }
            );

            const result = JSON.parse(stdout);
            const vulnerabilities: Vulnerability[] = [];
            let critical = 0, high = 0, medium = 0, low = 0, unknown = 0;

            if (result.Results) {
                for (const target of result.Results) {
                    if (target.Vulnerabilities) {
                        for (const vuln of target.Vulnerabilities) {
                            const severity = vuln.Severity || 'UNKNOWN';
                            
                            vulnerabilities.push({
                                id: vuln.VulnerabilityID,
                                severity,
                                title: vuln.Title || vuln.VulnerabilityID,
                                description: vuln.Description || '',
                                packageName: vuln.PkgName,
                                installedVersion: vuln.InstalledVersion,
                                fixedVersion: vuln.FixedVersion
                            });

                            switch (severity) {
                                case 'CRITICAL': critical++; break;
                                case 'HIGH': high++; break;
                                case 'MEDIUM': medium++; break;
                                case 'LOW': low++; break;
                                default: unknown++; break;
                            }
                        }
                    }
                }
            }

            return {
                image,
                critical,
                high,
                medium,
                low,
                unknown,
                total: critical + high + medium + low + unknown,
                scanTime: new Date(),
                vulnerabilities
            };
        } catch (error) {
            console.error(`Failed to scan image ${image}:`, error);
            return null;
        }
    }

    async scanPodSecurityIssues(pod: k8s.V1Pod): Promise<SecurityIssue[]> {
        const issues: SecurityIssue[] = [];
        const name = pod.metadata?.name || 'unknown';
        const namespace = pod.metadata?.namespace || 'default';

        // Check for privileged containers
        pod.spec?.containers?.forEach((container, idx) => {
            if (container.securityContext?.privileged) {
                issues.push({
                    id: `${name}-privileged-${idx}`,
                    severity: 'critical',
                    category: 'Security Context',
                    resource: `Pod/${name}`,
                    namespace,
                    title: 'Privileged Container Detected',
                    description: `Container "${container.name}" is running in privileged mode, which grants all capabilities to the container.`,
                    remediation: 'Remove "privileged: true" from the container security context unless absolutely necessary.'
                });
            }

            // Check for running as root
            if (container.securityContext?.runAsUser === 0 || !container.securityContext?.runAsNonRoot) {
                issues.push({
                    id: `${name}-root-${idx}`,
                    severity: 'high',
                    category: 'Security Context',
                    resource: `Pod/${name}`,
                    namespace,
                    title: 'Container Running as Root',
                    description: `Container "${container.name}" may be running as root user.`,
                    remediation: 'Set "runAsNonRoot: true" and specify a non-root user ID in securityContext.'
                });
            }

            // Check for host network
            if (pod.spec?.hostNetwork) {
                issues.push({
                    id: `${name}-hostnetwork`,
                    severity: 'high',
                    category: 'Network',
                    resource: `Pod/${name}`,
                    namespace,
                    title: 'Host Network Enabled',
                    description: 'Pod is using the host network namespace, which can expose services to the host.',
                    remediation: 'Remove "hostNetwork: true" unless required for specific networking requirements.'
                });
            }

            // Check for host PID
            if (pod.spec?.hostPID) {
                issues.push({
                    id: `${name}-hostpid`,
                    severity: 'high',
                    category: 'Isolation',
                    resource: `Pod/${name}`,
                    namespace,
                    title: 'Host PID Namespace Enabled',
                    description: 'Pod has access to host process namespace.',
                    remediation: 'Remove "hostPID: true" to maintain process isolation.'
                });
            }

            // Check for resource limits
            if (!container.resources?.limits) {
                issues.push({
                    id: `${name}-nolimits-${idx}`,
                    severity: 'medium',
                    category: 'Resource Management',
                    resource: `Pod/${name}`,
                    namespace,
                    title: 'No Resource Limits',
                    description: `Container "${container.name}" has no resource limits defined.`,
                    remediation: 'Set CPU and memory limits to prevent resource exhaustion attacks.'
                });
            }

            // Check for readiness/liveness probes
            if (!container.readinessProbe && !container.livenessProbe) {
                issues.push({
                    id: `${name}-noprobes-${idx}`,
                    severity: 'medium',
                    category: 'Health Checks',
                    resource: `Pod/${name}`,
                    namespace,
                    title: 'Missing Health Probes',
                    description: `Container "${container.name}" has no readiness or liveness probes.`,
                    remediation: 'Add readinessProbe and livenessProbe to ensure proper health monitoring.'
                });
            }

            // Check for image pull policy
            if (container.imagePullPolicy === 'Always' && container.image?.includes(':latest')) {
                issues.push({
                    id: `${name}-latest-${idx}`,
                    severity: 'medium',
                    category: 'Image Management',
                    resource: `Pod/${name}`,
                    namespace,
                    title: 'Using Latest Image Tag',
                    description: `Container "${container.name}" uses :latest tag which is not recommended for production.`,
                    remediation: 'Use specific image tags or digests for reproducible deployments.'
                });
            }

            // Check for capabilities
            if (container.securityContext?.capabilities?.add) {
                const dangerousCaps = ['SYS_ADMIN', 'NET_ADMIN', 'SYS_MODULE'];
                const addedDangerousCaps = container.securityContext.capabilities.add.filter(
                    cap => dangerousCaps.includes(cap)
                );
                
                if (addedDangerousCaps.length > 0) {
                    issues.push({
                        id: `${name}-caps-${idx}`,
                        severity: 'high',
                        category: 'Security Context',
                        resource: `Pod/${name}`,
                        namespace,
                        title: 'Dangerous Capabilities Added',
                        description: `Container "${container.name}" has dangerous capabilities: ${addedDangerousCaps.join(', ')}`,
                        remediation: 'Remove unnecessary capabilities and follow the principle of least privilege.'
                    });
                }
            }
        });

        return issues;
    }

    async scanServiceSecurityIssues(service: k8s.V1Service): Promise<SecurityIssue[]> {
        const issues: SecurityIssue[] = [];
        const name = service.metadata?.name || 'unknown';
        const namespace = service.metadata?.namespace || 'default';

        // Check for NodePort services
        if (service.spec?.type === 'NodePort') {
            issues.push({
                id: `${name}-nodeport`,
                severity: 'medium',
                category: 'Network Exposure',
                resource: `Service/${name}`,
                namespace,
                title: 'NodePort Service',
                description: 'Service is exposed via NodePort, making it accessible on all cluster nodes.',
                remediation: 'Consider using LoadBalancer or Ingress for external access instead of NodePort.'
            });
        }

        // Check for LoadBalancer without annotations
        if (service.spec?.type === 'LoadBalancer') {
            const hasWhitelist = service.metadata?.annotations?.['loadBalancerSourceRanges'];
            if (!hasWhitelist && !service.spec?.loadBalancerSourceRanges) {
                issues.push({
                    id: `${name}-lb-nowhitelist`,
                    severity: 'high',
                    category: 'Network Exposure',
                    resource: `Service/${name}`,
                    namespace,
                    title: 'LoadBalancer Without IP Whitelist',
                    description: 'LoadBalancer service is publicly accessible without IP restrictions.',
                    remediation: 'Add loadBalancerSourceRanges to restrict access to trusted IP ranges.'
                });
            }
        }

        return issues;
    }

    async scanNamespaceSecurityIssues(namespace: k8s.V1Namespace): Promise<SecurityIssue[]> {
        const issues: SecurityIssue[] = [];
        const name = namespace.metadata?.name || 'unknown';

        // Check for default namespace usage
        if (name === 'default') {
            issues.push({
                id: 'default-namespace',
                severity: 'low',
                category: 'Best Practices',
                resource: `Namespace/${name}`,
                namespace: name,
                title: 'Using Default Namespace',
                description: 'Resources are being deployed to the default namespace.',
                remediation: 'Create dedicated namespaces for different applications and environments.'
            });
        }

        // Check for missing resource quotas
        const hasResourceQuota = namespace.metadata?.annotations?.['has-resource-quota'] === 'true';
        if (!hasResourceQuota && name !== 'kube-system' && name !== 'kube-public') {
            issues.push({
                id: `${name}-no-quota`,
                severity: 'medium',
                category: 'Resource Management',
                resource: `Namespace/${name}`,
                namespace: name,
                title: 'No Resource Quota',
                description: 'Namespace does not have resource quotas configured.',
                remediation: 'Create ResourceQuota to prevent resource exhaustion.'
            });
        }

        // Check for missing network policies
        const hasNetworkPolicy = namespace.metadata?.annotations?.['has-network-policy'] === 'true';
        if (!hasNetworkPolicy && name !== 'kube-system') {
            issues.push({
                id: `${name}-no-netpol`,
                severity: 'high',
                category: 'Network Security',
                resource: `Namespace/${name}`,
                namespace: name,
                title: 'No Network Policy',
                description: 'Namespace does not have network policies configured.',
                remediation: 'Implement NetworkPolicy to control pod-to-pod communication.'
            });
        }

        return issues;
    }

    calculateSecurityScore(issues: SecurityIssue[]): number {
        let score = 100;
        
        issues.forEach(issue => {
            switch (issue.severity) {
                case 'critical':
                    score -= 15;
                    break;
                case 'high':
                    score -= 10;
                    break;
                case 'medium':
                    score -= 5;
                    break;
                case 'low':
                    score -= 2;
                    break;
            }
        });

        return Math.max(0, score);
    }

    getScoreGrade(score: number): string {
        if (score >= 90) { return 'A'; }
        if (score >= 80) { return 'B'; }
        if (score >= 70) { return 'C'; }
        if (score >= 60) { return 'D'; }
        return 'F';
    }
}
