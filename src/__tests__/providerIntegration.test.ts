import * as vscode from 'vscode';
import { ResourceProvider, ResourceCategory } from '../providers/resourceProvider';
import { NamespaceProvider } from '../providers/namespaceProvider';
import { NodeProvider } from '../providers/nodeProvider';
import * as k8s from '@kubernetes/client-node';

// Mock vscode
jest.mock('vscode', () => ({
    TreeItem: class {
        constructor(public label: string, public collapsibleState?: number) {
            this.id = label;
        }
        id?: string;
        contextValue?: string;
        description?: string;
        tooltip?: string;
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
    },
    window: {
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showWarningMessage: jest.fn()
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

// Mock K8sClient
const mockK8sClient = {
    getPods: jest.fn(),
    getDeployments: jest.fn(),
    getStatefulSets: jest.fn(),
    getDaemonSets: jest.fn(),
    getJobs: jest.fn(),
    getConfigMaps: jest.fn(),
    getSecrets: jest.fn(),
    getServices: jest.fn(),
    getIngresses: jest.fn(),
    getPersistentVolumes: jest.fn(),
    getPersistentVolumeClaims: jest.fn(),
    getStorageClasses: jest.fn(),
    getNamespaces: jest.fn(),
    getNodes: jest.fn()
};

describe('Provider Integration Tests', () => {
    describe('ResourceProvider', () => {
        let provider: ResourceProvider;

        beforeEach(() => {
            jest.clearAllMocks();
        });

        afterEach(() => {
            if (provider) {
                provider.dispose();
            }
        });

        describe('Workloads Category', () => {
            beforeEach(() => {
                provider = new ResourceProvider(mockK8sClient as any, 'workloads');
            });

            it('should return workload resource types', async () => {
                const children = await provider.getChildren();
                
                expect(children.length).toBe(5);
                expect(children[0].label).toBe('Pods');
                expect(children[1].label).toBe('Deployments');
                expect(children[2].label).toBe('StatefulSets');
                expect(children[3].label).toBe('DaemonSets');
                expect(children[4].label).toBe('Jobs');
            });

            it('should fetch pods when expanding Pods', async () => {
                const pods = [
                    {
                        metadata: { name: 'pod-1', namespace: 'default' },
                        status: { phase: 'Running' }
                    },
                    {
                        metadata: { name: 'pod-2', namespace: 'default' },
                        status: { phase: 'Pending' }
                    }
                ];
                mockK8sClient.getPods.mockResolvedValue(pods);

                const resourceTypes = await provider.getChildren();
                const podsType = resourceTypes.find(r => r.label === 'Pods');
                
                const podItems = await provider.getChildren(podsType);
                
                expect(mockK8sClient.getPods).toHaveBeenCalled();
                expect(podItems.length).toBeGreaterThan(0);
            });

            it('should apply namespace filter to pods', async () => {
                const pods = [
                    {
                        metadata: { name: 'pod-1', namespace: 'default' },
                        status: { phase: 'Running' }
                    }
                ];
                mockK8sClient.getPods.mockResolvedValue(pods);

                provider.setNamespaceFilter('default');
                
                const resourceTypes = await provider.getChildren();
                const podsType = resourceTypes.find(r => r.label === 'Pods');
                await provider.getChildren(podsType);
                
                expect(mockK8sClient.getPods).toHaveBeenCalledWith('default');
            });

            it('should integrate progressive loading with large pod lists', async () => {
                const pods = Array.from({ length: 150 }, (_, i) => ({
                    metadata: { name: `pod-${i}`, namespace: 'default' },
                    status: { phase: 'Running' }
                }));
                mockK8sClient.getPods.mockResolvedValue(pods);

                const resourceTypes = await provider.getChildren();
                const podsType = resourceTypes.find(r => r.label === 'Pods');
                
                const podItems = await provider.getChildren(podsType);
                
                // Should return 100 items + 1 "Load More" button
                expect(podItems.length).toBe(101);
                expect(podItems[100].contextValue).toBe('loadMore');
            });
        });

        describe('Config Category', () => {
            beforeEach(() => {
                provider = new ResourceProvider(mockK8sClient as any, 'config');
            });

            it('should return config resource types', async () => {
                const children = await provider.getChildren();
                
                expect(children.length).toBe(2);
                expect(children[0].label).toBe('ConfigMaps');
                expect(children[1].label).toBe('Secrets');
            });

            it('should fetch configmaps', async () => {
                const configMaps = [
                    {
                        metadata: { name: 'cm-1', namespace: 'default' }
                    }
                ];
                mockK8sClient.getConfigMaps.mockResolvedValue(configMaps);

                const resourceTypes = await provider.getChildren();
                const cmType = resourceTypes.find(r => r.label === 'ConfigMaps');
                
                const items = await provider.getChildren(cmType);
                
                expect(mockK8sClient.getConfigMaps).toHaveBeenCalled();
                expect(items.length).toBeGreaterThan(0);
            });
        });

        describe('Network Category', () => {
            beforeEach(() => {
                provider = new ResourceProvider(mockK8sClient as any, 'network');
            });

            it('should return network resource types', async () => {
                const children = await provider.getChildren();
                
                expect(children.length).toBe(2);
                expect(children[0].label).toBe('Services');
                expect(children[1].label).toBe('Ingresses');
            });

            it('should fetch services', async () => {
                const services = [
                    {
                        metadata: { name: 'svc-1', namespace: 'default' },
                        spec: { type: 'ClusterIP' }
                    }
                ];
                mockK8sClient.getServices.mockResolvedValue(services);

                const resourceTypes = await provider.getChildren();
                const svcType = resourceTypes.find(r => r.label === 'Services');
                
                const items = await provider.getChildren(svcType);
                
                expect(mockK8sClient.getServices).toHaveBeenCalled();
                expect(items.length).toBeGreaterThan(0);
            });
        });

        describe('Storage Category', () => {
            beforeEach(() => {
                provider = new ResourceProvider(mockK8sClient as any, 'storage');
            });

            it('should return storage resource types', async () => {
                const children = await provider.getChildren();
                
                expect(children.length).toBe(3);
                expect(children[0].label).toBe('PersistentVolumes');
                expect(children[1].label).toBe('PersistentVolumeClaims');
                expect(children[2].label).toBe('StorageClasses');
            });

            it('should fetch persistent volumes', async () => {
                const pvs = [
                    {
                        metadata: { name: 'pv-1' },
                        spec: { capacity: { storage: '10Gi' } }
                    }
                ];
                mockK8sClient.getPersistentVolumes.mockResolvedValue(pvs);

                const resourceTypes = await provider.getChildren();
                const pvType = resourceTypes.find(r => r.label === 'PersistentVolumes');
                
                const items = await provider.getChildren(pvType);
                
                expect(mockK8sClient.getPersistentVolumes).toHaveBeenCalled();
                expect(items.length).toBeGreaterThan(0);
            });
        });

        describe('Filter Integration', () => {
            beforeEach(() => {
                provider = new ResourceProvider(mockK8sClient as any, 'workloads');
            });

            it('should filter resources by search text', async () => {
                const pods = [
                    {
                        metadata: { name: 'nginx-prod-1', namespace: 'default' },
                        status: { phase: 'Running' }
                    },
                    {
                        metadata: { name: 'nginx-prod-2', namespace: 'default' },
                        status: { phase: 'Running' }
                    },
                    {
                        metadata: { name: 'redis-cache', namespace: 'default' },
                        status: { phase: 'Running' }
                    }
                ];
                mockK8sClient.getPods.mockResolvedValue(pods);

                // Apply filter
                (provider as any).setFilter('nginx');

                const resourceTypes = await provider.getChildren();
                const podsType = resourceTypes.find(r => r.label === 'Pods');
                const items = await provider.getChildren(podsType);
                
                // Should only return nginx pods
                expect(items.length).toBe(2);
            });
        });

        describe('Error Handling', () => {
            beforeEach(() => {
                provider = new ResourceProvider(mockK8sClient as any, 'workloads');
            });

            it('should handle API errors gracefully', async () => {
                mockK8sClient.getPods.mockRejectedValue(new Error('API Error'));

                const resourceTypes = await provider.getChildren();
                const podsType = resourceTypes.find(r => r.label === 'Pods');
                
                const items = await provider.getChildren(podsType);
                
                // Should return empty array on error
                expect(items).toEqual([]);
            });
        });
    });

    describe('NamespaceProvider', () => {
        let provider: NamespaceProvider;

        beforeEach(() => {
            jest.clearAllMocks();
            provider = new NamespaceProvider(mockK8sClient as any);
        });

        afterEach(() => {
            provider.dispose();
        });

        it('should fetch namespaces', async () => {
            const namespaces = [
                { metadata: { name: 'default' } },
                { metadata: { name: 'kube-system' } },
                { metadata: { name: 'production' } }
            ];
            mockK8sClient.getNamespaces.mockResolvedValue(namespaces);

            const items = await provider.getChildren();
            
            expect(mockK8sClient.getNamespaces).toHaveBeenCalled();
            expect(items.length).toBeGreaterThan(0);
        });

        it('should handle empty namespace list', async () => {
            mockK8sClient.getNamespaces.mockResolvedValue([]);

            const items = await provider.getChildren();
            
            expect(items.length).toBe(0);
        });
    });

    describe('NodeProvider', () => {
        let provider: NodeProvider;

        beforeEach(() => {
            jest.clearAllMocks();
            provider = new NodeProvider(mockK8sClient as any);
        });

        afterEach(() => {
            provider.dispose();
        });

        it('should fetch nodes', async () => {
            const nodes = [
                {
                    metadata: { name: 'node-1' },
                    status: {
                        conditions: [{ type: 'Ready', status: 'True' }]
                    }
                },
                {
                    metadata: { name: 'node-2' },
                    status: {
                        conditions: [{ type: 'Ready', status: 'True' }]
                    }
                }
            ];
            mockK8sClient.getNodes.mockResolvedValue(nodes);

            const items = await provider.getChildren();
            
            expect(mockK8sClient.getNodes).toHaveBeenCalled();
            expect(items.length).toBeGreaterThan(0);
        });

        it('should handle node fetch errors', async () => {
            mockK8sClient.getNodes.mockRejectedValue(new Error('Node API Error'));

            const items = await provider.getChildren();
            
            expect(items).toEqual([]);
        });
    });

    describe('Cross-Provider Integration', () => {
        it('should allow multiple providers to coexist', async () => {
            const workloadsProvider = new ResourceProvider(mockK8sClient as any, 'workloads');
            const namespaceProvider = new NamespaceProvider(mockK8sClient as any);
            const nodeProvider = new NodeProvider(mockK8sClient as any);

            mockK8sClient.getNamespaces.mockResolvedValue([
                { metadata: { name: 'default' } }
            ]);
            mockK8sClient.getNodes.mockResolvedValue([
                { metadata: { name: 'node-1' } }
            ]);

            const nsItems = await namespaceProvider.getChildren();
            const nodeItems = await nodeProvider.getChildren();
            const workloadTypes = await workloadsProvider.getChildren();

            expect(nsItems.length).toBeGreaterThan(0);
            expect(nodeItems.length).toBeGreaterThan(0);
            expect(workloadTypes.length).toBe(5);

            workloadsProvider.dispose();
            namespaceProvider.dispose();
            nodeProvider.dispose();
        });
    });
});
