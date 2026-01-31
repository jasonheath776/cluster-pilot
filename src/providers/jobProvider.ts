import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';

export class JobItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly job: k8s.V1Job | k8s.V1CronJob,
        public readonly jobType: 'job' | 'cronjob',
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(label, collapsibleState);
        this.id = `${jobType}-${job.metadata?.uid || job.metadata?.namespace}-${job.metadata?.name || Math.random()}`;
        this.contextValue = jobType;
        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.iconPath = this.getIcon();
    }

    private getTooltip(): string {
        if (this.jobType === 'job') {
            const j = this.job as k8s.V1Job;
            const succeeded = j.status?.succeeded || 0;
            const failed = j.status?.failed || 0;
            const active = j.status?.active || 0;
            return `Job: ${j.metadata?.name}\nSucceeded: ${succeeded} | Failed: ${failed} | Active: ${active}`;
        } else {
            const cj = this.job as k8s.V1CronJob;
            const schedule = cj.spec?.schedule || 'N/A';
            const lastSchedule = cj.status?.lastScheduleTime;
            return `CronJob: ${cj.metadata?.name}\nSchedule: ${schedule}\nLast Run: ${lastSchedule || 'Never'}`;
        }
    }

    private getDescription(): string {
        if (this.jobType === 'job') {
            const j = this.job as k8s.V1Job;
            const succeeded = j.status?.succeeded || 0;
            const failed = j.status?.failed || 0;
            const active = j.status?.active || 0;
            
            if (succeeded > 0) {
                return `✓ Succeeded`;
            } else if (failed > 0) {
                return `✗ Failed`;
            } else if (active > 0) {
                return `⟳ Running`;
            }
            return 'Pending';
        } else {
            const cj = this.job as k8s.V1CronJob;
            return cj.spec?.schedule || '';
        }
    }

    private getIcon(): vscode.ThemeIcon {
        if (this.jobType === 'job') {
            const j = this.job as k8s.V1Job;
            const succeeded = j.status?.succeeded || 0;
            const failed = j.status?.failed || 0;
            const active = j.status?.active || 0;

            if (succeeded > 0) {
                return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
            } else if (failed > 0) {
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
            } else if (active > 0) {
                return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('testing.iconQueued'));
            }
            return new vscode.ThemeIcon('circle-outline');
        } else {
            return new vscode.ThemeIcon('watch', new vscode.ThemeColor('symbolIcon.eventForeground'));
        }
    }
}

export class JobProvider implements vscode.TreeDataProvider<JobItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<JobItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private k8sClient: K8sClient) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: JobItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: JobItem): Promise<JobItem[]> {
        if (!element) {
            // Root level: show Jobs and CronJobs categories
            const jobs = await this.getJobs();
            const cronJobs = await this.getCronJobs();
            
            const items: JobItem[] = [];
            
            if (jobs.length > 0 || cronJobs.length > 0) {
                return [...jobs, ...cronJobs];
            }
            
            return items;
        }
        
        return [];
    }

    private async getJobs(): Promise<JobItem[]> {
        try {
            const jobs = await this.k8sClient.getJobs();
            return jobs.map(job => new JobItem(
                job.metadata?.name || 'unknown',
                job,
                'job'
            ));
        } catch (error) {
            console.error('Error fetching jobs:', error);
            return [];
        }
    }

    private async getCronJobs(): Promise<JobItem[]> {
        try {
            const cronJobs = await this.k8sClient.getCronJobs();
            return cronJobs.map(cronJob => new JobItem(
                cronJob.metadata?.name || 'unknown',
                cronJob,
                'cronjob'
            ));
        } catch (error) {
            console.error('Error fetching cronjobs:', error);
            return [];
        }
    }
}
