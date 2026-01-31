import * as vscode from 'vscode';
import { debounce } from '../utils/debounce';
import { DEBOUNCE } from '../utils/constants';
import { K8sWatch, WatchEvent } from '../utils/watch';
import * as k8s from '@kubernetes/client-node';
import { logger } from '../utils/logger';

/**
 * Configuration for progressive loading
 */
export interface ProgressiveLoadConfig {
    /** Enable progressive loading */
    enabled: boolean;
    /** Page size for progressive loading */
    pageSize: number;
    /** Show "Load More" button */
    showLoadMore: boolean;
}

/**
 * Base tree data provider with built-in debouncing, watch support, and advanced features
 */
export abstract class BaseTreeProvider<T extends vscode.TreeItem> implements vscode.TreeDataProvider<T>, vscode.Disposable {
    protected _onDidChangeTreeData: vscode.EventEmitter<T | undefined | null | void> = new vscode.EventEmitter<T | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<T | undefined | null | void> = this._onDidChangeTreeData.event;
    
    private watches: K8sWatch<any>[] = [];
    private disposables: vscode.Disposable[] = [];
    private debouncedRefresh: () => void;
    
    // Progressive loading
    protected progressiveLoadConfig: ProgressiveLoadConfig = {
        enabled: false,
        pageSize: 50,
        showLoadMore: true
    };
    protected loadedPages = new Map<string, number>(); // Track loaded pages per parent
    
    // Search/Filter
    protected filterText: string = '';
    protected filteredCache = new Map<string, T[]>();
    
    // Visible elements tracking for context-aware refresh
    protected visibleElements = new Set<string>();
    private treeView?: vscode.TreeView<T>;
    
    // Loading state
    protected isLoading = false;
    protected loadingMessage?: vscode.TreeItem;
    
    // Telemetry
    protected telemetry = {
        cacheHits: 0,
        cacheMisses: 0,
        totalRefreshes: 0,
        filterOperations: 0,
        progressiveLoadOperations: 0,
        lastRefreshTime: 0
    };

    constructor(debounceMs?: number) {
        // Load debounce timing from settings
        const config = vscode.workspace.getConfiguration('clusterPilot');
        const configuredDebounce = config.get<number>('debounceMs', DEBOUNCE.DEFAULT_WAIT);
        const finalDebounce = debounceMs ?? configuredDebounce;
        
        this.debouncedRefresh = debounce(() => this.fireRefresh(), finalDebounce);
        this.disposables.push(this._onDidChangeTreeData);
        
        logger.debug(`BaseTreeProvider initialized with ${finalDebounce}ms debounce`);
    }

    /**
     * Set the tree view to track visible elements
     */
    public setTreeView(treeView: vscode.TreeView<T>): void {
        this.treeView = treeView;
        
        // Track visible items
        this.disposables.push(
            treeView.onDidChangeVisibility(e => {
                if (e.visible) {
                    this.refresh();
                }
            })
        );
        
        // Track expansion state for context-aware refresh
        this.disposables.push(
            treeView.onDidExpandElement(e => {
                const id = this.getElementId(e.element);
                if (id) {
                    this.visibleElements.add(id);
                }
            }),
            treeView.onDidCollapseElement(e => {
                const id = this.getElementId(e.element);
                if (id) {
                    this.visibleElements.delete(id);
                }
            })
        );
    }

    /**
     * Get unique ID for an element (should be overridden if needed)
     */
    protected getElementId(element: T): string | undefined {
        return element.id;
    }
    
    /**
     * Get telemetry data
     */
    public getTelemetry() {
        return {
            ...this.telemetry,
            cacheHitRate: this.telemetry.cacheHits + this.telemetry.cacheMisses > 0
                ? (this.telemetry.cacheHits / (this.telemetry.cacheHits + this.telemetry.cacheMisses) * 100).toFixed(2) + '%'
                : '0%'
        };
    }
    
    /**
     * Set loading state
     */
    protected setLoading(loading: boolean, message?: string): void {
        this.isLoading = loading;
        if (loading && message) {
            this.loadingMessage = new vscode.TreeItem(message);
            this.loadingMessage.iconPath = new vscode.ThemeIcon('loading~spin');
            this.loadingMessage.contextValue = 'loading';
        } else {
            this.loadingMessage = undefined;
        }
    }

    /**
     * Check if element is visible (expanded in tree)
     */
    protected isElementVisible(element: T): boolean {
        const id = this.getElementId(element);
        return id ? this.visibleElements.has(id) : false;
    }

    /**
     * Enable progressive loading
     */
    public enableProgressiveLoading(pageSize: number = 50): void {
        this.progressiveLoadConfig = {
            enabled: true,
            pageSize,
            showLoadMore: true
        };
        this.loadedPages.clear();
        logger.info(`Progressive loading enabled with page size: ${pageSize}`);
    }

    /**
     * Disable progressive loading
     */
    public disableProgressiveLoading(): void {
        this.progressiveLoadConfig.enabled = false;
        this.loadedPages.clear();
    }

    /**
     * Set filter text for search
     */
    public setFilter(filterText: string): void {
        this.filterText = filterText.toLowerCase();
        this.filteredCache.clear();
        this.telemetry.filterOperations++;
        this.refresh();
        logger.info(`Filter set to: "${filterText}" (${this.telemetry.filterOperations} total filter operations)`);
    }

    /**
     * Clear filter
     */
    public clearFilter(): void {
        this.filterText = '';
        this.filteredCache.clear();
        this.refresh();
    }

    /**
     * Get current filter text
     */
    public getFilter(): string {
        return this.filterText;
    }

    /**
     * Check if item matches filter (can be overridden)
     */
    protected matchesFilter(element: T): boolean {
        if (!this.filterText) {
            return true;
        }
        
        const label = element.label?.toString().toLowerCase() || '';
        const description = element.description?.toString().toLowerCase() || '';
        const tooltip = element.tooltip?.toString().toLowerCase() || '';
        
        return label.includes(this.filterText) || 
               description.includes(this.filterText) || 
               tooltip.includes(this.filterText);
    }

    /**
     * Apply filter to items
     */
    protected applyFilter(items: T[]): T[] {
        if (!this.filterText) {
            return items;
        }

        // Check cache
        const cacheKey = `${this.filterText}-${items.length}`;
        if (this.filteredCache.has(cacheKey)) {
            this.telemetry.cacheHits++;
            logger.debug(`Filter cache hit: ${cacheKey}`);
            return this.filteredCache.get(cacheKey)!;
        }
        
        this.telemetry.cacheMisses++;

        // Filter items
        const filtered = items.filter(item => this.matchesFilter(item));
        
        // Cache result
        this.filteredCache.set(cacheKey, filtered);
        
        const percentage = items.length > 0 ? ((filtered.length / items.length) * 100).toFixed(1) : '0';
        logger.info(`Filter "${this.filterText}" matched ${filtered.length}/${items.length} items (${percentage}%)`);
        return filtered;
    }

    /**
     * Apply progressive loading to items
     */
    protected applyProgressiveLoading(items: T[], parentKey: string = 'root'): T[] {
        if (!this.progressiveLoadConfig.enabled) {
            return items;
        }
        
        const pageSize = this.progressiveLoadConfig.pageSize;
        const currentPage = this.loadedPages.get(parentKey) || 1;
        const endIndex = currentPage * pageSize;
        
        const result = items.slice(0, endIndex);
        
        // Add "Load More" item if there are more items
        if (this.progressiveLoadConfig.showLoadMore && endIndex < items.length) {
            const remaining = items.length - endIndex;
            result.push(this.createLoadMoreItem(remaining, parentKey) as T);
        }
        
        return result;
    }

    /**
     * Create "Load More" tree item
     */
    protected createLoadMoreItem(remaining: number, parentKey: string): vscode.TreeItem {
        const item = new vscode.TreeItem(
            `Load More... (${remaining} remaining)`,
            vscode.TreeItemCollapsibleState.None
        );
        item.id = `load-more-${parentKey}`;
        item.contextValue = 'loadMore';
        item.command = {
            command: 'clusterPilot.loadMore',
            title: 'Load More',
            arguments: [parentKey]
        };
        item.iconPath = new vscode.ThemeIcon('chevron-down');
        return item;
    }

    /**
     * Load more items for progressive loading
     */
    public loadMore(parentKey: string = 'root'): void {
        const currentPage = this.loadedPages.get(parentKey) || 1;
        this.loadedPages.set(parentKey, currentPage + 1);
        this.telemetry.progressiveLoadOperations++;
        this.refreshImmediate();
        logger.info(`📄 Loaded page ${currentPage + 1} for "${parentKey}" (total operations: ${this.telemetry.progressiveLoadOperations})`);
    }

    /**
     * Reset progressive loading for a parent
     */
    protected resetProgressiveLoading(parentKey: string = 'root'): void {
        this.loadedPages.set(parentKey, 1);
    }

    /**
     * Fire tree refresh event (preserves expansion state)
     */
    protected fireRefresh(): void {
        this._onDidChangeTreeData.fire(void 0);
    }

    /**
     * Public refresh method with debouncing
     * Context-aware: only refreshes visible elements if possible
     */
    public refresh(element?: T): void {
        this.telemetry.totalRefreshes++;
        this.telemetry.lastRefreshTime = Date.now();
        
        // Context-aware refresh: if element specified, only refresh that element
        if (element) {
            logger.debug(`🔄 Refreshing specific element (total refreshes: ${this.telemetry.totalRefreshes})`);
            this._onDidChangeTreeData.fire(element);
        } else {
            logger.debug(`🔄 Refreshing tree (debounced) (total refreshes: ${this.telemetry.totalRefreshes})`);
            this.debouncedRefresh();
        }
    }

    /**
     * Immediate refresh without debouncing
     */
    public refreshImmediate(element?: T): void {
        if (element) {
            this._onDidChangeTreeData.fire(element);
        } else {
            this.fireRefresh();
        }
    }

    /**
     * Refresh only visible elements (context-aware)
     */
    public refreshVisible(): void {
        // If we have visible elements tracked, refresh them individually
        if (this.visibleElements.size > 0) {
            logger.debug(`Context-aware refresh: ${this.visibleElements.size} visible elements`);
            // Fire a general refresh - VS Code will only re-fetch visible items
            this.fireRefresh();
        } else {
            // No tracking, do full refresh
            this.fireRefresh();
        }
    }

    /**
     * Start watching a Kubernetes resource for real-time updates
     */
    protected startWatch<TResource extends k8s.KubernetesObject>(
        kubeconfig: k8s.KubeConfig,
        path: string,
        options?: {
            labelSelector?: string;
            fieldSelector?: string;
        }
    ): void {
        try {
            const watch = new K8sWatch<TResource>(kubeconfig);
            
            watch.start(
                path,
                (event: WatchEvent<TResource>) => this.handleWatchEvent(event),
                (error: Error) => this.handleWatchError(error, path),
                {
                    labelSelector: options?.labelSelector,
                    fieldSelector: options?.fieldSelector,
                    autoReconnect: true
                }
            );

            this.watches.push(watch);
            const filters = [];
            if (options?.labelSelector) filters.push(`labels: ${options.labelSelector}`);
            if (options?.fieldSelector) filters.push(`fields: ${options.fieldSelector}`);
            const filterStr = filters.length > 0 ? ` with ${filters.join(', ')}` : '';
            logger.info(`👁️ Started watch on ${path}${filterStr}`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(`❌ Failed to start watch on ${path}: ${errorMsg}`, error);
            vscode.window.showErrorMessage(`Failed to start watch on ${path}: ${errorMsg}`);
        }
    }

    /**
     * Handle watch events (can be overridden for custom behavior)
     * Context-aware: only refreshes if element is visible
     */
    protected handleWatchEvent<TResource extends k8s.KubernetesObject>(event: WatchEvent<TResource>): void {
        logger.debug(`Watch event: ${event.type} for ${event.object.kind}/${event.object.metadata?.name}`);
        
        // For watch events, use context-aware refresh
        this.refreshVisible();
    }

    /**
     * Handle watch errors (can be overridden for custom behavior)
     */
    protected handleWatchError(error: Error, path?: string): void {
        const errorMsg = error.message || 'Unknown error';
        const pathStr = path ? ` on ${path}` : '';
        logger.error(`❌ Watch error${pathStr}: ${errorMsg}`, error);
        
        // Show user-friendly error messages
        if (errorMsg.includes('Unauthorized') || errorMsg.includes('403')) {
            vscode.window.showErrorMessage(
                `Watch failed${pathStr}: Insufficient permissions. Check your kubeconfig and RBAC settings.`
            );
        } else if (errorMsg.includes('ENOTFOUND') || errorMsg.includes('ECONNREFUSED')) {
            vscode.window.showErrorMessage(
                `Watch failed${pathStr}: Cannot connect to Kubernetes cluster. Check your cluster connection.`
            );
        } else if (errorMsg.includes('timeout')) {
            vscode.window.showWarningMessage(
                `Watch connection timed out${pathStr}. Will automatically reconnect.`
            );
        } else {
            vscode.window.showErrorMessage(
                `Watch error${pathStr}: ${errorMsg}`
            );
        }
    }

    /**
     * Stop all watches
     */
    protected stopAllWatches(): void {
        this.watches.forEach(watch => {
            try {
                watch.stop();
            } catch (error) {
                logger.error('Error stopping watch', error);
            }
        });
        this.watches = [];
    }

    /**
     * Dispose of all resources
     */
    public dispose(): void {
        this.stopAllWatches();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    // Abstract methods to be implemented by subclasses
    abstract getTreeItem(element: T): vscode.TreeItem;
    abstract getChildren(element?: T): Promise<T[]>;
}
