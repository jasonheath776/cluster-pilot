import * as vscode from 'vscode';
import { HelmManager, HelmRelease, HelmRepo } from '../utils/helmManager';

export class HelmItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: 'repo' | 'release' | 'category',
        public readonly release?: HelmRelease,
        public readonly repo?: HelmRepo
    ) {
        super(label, collapsibleState);
        
        // Create unique ID based on item type
        if (itemType === 'release' && release) {
            this.id = `helm-release-${release.namespace}-${release.name}`;
        } else if (itemType === 'repo' && repo) {
            this.id = `helm-repo-${repo.name}`;
        } else {
            this.id = `helm-category-${label}`;
        }
        
        this.contextValue = itemType;
        
        if (itemType === 'release' && release) {
            this.description = `${release.chart} (${release.status})`;
            this.tooltip = `Namespace: ${release.namespace}\nChart: ${release.chart}\nRevision: ${release.revision}\nStatus: ${release.status}`;
            this.iconPath = new vscode.ThemeIcon(
                release.status === 'deployed' ? 'check' : 'warning'
            );
        } else if (itemType === 'repo' && repo) {
            this.description = repo.url;
            this.tooltip = `Repository: ${repo.name}\nURL: ${repo.url}`;
            this.iconPath = new vscode.ThemeIcon('repo');
        } else if (itemType === 'category') {
            this.iconPath = new vscode.ThemeIcon('folder');
        }
    }
}

export class HelmProvider implements vscode.TreeDataProvider<HelmItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HelmItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private helmManager: HelmManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: HelmItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: HelmItem): Promise<HelmItem[]> {
        if (!element) {
            // Root level - show categories
            return [
                new HelmItem('Releases', vscode.TreeItemCollapsibleState.Expanded, 'category'),
                new HelmItem('Repositories', vscode.TreeItemCollapsibleState.Collapsed, 'category')
            ];
        }

        if (element.itemType === 'category') {
            if (element.label === 'Releases') {
                return this.getReleases();
            } else if (element.label === 'Repositories') {
                return this.getRepositories();
            }
        }

        return [];
    }

    private async getReleases(): Promise<HelmItem[]> {
        try {
            const releases = await this.helmManager.listReleases();
            
            return releases.map(release => 
                new HelmItem(
                    release.name,
                    vscode.TreeItemCollapsibleState.None,
                    'release',
                    release
                )
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to list Helm releases: ${error}`);
            return [];
        }
    }

    private async getRepositories(): Promise<HelmItem[]> {
        try {
            const repos = await this.helmManager.listRepos();
            
            return repos.map(repo => 
                new HelmItem(
                    repo.name,
                    vscode.TreeItemCollapsibleState.None,
                    'repo',
                    undefined,
                    repo
                )
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to list Helm repositories: ${error}`);
            return [];
        }
    }
}
