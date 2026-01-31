import * as k8s from '@kubernetes/client-node';
import { logger } from './logger';

/**
 * Watch event types from Kubernetes
 */
export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR';

/**
 * Watch event from Kubernetes
 */
export interface WatchEvent<T> {
    type: WatchEventType;
    object: T;
}

/**
 * Watch callback function
 */
export type WatchCallback<T> = (event: WatchEvent<T>) => void;

/**
 * Watch error callback
 */
export type WatchErrorCallback = (error: any) => void;

/**
 * Watch options
 */
export interface WatchOptions {
    /**
     * Resource version to start watching from
     */
    resourceVersion?: string;
    
    /**
     * Timeout in seconds for the watch stream
     */
    timeoutSeconds?: number;
    
    /**
     * Label selector to filter resources
     */
    labelSelector?: string;
    
    /**
     * Field selector to filter resources
     */
    fieldSelector?: string;
    
    /**
     * Whether to automatically reconnect on errors
     */
    autoReconnect?: boolean;
    
    /**
     * Reconnect delay in milliseconds
     */
    reconnectDelayMs?: number;
}

/**
 * Kubernetes Watch API wrapper with automatic reconnection
 */
export class K8sWatch<T = any> {
    private watch: k8s.Watch;
    private abortController?: AbortController;
    private isActive = false;
    private reconnectTimeout?: NodeJS.Timeout;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;

    constructor(private kc: k8s.KubeConfig) {
        this.watch = new k8s.Watch(kc);
    }

    /**
     * Start watching a Kubernetes resource
     * @param path API path to watch (e.g., '/api/v1/namespaces/default/pods')
     * @param onEvent Callback for watch events
     * @param onError Callback for errors
     * @param options Watch options
     */
    public async start(
        path: string,
        onEvent: WatchCallback<T>,
        onError?: WatchErrorCallback,
        options: WatchOptions = {}
    ): Promise<void> {
        if (this.isActive) {
            logger.warn('Watch already active, stopping previous watch');
            this.stop();
        }

        this.isActive = true;
        this.reconnectAttempts = 0;

        await this.startWatch(path, onEvent, onError, options);
    }

    /**
     * Internal method to start the watch stream
     */
    private async startWatch(
        path: string,
        onEvent: WatchCallback<T>,
        onError: WatchErrorCallback | undefined,
        options: WatchOptions
    ): Promise<void> {
        try {
            // Build query parameters
            const queryParams = new URLSearchParams();
            if (options.resourceVersion) {
                queryParams.append('resourceVersion', options.resourceVersion);
            }
            if (options.timeoutSeconds) {
                queryParams.append('timeoutSeconds', options.timeoutSeconds.toString());
            }
            if (options.labelSelector) {
                queryParams.append('labelSelector', options.labelSelector);
            }
            if (options.fieldSelector) {
                queryParams.append('fieldSelector', options.fieldSelector);
            }

            const queryString = queryParams.toString();
            const watchPath = queryString ? `${path}?${queryString}` : path;

            this.abortController = new AbortController();

            logger.debug(`Starting watch on ${watchPath}`);

            const req = await this.watch.watch(
                watchPath,
                {},
                (type: string, apiObj: any, watchObj?: any) => {
                    if (!this.isActive) {
                        return;
                    }

                    const event: WatchEvent<T> = {
                        type: type as WatchEventType,
                        object: apiObj as T
                    };

                    onEvent(event);
                },
                (err: any) => {
                    if (!this.isActive) {
                        return;
                    }

                    logger.error('Watch error', err);

                    if (onError) {
                        onError(err);
                    }

                    // Handle reconnection
                    if (options.autoReconnect !== false && this.shouldReconnect(err)) {
                        this.scheduleReconnect(path, onEvent, onError, options);
                    } else {
                        this.isActive = false;
                    }
                }
            );

            // Store abort function
            if (req && typeof req.abort === 'function') {
                this.abortController.signal.addEventListener('abort', () => {
                    req.abort();
                });
            }
        } catch (error) {
            logger.error('Failed to start watch', error);
            
            if (onError) {
                onError(error);
            }

            if (options.autoReconnect !== false && this.shouldReconnect(error)) {
                this.scheduleReconnect(path, onEvent, onError, options);
            } else {
                this.isActive = false;
            }
        }
    }

    /**
     * Check if we should attempt to reconnect
     */
    private shouldReconnect(error: any): boolean {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.error(`Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
            return false;
        }

        // Don't reconnect on certain errors
        if (error?.response?.statusCode === 401 || error?.response?.statusCode === 403) {
            logger.error('Authentication/authorization error, not reconnecting');
            return false;
        }

        return true;
    }

    /**
     * Schedule a reconnection attempt
     */
    private scheduleReconnect(
        path: string,
        onEvent: WatchCallback<T>,
        onError: WatchErrorCallback | undefined,
        options: WatchOptions
    ): void {
        this.reconnectAttempts++;
        const delay = options.reconnectDelayMs || 1000 * Math.min(this.reconnectAttempts, 5);

        logger.info(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

        this.reconnectTimeout = setTimeout(() => {
            if (this.isActive) {
                this.startWatch(path, onEvent, onError, options);
            }
        }, delay);
    }

    /**
     * Stop watching
     */
    public stop(): void {
        this.isActive = false;

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
        }

        logger.debug('Watch stopped');
    }

    /**
     * Check if watch is active
     */
    public isWatching(): boolean {
        return this.isActive;
    }
}

/**
 * Helper to create watch paths for common resources
 */
export const WatchPaths = {
    pods: (namespace?: string) => 
        namespace ? `/api/v1/namespaces/${namespace}/pods` : '/api/v1/pods',
    
    deployments: (namespace?: string) =>
        namespace ? `/apis/apps/v1/namespaces/${namespace}/deployments` : '/apis/apps/v1/deployments',
    
    services: (namespace?: string) =>
        namespace ? `/api/v1/namespaces/${namespace}/services` : '/api/v1/services',
    
    namespaces: () => '/api/v1/namespaces',
    
    nodes: () => '/api/v1/nodes',
    
    events: (namespace?: string) =>
        namespace ? `/api/v1/namespaces/${namespace}/events` : '/api/v1/events',
    
    configmaps: (namespace?: string) =>
        namespace ? `/api/v1/namespaces/${namespace}/configmaps` : '/api/v1/configmaps',
    
    secrets: (namespace?: string) =>
        namespace ? `/api/v1/namespaces/${namespace}/secrets` : '/api/v1/secrets'
};
