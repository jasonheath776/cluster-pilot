import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { K8sClient } from '../utils/k8sClient';

export class RBACItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: 'category' | 'role' | 'clusterrole' | 'rolebinding' | 'clusterrolebinding' | 'serviceaccount',
        public readonly resource?: any
    ) {
        super(label, collapsibleState);
        
        // Create unique ID based on item type
        if (itemType === 'category') {
            this.id = `rbac-category-${label}`;
        } else if (resource?.metadata?.uid) {
            this.id = `rbac-${itemType}-${resource.metadata.uid}`;
        } else if (resource?.metadata?.namespace && resource?.metadata?.name) {
            this.id = `rbac-${itemType}-${resource.metadata.namespace}-${resource.metadata.name}`;
        } else if (resource?.metadata?.name) {
            this.id = `rbac-${itemType}-${resource.metadata.name}`;
        } else {
            this.id = `rbac-${itemType}-${Math.random()}`;
        }
        
        this.contextValue = itemType;
        
        switch (itemType) {
            case 'role':
                this.iconPath = new vscode.ThemeIcon('shield');
                this.tooltip = `Role: ${resource?.metadata?.name}\nNamespace: ${resource?.metadata?.namespace}`;
                break;
            case 'clusterrole':
                this.iconPath = new vscode.ThemeIcon('organization');
                this.tooltip = `ClusterRole: ${resource?.metadata?.name}`;
                break;
            case 'rolebinding':
                this.iconPath = new vscode.ThemeIcon('link');
                this.description = resource?.roleRef?.name;
                this.tooltip = `RoleBinding: ${resource?.metadata?.name}\nRole: ${resource?.roleRef?.name}`;
                break;
            case 'clusterrolebinding':
                this.iconPath = new vscode.ThemeIcon('organization');
                this.description = resource?.roleRef?.name;
                this.tooltip = `ClusterRoleBinding: ${resource?.metadata?.name}\nRole: ${resource?.roleRef?.name}`;
                break;
            case 'serviceaccount':
                this.iconPath = new vscode.ThemeIcon('account');
                this.tooltip = `ServiceAccount: ${resource?.metadata?.name}\nNamespace: ${resource?.metadata?.namespace}`;
                break;
            case 'category':
                this.iconPath = new vscode.ThemeIcon('folder');
                break;
        }
    }
}

export class RBACProvider implements vscode.TreeDataProvider<RBACItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<RBACItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private k8sClient: K8sClient) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: RBACItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: RBACItem): Promise<RBACItem[]> {
        if (!element) {
            return [
                new RBACItem('Roles', vscode.TreeItemCollapsibleState.Collapsed, 'category'),
                new RBACItem('ClusterRoles', vscode.TreeItemCollapsibleState.Collapsed, 'category'),
                new RBACItem('RoleBindings', vscode.TreeItemCollapsibleState.Collapsed, 'category'),
                new RBACItem('ClusterRoleBindings', vscode.TreeItemCollapsibleState.Collapsed, 'category'),
                new RBACItem('ServiceAccounts', vscode.TreeItemCollapsibleState.Collapsed, 'category')
            ];
        }

        try {
            switch (element.label) {
                case 'Roles':
                    return this.getRoles();
                case 'ClusterRoles':
                    return this.getClusterRoles();
                case 'RoleBindings':
                    return this.getRoleBindings();
                case 'ClusterRoleBindings':
                    return this.getClusterRoleBindings();
                case 'ServiceAccounts':
                    return this.getServiceAccounts();
                default:
                    return [];
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to fetch RBAC resources: ${error}`);
            return [];
        }
    }

    private async getRoles(): Promise<RBACItem[]> {
        const roles = await this.k8sClient.getRoles();
        return roles.map(role => 
            new RBACItem(
                `${role.metadata?.name} (${role.metadata?.namespace})`,
                vscode.TreeItemCollapsibleState.None,
                'role',
                role
            )
        );
    }

    private async getClusterRoles(): Promise<RBACItem[]> {
        const clusterRoles = await this.k8sClient.getClusterRoles();
        return clusterRoles.map(role => 
            new RBACItem(
                role.metadata?.name || '',
                vscode.TreeItemCollapsibleState.None,
                'clusterrole',
                role
            )
        );
    }

    private async getRoleBindings(): Promise<RBACItem[]> {
        const bindings = await this.k8sClient.getRoleBindings();
        return bindings.map(binding => 
            new RBACItem(
                `${binding.metadata?.name} (${binding.metadata?.namespace})`,
                vscode.TreeItemCollapsibleState.None,
                'rolebinding',
                binding
            )
        );
    }

    private async getClusterRoleBindings(): Promise<RBACItem[]> {
        const bindings = await this.k8sClient.getClusterRoleBindings();
        return bindings.map(binding => 
            new RBACItem(
                binding.metadata?.name || '',
                vscode.TreeItemCollapsibleState.None,
                'clusterrolebinding',
                binding
            )
        );
    }

    private async getServiceAccounts(): Promise<RBACItem[]> {
        const accounts = await this.k8sClient.getServiceAccounts();
        return accounts.map(account => 
            new RBACItem(
                `${account.metadata?.name} (${account.metadata?.namespace})`,
                vscode.TreeItemCollapsibleState.None,
                'serviceaccount',
                account
            )
        );
    }
}
