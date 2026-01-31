import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Safely disposes of a single disposable resource
 * Catches and logs any errors during disposal
 */
export function safeDispose(disposable: vscode.Disposable | undefined, context?: string): void {
    if (!disposable) {
        return;
    }

    try {
        disposable.dispose();
    } catch (error) {
        logger.error(`Error disposing ${context || 'resource'}`, error);
    }
}

/**
 * Safely disposes of an array of disposable resources
 * Continues disposal even if individual items throw errors
 */
export function safeDisposeAll(disposables: vscode.Disposable[], context?: string): void {
    for (const disposable of disposables) {
        safeDispose(disposable, context);
    }
}

/**
 * Safely clears an interval timer
 */
export function safeClearInterval(intervalId: NodeJS.Timeout | undefined, context?: string): void {
    if (!intervalId) {
        return;
    }

    try {
        clearInterval(intervalId);
    } catch (error) {
        logger.error(`Error clearing interval ${context || ''}`, error);
    }
}

/**
 * Safely clears a timeout timer
 */
export function safeClearTimeout(timeoutId: NodeJS.Timeout | undefined, context?: string): void {
    if (!timeoutId) {
        return;
    }

    try {
        clearTimeout(timeoutId);
    } catch (error) {
        logger.error(`Error clearing timeout ${context || ''}`, error);
    }
}

/**
 * Base class for panels that provides safe resource cleanup
 */
export abstract class DisposablePanel {
    protected disposables: vscode.Disposable[] = [];
    protected refreshInterval?: NodeJS.Timeout;

    /**
     * Safely disposes of all resources
     * Override this method in subclasses to add custom cleanup logic
     */
    public dispose(): void {
        // Clear timers first
        safeClearInterval(this.refreshInterval, 'refresh interval');
        this.refreshInterval = undefined;

        // Dispose all registered disposables
        safeDisposeAll(this.disposables, 'panel disposables');
        this.disposables = [];
    }

    /**
     * Registers a disposable for automatic cleanup
     */
    protected registerDisposable(disposable: vscode.Disposable): void {
        this.disposables.push(disposable);
    }

    /**
     * Sets up auto-refresh with safe cleanup
     */
    protected setupAutoRefresh(callback: () => void | Promise<void>, interval: number): void {
        // Clear existing interval if any
        safeClearInterval(this.refreshInterval);

        this.refreshInterval = setInterval(async () => {
            try {
                await callback();
            } catch (error) {
                logger.error('Auto-refresh failed', error);
            }
        }, interval);
    }

    /**
     * Stops auto-refresh
     */
    protected stopAutoRefresh(): void {
        safeClearInterval(this.refreshInterval, 'auto-refresh');
        this.refreshInterval = undefined;
    }
}
