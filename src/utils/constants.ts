/**
 * Configuration constants for Cluster Pilot extension
 * Centralized location for all magic numbers and configuration values
 */

// Network and API Configuration
export const NETWORK = {
    /** Maximum buffer size for helm operations (10MB) */
    MAX_BUFFER_SIZE: 10 * 1024 * 1024,
    
    /** Maximum number of sockets for HTTP agents */
    MAX_SOCKETS: 10,
    
    /** Default request timeout in milliseconds */
    REQUEST_TIMEOUT: 30000,
    
    /** Connection retry attempts */
    MAX_RETRIES: 3,
    
    /** Delay between retries in milliseconds */
    RETRY_DELAY: 1000,
} as const;

// Refresh and Polling Configuration
export const REFRESH = {
    /** Default auto-refresh interval in milliseconds */
    DEFAULT_INTERVAL: 5000,
    
    /** Minimum refresh interval in milliseconds */
    MIN_INTERVAL: 1000,
    
    /** Maximum refresh interval in milliseconds */
    MAX_INTERVAL: 60000,
    
    /** Connection test delay after activation */
    CONNECTION_TEST_DELAY: 2000,
} as const;

// Resource Limits
export const LIMITS = {
    /** Maximum number of log lines to fetch */
    MAX_LOG_LINES: 10000,
    
    /** Default number of log lines to fetch */
    DEFAULT_LOG_LINES: 1000,
    
    /** Minimum number of log lines */
    MIN_LOG_LINES: 100,
    
    /** Maximum number of events to display */
    MAX_EVENTS: 10,
    
    /** Port range for port forwarding */
    PORT_RANGE_START: 8080,
    PORT_RANGE_END: 8180,
} as const;

// File and Path Configuration
export const PATHS = {
    /** Default kubeconfig path */
    DEFAULT_KUBECONFIG: '~/.kube/config',
    
    /** Default backup directory */
    DEFAULT_BACKUP_DIR: '~/.jas-cluster-pilot/backups',
    
    /** Temp directory prefix for helm values */
    HELM_TEMP_PREFIX: 'helm-values-',
} as const;

// Local Host Patterns
export const LOCAL_HOSTS = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    'kubernetes.docker.internal',
    'host.docker.internal',
    '::1',
] as const;

// Validation Patterns
export const PATTERNS = {
    /** Kubernetes resource name pattern */
    RESOURCE_NAME: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/,
    
    /** DNS label pattern for namespaces */
    DNS_LABEL: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    
    /** Dangerous shell characters */
    DANGEROUS_CHARS: /[;&|`$(){}[\]<>\\'"]/,
    
    /** Shell injection patterns - matches dangerous shell metacharacters */
    SHELL_INJECTION: /[;&|$()<>\n]/,
    
    /** Safe string pattern */
    SAFE_STRING: /^[a-zA-Z0-9\s.,;:!?@#%^&*()\-_=+[\]{}|<>\/~`'"]+$/,
} as const;

// Resource Name Length Limits (Kubernetes Standards)
export const NAME_LIMITS = {
    /** Maximum length for resource names */
    MAX_RESOURCE_NAME: 253,
    
    /** Maximum length for namespace names */
    MAX_NAMESPACE_NAME: 63,
    
    /** Maximum length for label keys */
    MAX_LABEL_KEY: 253,
    
    /** Maximum length for label values */
    MAX_LABEL_VALUE: 63,
} as const;

// Health Monitor Thresholds
export const HEALTH_THRESHOLDS = {
    /** CPU usage warning threshold (percentage) */
    CPU_WARNING: 70,
    
    /** CPU usage critical threshold (percentage) */
    CPU_CRITICAL: 90,
    
    /** Memory usage warning threshold (percentage) */
    MEMORY_WARNING: 80,
    
    /** Memory usage critical threshold (percentage) */
    MEMORY_CRITICAL: 95,
    
    /** Pod restart warning threshold */
    POD_RESTART_WARNING: 3,
    
    /** Pod restart critical threshold */
    POD_RESTART_CRITICAL: 10,
} as const;

// Shell Commands
export const SHELLS = {
    /** Available shell options for pod exec */
    OPTIONS: [
        { label: '/bin/bash', description: 'Bash shell' },
        { label: '/bin/sh', description: 'Bourne shell' },
        { label: '/bin/zsh', description: 'Z shell' },
    ],
    
    /** Default shell */
    DEFAULT: '/bin/sh',
} as const;

// Port Configuration
export const PORTS = {
    /** Minimum valid port number */
    MIN: 1,
    
    /** Maximum valid port number */
    MAX: 65535,
    
    /** Common privileged port boundary */
    PRIVILEGED_MAX: 1024,
} as const;

// Cache Configuration
export const CACHE = {
    /** Default TTL for cached resources in milliseconds (30 seconds) */
    DEFAULT_TTL: 30000,
    
    /** Maximum cache size (number of entries) */
    MAX_SIZE: 1000,
    
    /** Cleanup interval for expired cache entries in milliseconds (60 seconds) */
    CLEANUP_INTERVAL: 60000,
} as const;

// Debouncing Configuration
export const DEBOUNCE = {
    /** Default debounce wait time for refresh operations in milliseconds */
    DEFAULT_WAIT: 300,
    
    /** Debounce wait time for search operations in milliseconds */
    SEARCH_WAIT: 500,
    
    /** Debounce wait time for resize operations in milliseconds */
    RESIZE_WAIT: 250,
    
    /** Throttle interval for high-frequency operations in milliseconds */
    THROTTLE_INTERVAL: 1000,
} as const;

// Watch API Configuration
export const WATCH = {
    /** Default timeout for watch requests in seconds */
    DEFAULT_TIMEOUT: 600,
    
    /** Maximum reconnect attempts for watch connections */
    MAX_RECONNECT_ATTEMPTS: 5,
    
    /** Initial backoff delay for watch reconnection in milliseconds */
    INITIAL_BACKOFF: 1000,
    
    /** Maximum backoff delay for watch reconnection in milliseconds */
    MAX_BACKOFF: 30000,
    
    /** Backoff multiplier for exponential backoff */
    BACKOFF_MULTIPLIER: 2,
} as const;

// Extension Metadata
export const EXTENSION = {
    /** Extension ID */
    ID: 'jas-cluster-pilot',
    
    /** Display name */
    DISPLAY_NAME: 'Cluster Pilot',
    
    /** Output channel name */
    OUTPUT_CHANNEL: 'Cluster Pilot',
    
    /** Configuration section */
    CONFIG_SECTION: 'clusterPilot',
} as const;

// Configuration Keys
export const CONFIG_KEYS = {
    KUBECONFIG_PATH: 'kubeconfigPath',
    REFRESH_INTERVAL: 'refreshInterval',
    ENABLE_METRICS: 'enableMetrics',
    LOG_LINES: 'logLines',
    BACKUP_DIRECTORY: 'backupDirectory',
    VERBOSE_LOGGING: 'enableVerboseLogging',
    BYPASS_PROXY: 'bypassProxyForLocalConnections',
} as const;
