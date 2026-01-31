import { Logger } from '../utils/logger';

// Mock vscode module
const mockOutputChannel = {
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn()
};

const mockWorkspaceConfig = {
    get: jest.fn()
};

jest.mock('vscode', () => ({
    window: {
        createOutputChannel: jest.fn(() => mockOutputChannel)
    },
    workspace: {
        getConfiguration: jest.fn(() => mockWorkspaceConfig)
    }
}), { virtual: true });
// Import logger singleton after mocks
import { logger } from '../utils/logger';
describe('Logger', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockWorkspaceConfig.get.mockReturnValue(false); // verbose = false by default
    });

    describe('initialization', () => {
        it('should create output channel on first use', () => {
            logger.info('test message');
            expect(mockOutputChannel.appendLine).toHaveBeenCalled();
        });
    });

    describe('debug', () => {
        it('should not log debug messages when verbose is false', () => {
            mockWorkspaceConfig.get.mockReturnValue(false);
            logger.updateConfiguration();
            
            logger.debug('debug message');
            
            expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
        });

        it('should log debug messages when verbose is true', () => {
            mockWorkspaceConfig.get.mockReturnValue(true);
            logger.updateConfiguration();
            
            logger.debug('debug message');
            
            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('[DEBUG] debug message')
            );
        });

        it('should include context in debug logs', () => {
            mockWorkspaceConfig.get.mockReturnValue(true);
            logger.updateConfiguration();
            
            logger.debug('message', { key: 'value' });
            
            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('{"key":"value"}')
            );
        });
    });

    describe('info', () => {
        it('should always log info messages', () => {
            logger.info('info message');
            
            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('[INFO] info message')
            );
        });

        it('should format timestamps correctly', () => {
            logger.info('test');
            
            const call = mockOutputChannel.appendLine.mock.calls[0][0];
            // Check for ISO timestamp format like [2026-01-30T14:30:00.000Z]
            expect(call).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
        });
    });

    describe('warn', () => {
        it('should log warning messages', () => {
            logger.warn('warning message');
            
            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('[WARN] warning message')
            );
        });

        it('should include context in warnings', () => {
            logger.warn('warning', { code: 'WARN_001' });
            
            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('{"code":"WARN_001"}')
            );
        });
    });

    describe('error', () => {
        it('should log error messages', () => {
            logger.error('error message');
            
            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('[ERROR] error message')
            );
        });

        it('should handle Error objects', () => {
            const error = new Error('Test error');
            error.stack = 'Error: Test error\\n    at test.ts:10:15';
            
            logger.error('operation failed', error);
            
            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('Test error')
            );
        });

        it('should handle errors with stack traces in verbose mode', () => {
            mockWorkspaceConfig.get.mockReturnValue(true);
            logger.updateConfiguration();
            
            const error = new Error('Test error');
            error.stack = 'Error: Test error\\n    at test.ts:10:15';
            
            logger.error('operation failed', error);
            
            const calls = mockOutputChannel.appendLine.mock.calls;
            const output = calls.map(call => call[0]).join('\\n');
            
            expect(output).toContain('Error: Test error');
        });

        it('should handle non-Error objects', () => {
            logger.error('failed', { statusCode: 500, message: 'Server error' });
            
            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('"statusCode":500')
            );
        });
    });

    describe('updateConfiguration', () => {
        it('should update verbose setting from configuration', () => {
            mockWorkspaceConfig.get.mockReturnValue(true);
            logger.updateConfiguration();
            
            logger.debug('should appear');
            
            expect(mockOutputChannel.appendLine).toHaveBeenCalled();
        });

        it('should disable debug logging when verbose is false', () => {
            mockWorkspaceConfig.get.mockReturnValue(true);
            logger.updateConfiguration();
            logger.debug('message 1');
            
            jest.clearAllMocks();
            
            mockWorkspaceConfig.get.mockReturnValue(false);
            logger.updateConfiguration();
            logger.debug('message 2');
            
            expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
        });
    });

    describe('show', () => {
        it('should show the output channel', () => {
            logger.show();
            
            expect(mockOutputChannel.show).toHaveBeenCalled();
        });
    });

    describe('formatting', () => {
        it('should properly format objects', () => {
            logger.info('data', { name: 'test', count: 5, nested: { key: 'value' } });
            
            const call = mockOutputChannel.appendLine.mock.calls[0][0];
            expect(call).toContain('"name":"test"');
            expect(call).toContain('"count":5');
            expect(call).toContain('"nested":{"key":"value"}');
        });

        it('should handle undefined and null context', () => {
            logger.info('message', undefined);
            logger.info('message', null);
            
            expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(2);
        });
    });
});
