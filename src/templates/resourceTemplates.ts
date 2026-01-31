export interface ResourceTemplate {
    name: string;
    type: string;
    category: string;
    description: string;
    template: string;
}

export const resourceTemplates: ResourceTemplate[] = [
    // Workload Templates
    {
        name: 'Deployment',
        type: 'deployment',
        category: 'Workloads',
        description: 'Create a basic Deployment',
        template: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: default
  labels:
    app: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        image: nginx:latest
        ports:
        - containerPort: 80
        resources:
          requests:
            memory: "64Mi"
            cpu: "250m"
          limits:
            memory: "128Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 5
          periodSeconds: 5`
    },
    {
        name: 'StatefulSet',
        type: 'statefulset',
        category: 'Workloads',
        description: 'Create a StatefulSet for stateful applications',
        template: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-statefulset
  namespace: default
spec:
  serviceName: my-statefulset
  replicas: 3
  selector:
    matchLabels:
      app: my-statefulset
  template:
    metadata:
      labels:
        app: my-statefulset
    spec:
      containers:
      - name: my-app
        image: nginx:latest
        ports:
        - containerPort: 80
        volumeMounts:
        - name: data
          mountPath: /data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      resources:
        requests:
          storage: 1Gi`
    },
    {
        name: 'DaemonSet',
        type: 'daemonset',
        category: 'Workloads',
        description: 'Create a DaemonSet to run on all nodes',
        template: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: my-daemonset
  namespace: default
  labels:
    app: my-daemonset
spec:
  selector:
    matchLabels:
      app: my-daemonset
  template:
    metadata:
      labels:
        app: my-daemonset
    spec:
      containers:
      - name: my-app
        image: nginx:latest
        resources:
          limits:
            memory: 200Mi
          requests:
            cpu: 100m
            memory: 200Mi`
    },
    {
        name: 'Job',
        type: 'job',
        category: 'Workloads',
        description: 'Create a one-time Job',
        template: `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
  namespace: default
spec:
  template:
    spec:
      containers:
      - name: my-job
        image: busybox
        command: ["echo", "Hello from the job"]
      restartPolicy: Never
  backoffLimit: 4`
    },
    {
        name: 'CronJob',
        type: 'cronjob',
        category: 'Workloads',
        description: 'Create a scheduled CronJob',
        template: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cronjob
  namespace: default
spec:
  schedule: "0 */6 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: my-cronjob
            image: busybox
            command: ["echo", "Hello from the cronjob"]
          restartPolicy: OnFailure
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1`
    },
    // Service Templates
    {
        name: 'Service - ClusterIP',
        type: 'service',
        category: 'Network',
        description: 'Create a ClusterIP Service (internal only)',
        template: `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: default
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80`
    },
    {
        name: 'Service - NodePort',
        type: 'service',
        category: 'Network',
        description: 'Create a NodePort Service (external access)',
        template: `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: default
spec:
  type: NodePort
  selector:
    app: my-app
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
    nodePort: 30080`
    },
    {
        name: 'Service - LoadBalancer',
        type: 'service',
        category: 'Network',
        description: 'Create a LoadBalancer Service',
        template: `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: default
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80`
    },
    {
        name: 'Ingress',
        type: 'ingress',
        category: 'Network',
        description: 'Create an Ingress for HTTP(S) routing',
        template: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  namespace: default
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-service
            port:
              number: 80`
    },
    // Configuration Templates
    {
        name: 'ConfigMap',
        type: 'configmap',
        category: 'Configuration',
        description: 'Create a ConfigMap for configuration data',
        template: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
data:
  config.json: |
    {
      "key": "value"
    }
  app.properties: |
    setting1=value1
    setting2=value2`
    },
    {
        name: 'Secret',
        type: 'secret',
        category: 'Configuration',
        description: 'Create a Secret for sensitive data',
        template: `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: default
type: Opaque
data:
  username: YWRtaW4=  # base64 encoded "admin"
  password: cGFzc3dvcmQ=  # base64 encoded "password"`
    },
    // Storage Templates
    {
        name: 'PersistentVolumeClaim',
        type: 'pvc',
        category: 'Storage',
        description: 'Create a PersistentVolumeClaim',
        template: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
  storageClassName: standard`
    },
    {
        name: 'PersistentVolume',
        type: 'pv',
        category: 'Storage',
        description: 'Create a PersistentVolume',
        template: `apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-pv
spec:
  capacity:
    storage: 10Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: standard
  hostPath:
    path: /data/pv`
    },
    // RBAC Templates
    {
        name: 'ServiceAccount',
        type: 'serviceaccount',
        category: 'RBAC',
        description: 'Create a ServiceAccount',
        template: `apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-serviceaccount
  namespace: default`
    },
    {
        name: 'Role',
        type: 'role',
        category: 'RBAC',
        description: 'Create a Role with permissions',
        template: `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-role
  namespace: default
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["services"]
  verbs: ["get", "list"]`
    },
    {
        name: 'RoleBinding',
        type: 'rolebinding',
        category: 'RBAC',
        description: 'Create a RoleBinding',
        template: `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-rolebinding
  namespace: default
subjects:
- kind: ServiceAccount
  name: my-serviceaccount
  namespace: default
roleRef:
  kind: Role
  name: my-role
  apiGroup: rbac.authorization.k8s.io`
    },
    // Namespace Template
    {
        name: 'Namespace',
        type: 'namespace',
        category: 'Cluster',
        description: 'Create a new Namespace',
        template: `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
  labels:
    name: my-namespace`
    },
    // Network Policy Template
    {
        name: 'NetworkPolicy',
        type: 'networkpolicy',
        category: 'Network',
        description: 'Create a NetworkPolicy for traffic control',
        template: `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: my-networkpolicy
  namespace: default
spec:
  podSelector:
    matchLabels:
      app: my-app
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: frontend
    ports:
    - protocol: TCP
      port: 80
  egress:
  - to:
    - podSelector:
        matchLabels:
          role: database
    ports:
    - protocol: TCP
      port: 5432`
    },
    // HorizontalPodAutoscaler Template
    {
        name: 'HorizontalPodAutoscaler',
        type: 'hpa',
        category: 'Workloads',
        description: 'Create an HPA for auto-scaling',
        template: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-hpa
  namespace: default
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80`
    }
];

export function getTemplatesByCategory(category: string): ResourceTemplate[] {
    return resourceTemplates.filter(t => t.category === category);
}

export function getTemplateByType(type: string): ResourceTemplate | undefined {
    return resourceTemplates.find(t => t.type === type);
}

export function getAllCategories(): string[] {
    return [...new Set(resourceTemplates.map(t => t.category))];
}
