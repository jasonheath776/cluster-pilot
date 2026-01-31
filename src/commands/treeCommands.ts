import * as vscode from 'vscode';
import { BaseTreeProvider } from '../providers/baseProvider';
import { ResourceProvider } from '../providers/resourceProvider';
import { NamespaceProvider } from '../providers/namespaceProvider';
import { NodeProvider } from '../providers/nodeProvider';
import { logger } from '../utils/logger';

/**
 * Search/filter within a tree view
 */
export async function filterTreeView(provider: BaseTreeProvider<any>): Promise<void> {
    const currentFilter = provider.getFilter();
    
    const filterText = await vscode.window.showInputBox({
        prompt: 'Enter text to filter resources',
        placeHolder: 'Filter by name, namespace, or labels...',
        value: currentFilter
    });
    
    if (filterText === undefined) {
        // User cancelled
        return;
    }
    
    if (filterText === '') {
        provider.clearFilter();
        vscode.window.showInformationMessage('Filter cleared');
    } else {
        provider.setFilter(filterText);
        vscode.window.showInformationMessage(`Filtering by: ${filterText}`);
    }
}

/**
 * Clear filter on a tree view
 */
export function clearTreeFilter(provider: BaseTreeProvider<any>): void {
    provider.clearFilter();
    vscode.window.showInformationMessage('Filter cleared');
}

/**
 * Load more items for progressive loading
 */
export function loadMoreItems(provider: BaseTreeProvider<any>, parentKey: string): void {
    provider.loadMore(parentKey);
    logger.debug(`Loading more items for: ${parentKey}`);
}

/**
 * Toggle progressive loading
 */
export async function toggleProgressiveLoading(provider: BaseTreeProvider<any>): Promise<void> {
    const choice = await vscode.window.showQuickPick(
        [
            { label: 'Enable Progressive Loading', value: true, description: 'Load resources in batches' },
            { label: 'Disable Progressive Loading', value: false, description: 'Load all resources at once' }
        ],
        { placeHolder: 'Choose progressive loading mode' }
    );
    
    if (choice === undefined) {
        return;
    }
    
    if (choice.value) {
        const pageSizeInput = await vscode.window.showInputBox({
            prompt: 'Enter page size (number of items per page)',
            value: '50',
            validateInput: (value) => {
                const num = parseInt(value);
                if (isNaN(num) || num < 1 || num > 1000) {
                    return 'Please enter a number between 1 and 1000';
                }
                return null;
            }
        });
        
        if (pageSizeInput) {
            const pageSize = parseInt(pageSizeInput);
            provider.enableProgressiveLoading(pageSize);
            vscode.window.showInformationMessage(`Progressive loading enabled (${pageSize} items per page)`);
        }
    } else {
        provider.disableProgressiveLoading();
        vscode.window.showInformationMessage('Progressive loading disabled');
    }
}

/**
 * Enable watch for real-time updates
 */
export function enableWatch(provider: NamespaceProvider | NodeProvider): void {
    if ('enableWatch' in provider) {
        provider.enableWatch();
        vscode.window.showInformationMessage('Real-time watch enabled');
    }
}

/**
 * Disable watch
 */
export function disableWatch(provider: NamespaceProvider | NodeProvider): void {
    if ('disableWatch' in provider) {
        provider.disableWatch();
        vscode.window.showInformationMessage('Real-time watch disabled');
    }
}

/**
 * Show tree view statistics
 */
export async function showTreeStats(
    provider: BaseTreeProvider<any>,
    viewName: string
): Promise<void> {
    const filterText = provider.getFilter();
    
    const statsMessage = `
**${viewName} Statistics**

Filter: ${filterText || '(none)'}
Progressive Loading: Enabled

Tip: Use "Filter Tree View" to search resources
    `.trim();
    
    vscode.window.showInformationMessage(statsMessage, { modal: false });
}
