# Changelog

All notable changes to the "Cluster Pilot" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-02-02

### Added
- Initial beta release of Cluster Pilot
- Multi-cluster Kubernetes management with context switching
- Comprehensive resource management (Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, Services, Ingresses, ConfigMaps, Secrets, PVs, PVCs, Nodes, Namespaces)
- Custom Resource Definition (CRD) support with full CRUD operations
- Real-time pod logs with container selection
- Shell access to running containers
- Port forwarding manager with visual interface
- Helm integration for chart management (requires Helm CLI)
- RBAC viewer for Roles, RoleBindings, ClusterRoles, and ClusterRoleBindings
- Backup and restore functionality for cluster state
- YAML editor with validation and syntax highlighting
- kubectl terminal integration with quick commands
- Resource comparison across namespaces and clusters
- Event streaming and monitoring
- Security scanning capabilities
- Policy enforcement with OPA/Gatekeeper support
- Audit log viewer
- Resource templates for quick creation
- Advanced filtering and search capabilities
- Progressive loading for large resource sets
- Real-time watch mode for resources
- 94 commands for comprehensive cluster control
- 11 custom views in dedicated sidebar

### Features by Category

#### Workload Management
- View, create, edit, delete pods, deployments, statefulsets, daemonsets
- Scale deployments and statefulsets
- Restart deployments and daemonsets
- Rollback deployments to previous revisions
- Job and CronJob management (create, trigger, suspend, resume)

#### Configuration & Storage
- ConfigMap and Secret editor with validation
- PersistentVolume and PersistentVolumeClaim management
- StorageClass configuration
- Resource templates for quick deployment

#### Network & Services
- Service management (ClusterIP, NodePort, LoadBalancer)
- Ingress configuration and monitoring
- Network Policy viewer
- Port forwarding with auto-reconnect

#### RBAC & Security
- Role and ClusterRole viewer with detailed permissions
- RoleBinding and ClusterRoleBinding management
- ServiceAccount configuration
- Security scanning integration
- Policy enforcement with Gatekeeper

#### Monitoring & Observability
- Real-time log streaming with filtering
- Event viewer with namespace filtering
- Resource metrics (requires metrics-server)
- Capacity planning dashboard
- Cost estimation panel
- Resource usage visualization

#### Developer Tools
- Integrated kubectl terminal
- YAML validation and dry-run
- Resource diff and comparison
- Export resources to YAML/JSON
- Template-based resource creation
- Multi-cluster manager interface

### Known Limitations
- Real-time features may have reconnection issues under heavy load
- Performance not yet optimized for very large clusters (1000+ nodes)
- Watch API may experience occasional edge cases during network interruptions
- Integration test coverage is still in development

### Requirements
- Visual Studio Code 1.80.0 or higher
- kubectl installed and configured
- Access to a Kubernetes cluster
- Helm CLI (optional, required for Helm Manager panel)
- metrics-server (optional, for resource metrics)

### Recommended Use
- ✅ Development and staging clusters
- ✅ Small to medium production clusters with monitoring
- ✅ Learning and exploration
- ⚠️ Not recommended for mission-critical production without parallel monitoring

### Credits
- Built with [@kubernetes/client-node](https://github.com/kubernetes-client/javascript)
- Inspired by [Lens](https://k8slens.dev/)
- Icons from [VS Code Codicons](https://microsoft.github.io/vscode-codicons/)

---

## Release Notes

### v0.1.0 - Beta Release (February 2026)

This is the initial beta release of Cluster Pilot. While the core functionality is stable and tested, this version is recommended for development and testing environments. We encourage users to:

- Test thoroughly in non-production environments first
- Maintain regular backups of critical cluster configurations
- Report any issues on our [GitHub repository](https://github.com/jasonheath776/cluster-pilot/issues)
- Provide feedback and feature requests

Thank you for being an early adopter! Your feedback is invaluable as we work toward v1.0.

---

[Unreleased]: https://github.com/jasonheath776/cluster-pilot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jasonheath776/cluster-pilot/releases/tag/v0.1.0
