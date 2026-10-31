# Kubernetes, Helm and CloudNativePG

- `command:` in a pod spec replaces the image entrypoint, and with it any privilege drop the entrypoint does. Use `args:` unless the entrypoint must go.
- Pin every image: tags by digest, and the CloudNativePG `imageName` too. A floating tag can change a major version on a rebuild.
- Apply a ConfigMap that takes over a key BEFORE you remove that key from the Secret; the other order leaves the pod without the key.
- `appProtocol` is set per Service port: a backend that serves two protocols on one port needs two ports. Match a gRPC route on the content type `^application/grpc(\+.*)?$`.
- Redis `maxmemory` stays below the container's `limits.memory`; raise both together.
- `invalidated cache …` log lines in pairs on a 3-minute grid are informer resyncs, not proof that a watch works.

## Helm

- Render a chart only where its values are set, and check the render for `randAlphaNum`, `genCA`, `uuidv4` and `now`: each changes on every render, so a GitOps sync never settles.
- Never set an admin password through chart values (for Argo CD, `configs.secret.argocdServerAdminPassword`): it lands in the rendered manifest.
- `helm template` on an `oci://` chart prints its pull messages into the render: `helm pull` first, then render the local chart.
- Apply large CRDs with `--server-side`; a client-side apply stores the whole object in an annotation that is over the size limit.

## CloudNativePG

- A Secret made by hand for a Cluster needs the label `cnpg.io/reload=true`, or a password rotation fails without an error. Its `username` equals `initdb.owner`.
- `ContinuousArchiving=True` is not proof of backups. Prove a backup by the objects in the bucket.
