# Terraform skeleton for CodeClone

Deploys the CodeClone serve chart into an existing Kubernetes cluster.

```bash
cd infra/terraform
terraform init
terraform apply -var "api_key=sk-..."
```

This module assumes:

- a kubeconfig already exists for the target cluster
- the container image has been built and pushed to `var.image_repository`

It intentionally does NOT provision the cluster itself; cluster lifecycle
should live in your platform's existing modules. This skeleton is a
deployment, not an infra blueprint.
