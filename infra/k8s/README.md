# Raw Kubernetes manifests (Helm-free)

Use the Helm chart at `infra/helm/codeclone` for real deployments. These raw
manifests exist for quick `kubectl apply -k .` smoke tests against a kind /
minikube cluster.

```bash
kubectl create namespace codeclone || true
kubectl -n codeclone create secret generic codeclone-secrets \
  --from-literal=api-key="sk-local" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n codeclone apply -k infra/k8s
```
