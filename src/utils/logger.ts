import * as vscode from 'vscode';

/**
 * Logger utility for Cluster Pilot extension
 * Provides structured logging with different severity levels
 */
export class Logger {
    private static instance: Logger;
    private outputChannel: vscode.OutputChannel;
    private verboseLogging: boolean = false;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Cluster Pilot');
        this.updateConfiguration();
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public updateConfiguration(): void {
        const config = vscode.workspace.getConfiguration('clusterPilot');
        this.verboseLogging = config.get<boolean>('enableVerboseLogging', false);
    }

    public debug(message: string, ...args: unknown[]): void {
        if (this.verboseLogging) {
            const formattedMessage = this.formatMessage('DEBUG', message, args);
            this.outputChannel.appendLine(formattedMessage);
        }
    }

    public info(message: string, ...args: unknown[]): void {
        const formattedMessage = this.formatMessage('INFO', message, args);
        this.outputChannel.appendLine(formattedMessage);
    }

    public warn(message: string, ...args: unknown[]): void {
        const formattedMessage = this.formatMessage('WARN', message, args);
        this.outputChannel.appendLine(formattedMessage);
    }

    public error(message: string, error?: unknown, ...args: unknown[]): void {
        const formattedMessage = this.formatMessage('ERROR', message, args);
        this.outputChannel.appendLine(formattedMessage);
        
        if (error instanceof Error) {
            this.outputChannel.appendLine(`  Stack: ${error.stack || error.message}`);
        } else if (error) {
            this.outputChannel.appendLine(`  Error: ${JSON.stringify(error)}`);
        }
    }

    public show(): void {
        this.outputChannel.show();
    }

    public dispose(): void {
        this.outputChannel.dispose();
    }

    private formatMessage(level: string, message: string, args: unknown[]): string {
        const timestamp = new Date().toISOString();
        const argsStr = args.length > 0 ? ` ${args.map(a => JSON.stringify(a)).join(' ')}` : '';
        return `[${timestamp}] [${level}] ${message}${argsStr}`;
    }
}

// Export singleton instance
export const logger = Logger.getInstance();
