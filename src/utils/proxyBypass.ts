import * as https from 'https';
import * as http from 'http';
import { logger } from './logger';
import { LOCAL_HOSTS, NETWORK } from './constants';

// Store original request functions
const originalHttpsRequest = https.request;
const originalHttpRequest = http.request;

interface RequestOptions {
    hostname?: string;
    host?: string;
    agent?: https.Agent | http.Agent;
    proxy?: unknown;
    rejectUnauthorized?: boolean;
    [key: string]: unknown;
}

function isLocalHost(hostname: string): boolean {
    return LOCAL_HOSTS.some(local => hostname.includes(local));
}

export function bypassProxyForLocalHosts(): void {
    logger.info('Setting up proxy bypass for local Kubernetes hosts only');
    
    try {
        // Patch HTTPS requests
        const httpsDescriptor = Object.getOwnPropertyDescriptor(https, 'request');
        if (httpsDescriptor && httpsDescriptor.configurable !== false) {
            Object.defineProperty(https, 'request', {
                value: function(options: string | URL | RequestOptions, callback?: (res: http.IncomingMessage) => void) {
                    let opts: RequestOptions;
                    if (typeof options === 'string') {
                        opts = new URL(options) as unknown as RequestOptions;
                    } else {
                        opts = options as RequestOptions;
                    }
                    
                    const hostname = opts.hostname || opts.host || '';
                    
                    if (isLocalHost(hostname as string)) {
                        // Only for local hosts: bypass proxy and optionally skip TLS verification
                        if (opts.agent === undefined) {
                            opts.agent = new https.Agent({
                                rejectUnauthorized: false, // Only for local dev clusters
                                keepAlive: true,
                                maxSockets: NETWORK.MAX_SOCKETS
                            });
                        }
                        delete opts.proxy;
                        logger.debug(`Bypassing proxy for local HTTPS request: ${hostname}`);
                    }
                    
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return (originalHttpsRequest as any)(opts, callback);
                },
                writable: true,
                configurable: true
            });
        }
        
        // Patch HTTP requests
        const httpDescriptor = Object.getOwnPropertyDescriptor(http, 'request');
        if (httpDescriptor && httpDescriptor.configurable !== false) {
            Object.defineProperty(http, 'request', {
                value: function(options: string | URL | RequestOptions, callback?: (res: http.IncomingMessage) => void) {
                    let opts: RequestOptions;
                    if (typeof options === 'string') {
                        opts = new URL(options) as unknown as RequestOptions;
                    } else {
                        opts = options as RequestOptions;
                    }
                    
                    const hostname = opts.hostname || opts.host || '';
                    
                    if (isLocalHost(hostname as string)) {
                        // Only for local hosts: bypass proxy
                        if (opts.agent === undefined) {
                            opts.agent = new http.Agent({
                                keepAlive: true,
                                maxSockets: NETWORK.MAX_SOCKETS
                            });
                        }
                        delete opts.proxy;
                        logger.debug(`Bypassing proxy for local HTTP request: ${hostname}`);
                    }
                    
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return (originalHttpRequest as any)(opts, callback);
                },
                writable: true,
                configurable: true
            });
        }
        
        logger.info('Proxy bypass configured successfully for local hosts');
    } catch (error) {
        logger.warn('Could not patch HTTP modules, proxy bypass may not work', error);
    }
}
