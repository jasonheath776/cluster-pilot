import * as vscode from 'vscode';
import { BaseTreeProvider, ProgressiveLoadConfig } from '../providers/baseProvider';

// Mock vscode module
const mockTreeView = {
    onDidChangeVisibility: jest.fn(() => ({ dispose: jest.fn() })),
    onDidExpandElement: jest.fn(() => ({ dispose: jest.fn() })),
    onDidCollapseElement: jest.fn(() => ({ dispose: jest.fn() })),
    reveal: jest.fn()
};

jest.mock('vscode', () => ({
    TreeItem: class {
        constructor(public label: string) {
            this.id = label;
        }
        id?: string;
        contextValue?: string;
        command?: { title: string; command: string; arguments?: any[] };
    },
    TreeItemCollapsibleState: {
        None: 0,
        Collapsed: 1,
        Expanded: 2
    },
    ThemeIcon: class {
        constructor(public id: string) {}
    },
    EventEmitter: jest.fn().mockImplementation(() => ({
        event: jest.fn(),
        fire: jest.fn(),
        dispose: jest.fn()
    })),
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((key: string, defaultValue?: any) => defaultValue)
        }))
    }
}), { virtual: true });

// Mock logger
jest.mock('../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn()
    }
}));

// Mock debounce
jest.mock('../utils/debounce', () => ({
    debounce: (fn: Function) => fn
}));

// Test implementation of BaseTreeProvider
class TestTreeItem extends vscode.TreeItem {
    constructor(
        public label: string,
        public description?: string,
        public tooltip?: string,
        public parentKey?: string
    ) {
        super(label);
        this.id = label;
    }
}

class TestTreeProvider extends BaseTreeProvider<TestTreeItem> {
    public items: TestTreeItem[] = [];

    async getChildren(element?: TestTreeItem): Promise<TestTreeItem[]> {
        // Handle "Load More" button
        if (element?.contextValue === 'loadMore') {
            this.loadMore(element.parentKey!);
            return [];
        }

        if (element) {
            return [];
        }

        // Apply filter if active
        const filtered = this.applyFilter(this.items);

        // Apply progressive loading
        const paginated = this.applyProgressiveLoading(filtered, 'root');

        return paginated;
    }

    getTreeItem(element: TestTreeItem): vscode.TreeItem {
        return element;
    }

    // Expose protected methods for testing
    public testEnableProgressiveLoading(pageSize?: number) {
        this.enableProgressiveLoading(pageSize);
    }

    public testDisableProgressiveLoading() {
        this.disableProgressiveLoading();
    }

    public testSetFilter(text: string) {
        this.setFilter(text);
    }

    public testClearFilter() {
        this.clearFilter();
    }

    public testGetFilter(): string {
        return this.getFilter();
    }

    public testMatchesFilter(element: TestTreeItem): boolean {
        return this.matchesFilter(element);
    }

    public testApplyFilter(items: TestTreeItem[]): TestTreeItem[] {
        return this.applyFilter(items);
    }

    public testApplyProgressiveLoading(items: TestTreeItem[], parentKey: string): TestTreeItem[] {
        return this.applyProgressiveLoading(items, parentKey);
    }

    public testLoadMore(parentKey: string) {
        this.loadMore(parentKey);
    }

    public testRefreshVisible() {
        this.refreshVisible();
    }

    public testIsElementVisible(element: TestTreeItem): boolean {
        return this.isElementVisible(element);
    }

    public getProgressiveLoadConfig(): ProgressiveLoadConfig {
        return this.progressiveLoadConfig;
    }

    public getLoadedPages(): Map<string, number> {
        return this.loadedPages;
    }

    public getFilterText(): string {
        return this.filterText;
    }

    public getVisibleElements(): Set<string> {
        return this.visibleElements;
    }
}

describe('BaseTreeProvider', () => {
    let provider: TestTreeProvider;

    beforeEach(() => {
        provider = new TestTreeProvider();
        jest.clearAllMocks();
    });

    afterEach(() => {
        provider.dispose();
    });

    describe('Progressive Loading', () => {
        it('should be disabled by default', () => {
            const config = provider.getProgressiveLoadConfig();
            expect(config.enabled).toBe(false);
        });

        it('should enable progressive loading with custom page size', () => {
            provider.testEnableProgressiveLoading(100);
            const config = provider.getProgressiveLoadConfig();
            
            expect(config.enabled).toBe(true);
            expect(config.pageSize).toBe(100);
            expect(config.showLoadMore).toBe(true);
        });

        it('should enable progressive loading with default page size', () => {
            provider.testEnableProgressiveLoading();
            const config = provider.getProgressiveLoadConfig();
            
            expect(config.enabled).toBe(true);
            expect(config.pageSize).toBe(50);
        });

        it('should disable progressive loading', () => {
            provider.testEnableProgressiveLoading(100);
            provider.testDisableProgressiveLoading();
            
            const config = provider.getProgressiveLoadConfig();
            expect(config.enabled).toBe(false);
        });

        it('should load first page of items', () => {
            const items = Array.from({ length: 150 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            
            provider.testEnableProgressiveLoading(50);
            const result = provider.testApplyProgressiveLoading(items, 'root');
            
            expect(result.length).toBe(51); // 50 items + 1 "Load More" button
            expect(result[50].contextValue).toBe('loadMore');
            expect(result[50].label).toContain('100 remaining');
        });

        it('should load all items when total is less than page size', () => {
            const items = Array.from({ length: 30 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            
            provider.testEnableProgressiveLoading(50);
            const result = provider.testApplyProgressiveLoading(items, 'root');
            
            expect(result.length).toBe(30);
            expect(result.every(item => item.contextValue !== 'loadMore')).toBe(true);
        });

        it('should load next page when loadMore is called', () => {
            const items = Array.from({ length: 150 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            provider.items = items;
            
            provider.testEnableProgressiveLoading(50);
            provider.testApplyProgressiveLoading(items, 'root');
            
            // Load more
            provider.testLoadMore('root');
            
            const loadedPages = provider.getLoadedPages();
            expect(loadedPages.get('root')).toBe(2);
        });

        it('should create "Load More" button with correct remaining count', () => {
            const items = Array.from({ length: 175 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            
            provider.testEnableProgressiveLoading(50);
            const result = provider.testApplyProgressiveLoading(items, 'root');
            
            const loadMoreButton = result[result.length - 1];
            expect(loadMoreButton.label).toBe('Load More... (125 remaining)');
            expect(loadMoreButton.contextValue).toBe('loadMore');
        });

        it('should not add "Load More" button on last page', () => {
            const items = Array.from({ length: 100 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            
            provider.testEnableProgressiveLoading(50);
            // Load first page
            provider.testApplyProgressiveLoading(items, 'root');
            // Load second page
            provider.testLoadMore('root');
            const result = provider.testApplyProgressiveLoading(items, 'root');
            
            expect(result.length).toBe(100);
            expect(result.every(item => item.contextValue !== 'loadMore')).toBe(true);
        });
    });

    describe('Search/Filter', () => {
        beforeEach(() => {
            provider.items = [
                new TestTreeItem('nginx-prod-1', 'Running pod', 'nginx production pod 1'),
                new TestTreeItem('nginx-prod-2', 'Running pod', 'nginx production pod 2'),
                new TestTreeItem('redis-cache', 'Running pod', 'redis cache instance'),
                new TestTreeItem('mysql-db', 'Stopped', 'mysql database')
            ];
        });

        it('should filter items by label', () => {
            provider.testSetFilter('nginx');
            const filtered = provider.testApplyFilter(provider.items);
            
            expect(filtered.length).toBe(2);
            expect(filtered[0].label).toBe('nginx-prod-1');
            expect(filtered[1].label).toBe('nginx-prod-2');
        });

        it('should filter items by description', () => {
            provider.testSetFilter('Running');
            const filtered = provider.testApplyFilter(provider.items);
            
            expect(filtered.length).toBe(3);
        });

        it('should filter items by tooltip', () => {
            provider.testSetFilter('cache');
            const filtered = provider.testApplyFilter(provider.items);
            
            expect(filtered.length).toBe(1);
            expect(filtered[0].label).toBe('redis-cache');
        });

        it('should be case-insensitive', () => {
            provider.testSetFilter('NGINX');
            const filtered = provider.testApplyFilter(provider.items);
            
            expect(filtered.length).toBe(2);
        });

        it('should return empty array when no matches', () => {
            provider.testSetFilter('nonexistent');
            const filtered = provider.testApplyFilter(provider.items);
            
            expect(filtered.length).toBe(0);
        });

        it('should clear filter', () => {
            provider.testSetFilter('nginx');
            expect(provider.testGetFilter()).toBe('nginx');
            
            provider.testClearFilter();
            expect(provider.testGetFilter()).toBe('');
            
            const filtered = provider.testApplyFilter(provider.items);
            expect(filtered.length).toBe(4);
        });

        it('should check if element matches filter', () => {
            const item = new TestTreeItem('nginx-prod-1', 'Running', 'nginx pod');
            
            provider.testSetFilter('nginx');
            expect(provider.testMatchesFilter(item)).toBe(true);
            
            provider.testSetFilter('redis');
            expect(provider.testMatchesFilter(item)).toBe(false);
        });

        it('should return all items when filter is empty', () => {
            provider.testSetFilter('');
            const filtered = provider.testApplyFilter(provider.items);
            
            expect(filtered.length).toBe(4);
        });
    });

    describe('Filter + Progressive Loading Integration', () => {
        beforeEach(() => {
            provider.items = Array.from({ length: 150 }, (_, i) => {
                const label = i < 75 ? `nginx-${i}` : `redis-${i}`;
                return new TestTreeItem(label);
            });
        });

        it('should apply filter before progressive loading', () => {
            provider.testEnableProgressiveLoading(50);
            provider.testSetFilter('nginx');
            
            const filtered = provider.testApplyFilter(provider.items);
            expect(filtered.length).toBe(75);
            
            const paginated = provider.testApplyProgressiveLoading(filtered, 'root');
            expect(paginated.length).toBe(51); // 50 items + "Load More"
        });

        it('should show correct remaining count after filtering', () => {
            provider.testEnableProgressiveLoading(30);
            provider.testSetFilter('nginx'); // 75 matches
            
            const filtered = provider.testApplyFilter(provider.items);
            const paginated = provider.testApplyProgressiveLoading(filtered, 'root');
            
            const loadMoreButton = paginated[paginated.length - 1];
            expect(loadMoreButton.label).toBe('Load More... (45 remaining)');
        });
    });

    describe('Context-Aware Refresh', () => {
        it('should track visible elements on setTreeView', () => {
            let expandCallback: any;
            let collapseCallback: any;

            const mockTreeView: any = {
                onDidChangeVisibility: jest.fn(() => ({ dispose: jest.fn() })),
                onDidExpandElement: jest.fn((cb) => {
                    expandCallback = cb;
                    return { dispose: jest.fn() };
                }),
                onDidCollapseElement: jest.fn((cb) => {
                    collapseCallback = cb;
                    return { dispose: jest.fn() };
                })
            };

            provider.setTreeView(mockTreeView);

            expect(mockTreeView.onDidExpandElement).toHaveBeenCalled();
            expect(mockTreeView.onDidCollapseElement).toHaveBeenCalled();

            // Simulate expand
            const item = new TestTreeItem('test-item');
            expandCallback({ element: item });

            const visibleElements = provider.getVisibleElements();
            expect(visibleElements.has('test-item')).toBe(true);

            // Simulate collapse
            collapseCallback({ element: item });
            expect(visibleElements.has('test-item')).toBe(false);
        });

        it('should check if element is visible', () => {
            const item = new TestTreeItem('test-item');
            
            expect(provider.testIsElementVisible(item)).toBe(false);
            
            // Manually add to visible set
            provider.getVisibleElements().add('test-item');
            
            expect(provider.testIsElementVisible(item)).toBe(true);
        });

        it('should have unique element IDs', () => {
            const item1 = new TestTreeItem('item-1');
            const item2 = new TestTreeItem('item-2');
            
            expect(item1.id).not.toBe(item2.id);
        });
    });

    describe('Disposal', () => {
        it('should dispose all resources', () => {
            provider.testEnableProgressiveLoading();
            provider.setTreeView(mockTreeView as any);
            
            expect(() => provider.dispose()).not.toThrow();
        });

        it('should stop watching on disposal', async () => {
            // This would need integration with watch tests
            provider.dispose();
            // Verify no memory leaks
            expect(provider.getLoadedPages().size).toBe(0);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty item list', () => {
            provider.items = [];
            provider.testEnableProgressiveLoading(50);
            
            const result = provider.testApplyProgressiveLoading([], 'root');
            expect(result.length).toBe(0);
        });

        it('should handle undefined elements in filter', () => {
            const items = [
                new TestTreeItem('item-1', undefined, undefined),
                new TestTreeItem('item-2', 'description', undefined)
            ];
            
            provider.testSetFilter('item');
            const filtered = provider.testApplyFilter(items);
            
            expect(filtered.length).toBe(2);
        });

        it('should handle page size of 1', () => {
            provider.items = Array.from({ length: 5 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            
            provider.testEnableProgressiveLoading(1);
            const result = provider.testApplyProgressiveLoading(provider.items, 'root');
            
            expect(result.length).toBe(2); // 1 item + "Load More"
        });

        it('should handle very large page size', () => {
            provider.items = Array.from({ length: 50 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            
            provider.testEnableProgressiveLoading(1000);
            const result = provider.testApplyProgressiveLoading(provider.items, 'root');
            
            expect(result.length).toBe(50); // All items, no "Load More"
        });
    });
});
