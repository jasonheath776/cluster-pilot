/**
 * Performance Benchmarks for Cluster Pilot
 * 
 * Run with: npm run benchmark
 */

import { BaseTreeProvider } from '../providers/baseProvider';
import * as vscode from 'vscode';

// Mock vscode
jest.mock('vscode', () => ({
    TreeItem: class {
        constructor(public label: string) {
            this.id = label;
        }
        id?: string;
        contextValue?: string;
    },
    TreeItemCollapsibleState: {
        None: 0,
        Collapsed: 1,
        Expanded: 2
    },
    EventEmitter: jest.fn().mockImplementation(() => ({
        event: jest.fn(),
        fire: jest.fn(),
        dispose: jest.fn()
    }))
}), { virtual: true });

jest.mock('../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn()
    }
}));

jest.mock('../utils/debounce', () => ({
    debounce: (fn: Function) => fn
}));

class TestTreeItem extends vscode.TreeItem {
    constructor(
        public label: string,
        public description?: string,
        public parentKey?: string
    ) {
        super(label);
        this.id = label;
    }
}

class BenchmarkProvider extends BaseTreeProvider<TestTreeItem> {
    public items: TestTreeItem[] = [];

    async getChildren(element?: TestTreeItem): Promise<TestTreeItem[]> {
        if (element?.contextValue === 'loadMore') {
            this.loadMore(element.parentKey!);
            return [];
        }

        if (element) {
            return [];
        }

        const filtered = this.applyFilter(this.items);
        const paginated = this.applyProgressiveLoading(filtered, 'root');
        return paginated;
    }

    getTreeItem(element: TestTreeItem): vscode.TreeItem {
        return element;
    }

    public benchEnableProgressiveLoading(pageSize?: number) {
        this.enableProgressiveLoading(pageSize);
    }

    public benchSetFilter(text: string) {
        this.setFilter(text);
    }

    public benchApplyFilter(items: TestTreeItem[]): TestTreeItem[] {
        return this.applyFilter(items);
    }

    public benchApplyProgressiveLoading(items: TestTreeItem[], parentKey: string): TestTreeItem[] {
        return this.applyProgressiveLoading(items, parentKey);
    }
}

/**
 * Measure execution time of a function
 */
function benchmark(name: string, fn: () => void, iterations: number = 1000): void {
    const start = performance.now();
    
    for (let i = 0; i < iterations; i++) {
        fn();
    }
    
    const end = performance.now();
    const total = end - start;
    const avg = total / iterations;
    
    console.log(`\n📊 ${name}`);
    console.log(`   Total: ${total.toFixed(2)}ms`);
    console.log(`   Average: ${avg.toFixed(4)}ms`);
    console.log(`   Iterations: ${iterations}`);
    console.log(`   Ops/sec: ${(1000 / avg).toFixed(0)}`);
}

/**
 * Measure async execution time
 */
async function benchmarkAsync(name: string, fn: () => Promise<void>, iterations: number = 100): Promise<void> {
    const start = performance.now();
    
    for (let i = 0; i < iterations; i++) {
        await fn();
    }
    
    const end = performance.now();
    const total = end - start;
    const avg = total / iterations;
    
    console.log(`\n📊 ${name}`);
    console.log(`   Total: ${total.toFixed(2)}ms`);
    console.log(`   Average: ${avg.toFixed(4)}ms`);
    console.log(`   Iterations: ${iterations}`);
    console.log(`   Ops/sec: ${(1000 / avg).toFixed(0)}`);
}

describe('Performance Benchmarks', () => {
    let provider: BenchmarkProvider;

    beforeAll(() => {
        console.log('\n🚀 Starting Performance Benchmarks\n');
        console.log('=' .repeat(60));
    });

    beforeEach(() => {
        provider = new BenchmarkProvider();
    });

    afterEach(() => {
        provider.dispose();
    });

    describe('Progressive Loading Performance', () => {
        it('should benchmark loading first page (100 items)', () => {
            const items = Array.from({ length: 1000 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            
            provider.benchEnableProgressiveLoading(100);
            
            benchmark('Progressive Loading - First Page (100 of 1000)', () => {
                provider.benchApplyProgressiveLoading(items, 'root');
            }, 1000);
        });

        it('should benchmark loading first page (1000 items)', () => {
            const items = Array.from({ length: 5000 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            
            provider.benchEnableProgressiveLoading(1000);
            
            benchmark('Progressive Loading - First Page (1000 of 5000)', () => {
                provider.benchApplyProgressiveLoading(items, 'root');
            }, 1000);
        });

        it('should benchmark without progressive loading (all items)', () => {
            const items = Array.from({ length: 1000 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            
            // Progressive loading disabled
            
            benchmark('No Progressive Loading - All 1000 items', () => {
                provider.benchApplyProgressiveLoading(items, 'root');
            }, 1000);
        });

        it('should compare small vs large page sizes', () => {
            const items = Array.from({ length: 1000 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            
            // Small page size
            provider.benchEnableProgressiveLoading(50);
            benchmark('Progressive Loading - Page Size 50', () => {
                provider.benchApplyProgressiveLoading(items, 'root');
            }, 1000);
            
            // Large page size
            provider.benchEnableProgressiveLoading(500);
            benchmark('Progressive Loading - Page Size 500', () => {
                provider.benchApplyProgressiveLoading(items, 'root');
            }, 1000);
        });
    });

    describe('Filter Performance', () => {
        it('should benchmark filtering 100 items', () => {
            const items = Array.from({ length: 100 }, (_, i) => 
                new TestTreeItem(`nginx-prod-${i}`, `Pod ${i}`)
            );
            
            provider.benchSetFilter('nginx');
            
            benchmark('Filter - 100 items', () => {
                provider.benchApplyFilter(items);
            }, 1000);
        });

        it('should benchmark filtering 1000 items', () => {
            const items = Array.from({ length: 1000 }, (_, i) => 
                new TestTreeItem(`nginx-prod-${i}`, `Pod ${i}`)
            );
            
            provider.benchSetFilter('nginx');
            
            benchmark('Filter - 1000 items', () => {
                provider.benchApplyFilter(items);
            }, 1000);
        });

        it('should benchmark filtering 5000 items', () => {
            const items = Array.from({ length: 5000 }, (_, i) => 
                new TestTreeItem(`nginx-prod-${i}`, `Pod ${i}`)
            );
            
            provider.benchSetFilter('nginx');
            
            benchmark('Filter - 5000 items', () => {
                provider.benchApplyFilter(items);
            }, 100);
        });

        it('should benchmark filter with no matches', () => {
            const items = Array.from({ length: 1000 }, (_, i) => 
                new TestTreeItem(`nginx-prod-${i}`, `Pod ${i}`)
            );
            
            provider.benchSetFilter('nonexistent');
            
            benchmark('Filter - No matches in 1000 items', () => {
                provider.benchApplyFilter(items);
            }, 1000);
        });

        it('should benchmark filter with all matches', () => {
            const items = Array.from({ length: 1000 }, (_, i) => 
                new TestTreeItem(`nginx-prod-${i}`, `Pod ${i}`)
            );
            
            provider.benchSetFilter('nginx');
            
            benchmark('Filter - All matches in 1000 items', () => {
                provider.benchApplyFilter(items);
            }, 1000);
        });
    });

    describe('Combined Filter + Progressive Loading', () => {
        it('should benchmark filter then paginate (1000 items)', () => {
            const items = Array.from({ length: 1000 }, (_, i) => {
                const label = i < 500 ? `nginx-${i}` : `redis-${i}`;
                return new TestTreeItem(label);
            });
            
            provider.benchEnableProgressiveLoading(100);
            provider.benchSetFilter('nginx');
            
            benchmark('Filter + Progressive Loading - 1000 items', () => {
                const filtered = provider.benchApplyFilter(items);
                provider.benchApplyProgressiveLoading(filtered, 'root');
            }, 1000);
        });

        it('should benchmark filter then paginate (5000 items)', () => {
            const items = Array.from({ length: 5000 }, (_, i) => {
                const label = i < 2500 ? `nginx-${i}` : `redis-${i}`;
                return new TestTreeItem(label);
            });
            
            provider.benchEnableProgressiveLoading(100);
            provider.benchSetFilter('nginx');
            
            benchmark('Filter + Progressive Loading - 5000 items', () => {
                const filtered = provider.benchApplyFilter(items);
                provider.benchApplyProgressiveLoading(filtered, 'root');
            }, 100);
        });
    });

    describe('Memory Usage Comparison', () => {
        it('should measure memory for progressive loading vs full load', () => {
            const items = Array.from({ length: 5000 }, (_, i) => 
                new TestTreeItem(`item-${i}`, `Description ${i}`)
            );
            
            // Measure with progressive loading
            provider.benchEnableProgressiveLoading(100);
            const startMemProg = (performance as any).memory?.usedJSHeapSize || 0;
            const resultProg = provider.benchApplyProgressiveLoading(items, 'root');
            const endMemProg = (performance as any).memory?.usedJSHeapSize || 0;
            
            // Measure without progressive loading
            const provider2 = new BenchmarkProvider();
            const startMemFull = (performance as any).memory?.usedJSHeapSize || 0;
            const resultFull = provider2.benchApplyProgressiveLoading(items, 'root');
            const endMemFull = (performance as any).memory?.usedJSHeapSize || 0;
            
            console.log('\n💾 Memory Usage (5000 items):');
            console.log(`   Progressive (100/page): ${resultProg.length} items`);
            console.log(`   Full load: ${resultFull.length} items`);
            
            if ((performance as any).memory) {
                console.log(`   Memory delta (progressive): ${((endMemProg - startMemProg) / 1024 / 1024).toFixed(2)} MB`);
                console.log(`   Memory delta (full): ${((endMemFull - startMemFull) / 1024 / 1024).toFixed(2)} MB`);
            } else {
                console.log('   Memory tracking not available');
            }
            
            provider2.dispose();
        });
    });

    describe('Real-World Scenarios', () => {
        it('should benchmark typical pod list (200 items, filter, paginate)', () => {
            const items = Array.from({ length: 200 }, (_, i) => {
                const apps = ['nginx', 'redis', 'postgres', 'mysql', 'mongodb'];
                const app = apps[i % apps.length];
                return new TestTreeItem(`${app}-${i}`, `Running pod ${i}`);
            });
            
            provider.benchEnableProgressiveLoading(50);
            provider.benchSetFilter('nginx');
            
            benchmark('Real-World - 200 pods, filter nginx, page 50', () => {
                const filtered = provider.benchApplyFilter(items);
                provider.benchApplyProgressiveLoading(filtered, 'root');
            }, 1000);
        });

        it('should benchmark large cluster (1000 items, filter, paginate)', () => {
            const items = Array.from({ length: 1000 }, (_, i) => {
                const apps = ['nginx', 'redis', 'postgres', 'mysql', 'mongodb'];
                const envs = ['prod', 'staging', 'dev'];
                const app = apps[i % apps.length];
                const env = envs[i % envs.length];
                return new TestTreeItem(`${app}-${env}-${i}`, `Running pod in ${env}`);
            });
            
            provider.benchEnableProgressiveLoading(100);
            provider.benchSetFilter('prod');
            
            benchmark('Real-World - 1000 pods, filter prod, page 100', () => {
                const filtered = provider.benchApplyFilter(items);
                provider.benchApplyProgressiveLoading(filtered, 'root');
            }, 1000);
        });
    });

    describe('Async Operations', () => {
        it('should benchmark async getChildren with progressive loading', async () => {
            const items = Array.from({ length: 1000 }, (_, i) => 
                new TestTreeItem(`item-${i}`)
            );
            provider.items = items;
            provider.benchEnableProgressiveLoading(100);
            
            await benchmarkAsync('Async getChildren - 1000 items', async () => {
                await provider.getChildren();
            }, 100);
        });

        it('should benchmark async getChildren with filter + progressive loading', async () => {
            const items = Array.from({ length: 1000 }, (_, i) => {
                const label = i < 500 ? `nginx-${i}` : `redis-${i}`;
                return new TestTreeItem(label);
            });
            provider.items = items;
            provider.benchEnableProgressiveLoading(100);
            provider.benchSetFilter('nginx');
            
            await benchmarkAsync('Async getChildren - Filter + Progressive', async () => {
                await provider.getChildren();
            }, 100);
        });
    });

    afterAll(() => {
        console.log('\n' + '='.repeat(60));
        console.log('✅ Benchmarks Complete\n');
    });
});

/**
 * Summary expectations:
 * 
 * Progressive Loading (first page):
 * - 100 of 1000 items: < 1ms
 * - 1000 of 5000 items: < 5ms
 * - Without progressive loading (all 1000): ~10-50ms
 * 
 * Filter Performance:
 * - 100 items: < 0.5ms
 * - 1000 items: < 2ms
 * - 5000 items: < 10ms
 * 
 * Combined Filter + Progressive Loading:
 * - 1000 items: < 3ms
 * - 5000 items: < 15ms
 * 
 * Memory:
 * - Progressive loading (100/page): ~1-2MB for 5000 items
 * - Full load: ~10-20MB for 5000 items
 * - Reduction: ~80-90%
 */
