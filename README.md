# Cluster Pilot

A comprehensive Kubernetes management extension for Visual Studio Code, providing an intuitive interface for cluster operations, resource management, and monitoring.

> **Version**: 0.1.0 (Early Release/Beta)  
> **Status**: Actively developed - suitable for development/testing on non-critical clusters  
> **Support**: Community-driven; report issues on [GitHub](https://github.com/jasonheath776/cluster-pilot/issues)

## ⚠️ Disclaimer

**This extension is provided "as-is" without warranties of any kind.** While thoroughly tested, users should:
- Test thoroughly in non-production environments first
- Maintain regular backups of critical cluster configurations
- Verify all operations before applying to production clusters
- Use caution with delete operations (they are immediate and irreversible)
- Monitor cluster health independently

The developers are not liable for any data loss, cluster downtime, or other issues arising from use of this extension.

## ⚠️ Beta Release Information

This is an **early release** (v0.1.0) with core Kubernetes functionality. While tested and stable, it is not yet recommended for production use on critical clusters.

### Known Limitations

- **Real-time features** (logs, events): May have reconnection issues under heavy load
- **Large clusters** (1000+ nodes): Performance not yet optimized for very large deployments  
- **Watch API**: Occasional edge cases in real-time sync during network interruptions
- **Test coverage**: Integration tests in development; focus on utilities tested

### What Works Well

✅ Basic resource management (CRUD operations)  
✅ Multi-cluster support with context switching  
✅ YAML editing with validation and safety checks  
✅ Pod logs and container shell access  
✅ Port forwarding  
✅ Helm management  
✅ Backup/restore functionality  

### Recommended Use Cases

- 🟢 Development and staging clusters
- 🟢 Learning and exploration  
- 🟢 Small production clusters with monitoring
- 🔴 NOT recommended: Mission-critical production without parallel monitoring

## Features

### Core Functionality

#### Multi-Cluster Management
- Connect and manage multiple Kubernetes clusters simultaneously
- Switch contexts seamlessly from the sidebar
- Automatic cluster detection from `~/.kube/config`
- Support for custom kubeconfig paths

#### Resource Management
- **Workloads**: Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, ReplicaSets
- **Configuration**: ConfigMaps, Secrets, ServiceAccounts
- **Network**: Services, Ingresses, Endpoints, NetworkPolicies
- **Storage**: PersistentVolumes, PersistentVolumeClaims, StorageClasses
- **RBAC**: Roles, ClusterRoles, RoleBindings, ClusterRoleBindings
- **Cluster**: Nodes, Namespaces, Events, ResourceQuotas, LimitRanges
- **Custom Resources**: Full CRD support with instance management

#### Live Operations
- **Real-time Logs**: Stream pod logs with container selection and tail options
- **Shell Access**: Execute commands directly in running containers
- **Port Forwarding**: Forward ports from pods/services to localhost with visual management
- **Resource Metrics**: Live CPU and memory usage (requires metrics-server)
- **Event Streaming**: Real-time Kubernetes event monitoring with filtering

#### Advanced Features
- **Helm Manager**: Complete Helm release lifecycle management
  - **⚠️ Requires**: Helm CLI installed and accessible in PATH
  - View, install, upgrade, rollback, and uninstall releases
  - Repository management
  - Visual dashboard with statistics
- **Security Scanning**: Comprehensive vulnerability analysis with Trivy integration
- **Backup & Restore**: Full cluster state backup and restoration capabilities
- **YAML Editor**: Create and edit resources with real-time validation
- **kubectl Terminal**: Integrated terminal with context awareness and quick commands
- **CRD Manager**: Visual Custom Resource Definition management
- **Policy Enforcement**: OPA/Gatekeeper admission control (Enterprise)
- **Audit Log Viewer**: Kubernetes audit log streaming (Enterprise)

#### Developer-Friendly
- YAML validation and syntax highlighting
- Resource templates for quick creation
- Inline diagnostics and error highlighting
- Dry-run validation before applying changes
- Export resources to YAML/JSON

## Requirements

- Visual Studio Code 1.80.0 or higher
- kubectl installed and configured
- Access to a Kubernetes cluster
- **Optional**: Helm CLI (required for Helm Manager panel)
- **Optional**: Trivy (required for image vulnerability scanning)
- **Optional**: metrics-server (required for resource metrics)

## Getting Started

1. Install the extension
2. Open the Cluster Pilot sidebar view
3. Your clusters from `~/.kube/config` will be automatically loaded
4. Select a context to explore your cluster resources

## Configuration

- `clusterPilot.kubeconfigPath`: Path to your kubeconfig file (default: `~/.kube/config`)
- `clusterPilot.refreshInterval`: Auto-refresh interval in milliseconds (default: 5000)
- `clusterPilot.enableMetrics`: Enable metrics collection (default: true)
- `clusterPilot.logLines`: Number of log lines to fetch (default: 1000)
- `clusterPilot.backupDirectory`: Directory to store cluster backups (default: `~/.jas-cluster-pilot/backups`)

## Commands

- `Cluster Pilot: Add Cluster` - Add a new cluster connection
- `Cluster Pilot: Switch Context` - Switch between cluster contexts
- `Cluster Pilot: Show Metrics Dashboard` - Open the metrics dashboard
- `Cluster Pilot: Refresh` - Refresh all views
- `Cluster Pilot: CRD Manager` - Manage Custom Resource Definitions
- `Cluster Pilot: Event Stream Viewer` - View live Kubernetes events
- `Cluster Pilot: Helm Manager` - Manage Helm releases and repositories
- `Cluster Pilot: Port Forward Manager` - Manage port forwards
- `Cluster Pilot: Open kubectl Terminal` - Open integrated kubectl terminal (Ctrl+Shift+K)
- `Cluster Pilot: kubectl Quick Commands` - Quick access to common kubectl commands (Ctrl+Shift+Alt+K)
- `Cluster Pilot: Create Kubernetes Resource` - Create new resource from template (Ctrl+Shift+N)
- `Cluster Pilot: Backup & Restore Manager` - Manage cluster backups and restorations
- `Cluster Pilot: Security Scanning` - Comprehensive security analysis
- `Cluster Pilot: View Audit Logs` - Kubernetes audit log viewer (Enterprise)
- `Cluster Pilot: Policy Enforcement (OPA/Gatekeeper)` - Admission control policies (Enterprise)

## Usage

### Viewing Resources

Navigate through your cluster resources using the sidebar:
- **Clusters**: Manage cluster contexts
- **Workloads**: Pods, Deployments, StatefulSets, DaemonSets, Jobs
- **Configuration**: ConfigMaps, Secrets
- **Network**: Services, Ingresses
- **Storage**: PersistentVolumes, PersistentVolumeClaims, StorageClasses

### Metrics Dashboard

Access real-time cluster metrics:
- Navigate to **View → Command Palette** → `Cluster Pilot: Show Metrics Dashboard`
- View cluster-wide metrics including:
  - Node count and status
  - Pod counts across namespaces
  - Total deployments and services
  - CPU and memory usage with visual progress bars
  - Per-node resource consumption
  - Top pods by resource usage

**Note**: Metrics require `metrics-server` to be installed in your cluster:
```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

### Pod Resource Metrics

When viewing pod details, real-time resource metrics are automatically displayed:
- CPU usage per container
- Memory usage per container
- Total pod resource consumption
- Auto-refreshes every 5 seconds

### Context Menu Actions

Right-click on any resource to:
- View YAML
- Edit Resource
- Describe (opens kubectl describe)
- Delete Resource
- View Logs (for Pods)
- Port Forward (for Pods/Services)
- Exec Shell (for Pods)
- Scale (for Deployments)

### CRD Manager

Access Custom Resource Definitions management:
- Navigate to **View → Command Palette** → `Cluster Pilot: CRD Manager`
- View all CRDs with comprehensive statistics:
  - Total CRDs and instances
  - Namespaced vs Cluster-scoped resources
  - Version information (served vs storage)
- Search and filter CRDs by name, group, or kind
- View instances for each CRD type
- Create new custom resources from templates
- Export CRD definitions to YAML
- Auto-refreshes every 10 seconds

### Event Stream Viewer

Monitor Kubernetes events in real-time:
- Navigate to **View → Command Palette** → `Cluster Pilot: Event Stream Viewer`
- Live streaming event dashboard with 2-second refresh
- Comprehensive statistics:
  - Total events, warnings, and normal events
  - Recent events (last 5 minutes)
  - Unique namespaces and resource types
- Advanced filtering:
  - Search by reason, message, or resource name
  - Filter by event type (Normal/Warning)
  - Filter by namespace or resource kind
- Pause/resume live streaming
- Export filtered events to YAML/JSON

### Helm Manager

Comprehensive Helm release management:
- Navigate to **View → Command Palette** → `Cluster Pilot: Helm Manager`
- **⚠️ Requirement**: Helm CLI must be installed and accessible in your system PATH
  - Install Helm: https://helm.sh/docs/intro/install/
  - Verify installation: Run `helm version` in your terminal
- View all Helm releases with statistics:
  - Total, deployed, failed, and pending releases
  - Namespace distribution
- Operations per release:
  - Upgrade to latest version
  - Rollback to previous revision
  - View values and history
  - Uninstall release
- Repository management:
  - Add new Helm repositories
  - Update all repositories
- Install new charts with custom parameters
- Search and filter by release name, namespace, or chart
- Auto-refreshes every 15 seconds

**Note**: Requires Helm CLI to be installed and accessible in PATH

### Port Forward Manager

Visual port forwarding dashboard:
- Navigate to **View → Command Palette** → `Cluster Pilot: Port Forward Manager`
- View all active port forwards:
  - Real-time status with live indicators
  - Local and remote port mapping
  - Pod and namespace information
- Create new port forwards:
  - Quick wizard with namespace/pod selection
  - Auto-detect container ports
  - Custom or auto-assigned local ports
- One-click actions:
  - Open in browser
  - Copy URL to clipboard
  - Stop individual or all forwards
- System tray integration
- Auto-refreshes every 5 seconds

### Security Scanning

Comprehensive security analysis and vulnerability scanning:
- Navigate to **View → Command Palette** → `Cluster Pilot: Security Scanning`
- **Security Score**: Overall cluster security grade (A-F)
- **Security Issues Detection**:
  - Privileged containers
  - Containers running as root
  - Host network/PID namespace usage
  - Missing resource limits
  - Missing health probes
  - Dangerous capabilities
  - Network exposure risks
  - Missing network policies
- **Image Vulnerability Scanning** (requires Trivy):
  - Automatic CVE detection in container images
  - Severity classification (Critical, High, Medium, Low)
  - Package-level vulnerability details
  - Fix version recommendations
- **Detailed Statistics**:
  - Issue count by severity
  - Images scanned
  - Total vulnerabilities
- **Security Reports**:
  - Export comprehensive security reports to YAML/JSON
  - Issue remediation recommendations
  - Resource-specific security improvements
- Real-time scanning with detailed categorization
- One-click Trivy installation guide

**Note**: Image vulnerability scanning requires [Trivy](https://aquasecurity.github.io/trivy/) to be installed

### kubectl Terminal Integration

Integrated kubectl terminal with seamless cluster management:
- Navigate to **View → Command Palette** → `Cluster Pilot: Open kubectl Terminal` or press **Ctrl+Shift+K** (Cmd+Shift+K on Mac)
- Terminal automatically inherits current cluster context
- Pre-configured with kubeconfig path
- Opens namespace-specific terminals from context menu
- **Quick Commands** (Ctrl+Shift+Alt+K):
  - Get Pods, Services, All Resources
  - View Events, Top Nodes, Top Pods
  - Cluster Info, Namespaces, Nodes
  - Describe and Logs with interactive prompts
- Terminal state persists across cluster switches
- Multiple terminals supported (one per context/namespace)

### YAML Editor with Validation

Create and edit Kubernetes resources with real-time validation:
- Navigate to **View → Command Palette** → `Cluster Pilot: Create Kubernetes Resource` or press **Ctrl+Shift+N** (Cmd+Shift+N on Mac)
- **Built-in Templates**: Pod, Deployment, StatefulSet, DaemonSet, Service, Ingress, ConfigMap, Secret, and more
- **Real-time Validation**: YAML syntax, required fields, K8s schema, name format validation
- **Inline Diagnostics**: Error highlighting with severity indicators
- **One-Click Actions**: Apply to cluster, dry run validation
- **Edit Existing Resources**: Right-click any resource → "Edit Resource with Validation"

### Backup & Restore Manager

Complete cluster state backup and restoration:
- Navigate to **View → Command Palette** → `Cluster Pilot: Backup & Restore Manager`
- **Backup Scopes**: Entire cluster, selected namespaces, or specific resources
- **Visual Dashboard**: List all backups with metadata, size tracking, and one-click operations
- **Restore Operations**: Safety confirmations, automatic namespace creation, progress tracking
- **Import/Export**: Export/import backups as tar.gz archives for portability

### Audit Log Viewer (Enterprise)

Kubernetes audit log streaming and compliance analysis:
- Navigate to **View → Command Palette** → `Cluster Pilot: View Audit Logs`
- **Real-time Event Streaming**: Monitor all audit events from API server
- **Multi-Criteria Filtering**: Filter by user, verb, resource, namespace, status code, severity level
- **Statistics Dashboard**: Unique users, resource types, error rates, verb distribution
- **Export Capabilities**: Export filtered logs to JSON or CSV for compliance reports
- **Sample Data**: Demo mode for understanding audit log structure

**Note**: Requires API server configured with audit logging enabled

### Policy Enforcement (OPA/Gatekeeper) (Enterprise)

Admission control policy management:
- Navigate to **View → Command Palette** → `Cluster Pilot: Policy Enforcement (OPA/Gatekeeper)`
- **Visual Dashboard**: View templates, constraints, violations, and enforcement stats
- **One-Click Installation**: Install Gatekeeper directly from VS Code
- **Constraint Templates**: Pre-built templates for common policies:
  - Required labels enforcement
  - Container image repository restrictions
  - Block NodePort services
  - Require resource limits
- **Policy Management**: Create, view, export, and delete constraints
- **Violation Tracking**: Real-time policy violation detection with detailed messages
- **Enforcement Actions**: Switch between deny, dryrun, and warn modes

**Note**: Requires Gatekeeper to be installed in your cluster

## Keyboard Shortcuts

- **Ctrl+Shift+K** (Cmd+Shift+K): Open kubectl Terminal
- **Ctrl+Shift+Alt+K** (Cmd+Shift+Alt+K): kubectl Quick Commands
- **Ctrl+Shift+N** (Cmd+Shift+N): Create Kubernetes Resource
- **Ctrl+Shift+A**: Apply YAML to Cluster
- **Ctrl+Shift+D**: Dry-run YAML (validation only)

## Troubleshooting

### "Failed to load kubeconfig"
- Ensure `~/.kube/config` exists and is valid YAML
- Check file permissions (should be readable)
- Use `clusterPilot.kubeconfigPath` setting if kubeconfig is in non-standard location

### Real-time logs stopping unexpectedly
- **Cause**: Network interruption or Kubernetes Watch API timeout
- **Fix**: Restart the log viewer or switch tabs and back
- **Workaround**: Use `kubectl logs -f pod-name` in the integrated terminal for long-running tasks

### "RBAC Error: Cannot get resources"
- Ensure your kubeconfig has appropriate permissions for the resources
- Run `kubectl auth can-i get pods --all-namespaces` to verify permissions
- Check your RBAC role bindings

### Extension slow on large clusters
- **Cause**: Large number of resources being cached
- **Workaround**: Use the Namespaces filter to focus on specific namespaces
- **Future**: Pagination and better caching coming in v0.2

### Port forward not working
- Verify `kubectl port-forward` works manually: `kubectl port-forward svc/myservice 3000:80`
- Check that the service/pod is running: `kubectl get svc/pods`
- Ensure port isn't already in use on localhost

## Development

Built with:
- TypeScript (strict mode)
- VS Code Extension API
- @kubernetes/client-node
- YAML parser
- Jest (testing)

## Test Coverage

- ✅ **Utilities**: Error handling, null checks, retry logic (56 tests)
- ⚠️ **Providers**: Basic tree provider tests (partial coverage)
- ⚠️ **K8sClient**: Integration tests in progress
- ❌ **Views**: UI component tests (planned for v0.2)

## Known Issues

- Metrics visualization requires metrics-server in your cluster
- Some operations open kubectl in terminal (future releases will provide native UI)
- Watch API may drop connection during extended network latency (auto-reconnects in v0.2)

## Road map

### v0.2 (Planned)
- Watch API resilience and auto-reconnect
- Full integration test suite
- Large cluster optimization (pagination)
- UI test coverage

### v0.3+
- Policy templates and validation
- Advanced RBAC visualization
- Cost optimization insights
- Performance dashboards for large deployments

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## Reporting Bugs

When reporting bugs, please include:
- Your Kubernetes version (`kubectl version`)
- Cluster size (number of nodes/pods)
- Which feature failed
- Error message from "Cluster Pilot: Show Logs" command
- Steps to reproduce

## License

MIT
