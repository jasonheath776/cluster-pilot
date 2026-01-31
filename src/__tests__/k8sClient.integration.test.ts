import { K8sClient } from '../utils/k8sClient';
import { KubeconfigManager } from '../utils/kubeconfig';
import * as k8s from '@kubernetes/client-node';

// Mock kubeconfig manager
jest.mock('../utils/kubeconfig', () => ({
    KubeconfigManager: jest.fn().mockImplementation(() => ({
        getKubeConfig: jest.fn()
    }))
}));

// Mock logger
jest.mock('../utils/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));

// Mock retry utility
jest.mock('../utils/retry', () => ({
    withRetry: jest.fn((fn) => fn())
}));

// Mock domain clients
jest.mock('../utils/clients', () => ({
    WorkloadClient: jest.fn().mockImplementation(() => ({
        getPods: jest.fn().mockResolvedValue([]),
        getDeployment: jest.fn().mockResolvedValue(null)
    })),
    NetworkClient: jest.fn().mockImplementation(() => ({
        getServices: jest.fn().mockResolvedValue([])
    })),
    StorageClient: jest.fn().mockImplementation(() => ({
        getPersistentVolumes: jest.fn().mockResolvedValue([])
    })),
    ConfigClient: jest.fn().mockImplementation(() => ({
        getConfigMaps: jest.fn().mockResolvedValue([])
    })),
    RBACClient: jest.fn().mockImplementation(() => ({
        getRoles: jest.fn().mockResolvedValue([])
    })),
    ClusterClient: jest.fn().mockImplementation(() => ({
        getNodes: jest.fn().mockResolvedValue([])
    }))
}));

describe('K8sClient integration tests', () => {
    let k8sClient: K8sClient;
    let mockKubeconfigManager: any;
    let mockKubeConfig: any;

    beforeEach(() => {
        jest.clearAllMocks();
        
        mockKubeConfig = {
            makeApiClient: jest.fn((ApiType) => {
                const mockApi = {};
                return mockApi;
            })
        };
        
        mockKubeconfigManager = new KubeconfigManager();
        mockKubeconfigManager.getKubeConfig.mockReturnValue(mockKubeConfig);
        
        k8sClient = new K8sClient(mockKubeconfigManager);
    });

    describe('initialization', () => {
        it('should initialize with kubeconfig manager', () => {
            expect(k8sClient).toBeDefined();
            expect(mockKubeconfigManager.getKubeConfig).toHaveBeenCalled();
        });

        it('should initialize domain clients', () => {
            expect(k8sClient.workloads).toBeDefined();
            expect(k8sClient.network).toBeDefined();
            expect(k8sClient.storage).toBeDefined();
            expect(k8sClient.config).toBeDefined();
            expect(k8sClient.rbac).toBeDefined();
            expect(k8sClient.cluster).toBeDefined();
        });

        it('should create API clients', () => {
            expect(mockKubeConfig.makeApiClient).toHaveBeenCalled();
        });
    });

    describe('workload operations', () => {
        it('should list pods through workload client', async () => {
            const pods = await k8sClient.workloads.getPods('default');
            expect(k8sClient.workloads.getPods).toHaveBeenCalledWith('default');
            expect(pods).toBeDefined();
        });

        it('should get deployment through workload client', async () => {
            const deployment = await k8sClient.workloads.getDeployment('default', 'my-app');
            expect(k8sClient.workloads.getDeployment).toHaveBeenCalledWith('default', 'my-app');
            expect(deployment).toBeDefined();
        });
    });

    describe('network operations', () => {
        it('should list services through network client', async () => {
            const services = await k8sClient.network.getServices('default');
            expect(k8sClient.network.getServices).toHaveBeenCalledWith('default');
            expect(services).toBeDefined();
        });
    });

    describe('storage operations', () => {
        it('should list persistent volumes through storage client', async () => {
            const pvs = await k8sClient.storage.getPersistentVolumes();
            expect(k8sClient.storage.getPersistentVolumes).toHaveBeenCalled();
            expect(pvs).toBeDefined();
        });
    });

    describe('config operations', () => {
        it('should list config maps through config client', async () => {
            const configMaps = await k8sClient.config.getConfigMaps('default');
            expect(k8sClient.config.getConfigMaps).toHaveBeenCalledWith('default');
            expect(configMaps).toBeDefined();
        });
    });

    describe('RBAC operations', () => {
        it('should list roles through RBAC client', async () => {
            const roles = await k8sClient.rbac.getRoles('default');
            expect(k8sClient.rbac.getRoles).toHaveBeenCalledWith('default');
            expect(roles).toBeDefined();
        });
    });

    describe('cluster operations', () => {
        it('should retrieve nodes through cluster client', async () => {
            const info = await k8sClient.cluster.getNodes();
            expect(k8sClient.cluster.getNodes).toHaveBeenCalled();
            expect(info).toBeDefined();
        });
    });

    describe('error handling', () => {
        it('should initialize without throwing errors', () => {
            expect(k8sClient).toBeDefined();
            expect(k8sClient.workloads).toBeDefined();
            expect(k8sClient.cluster).toBeDefined();
        });
    });

    describe('multi-client orchestration', () => {
        it('should allow querying multiple clients in sequence', async () => {
            await k8sClient.workloads.getPods('default');
            await k8sClient.network.getServices('default');
            await k8sClient.storage.getPersistentVolumes();
            
            expect(k8sClient.workloads.getPods).toHaveBeenCalled();
            expect(k8sClient.network.getServices).toHaveBeenCalled();
            expect(k8sClient.storage.getPersistentVolumes).toHaveBeenCalled();
        });

        it('should allow parallel client operations', async () => {
            const operations = Promise.all([
                k8sClient.workloads.getPods('default'),
                k8sClient.network.getServices('default'),
                k8sClient.config.getConfigMaps('default')
            ]);
            
            const results = await operations;
            expect(results).toHaveLength(3);
            expect(results[0]).toBeDefined();
            expect(results[1]).toBeDefined();
            expect(results[2]).toBeDefined();
        });
    });
});
