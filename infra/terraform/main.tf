resource "kubernetes_namespace" "this" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
      "app.kubernetes.io/part-of"    = "codeclone"
    }
  }
}

resource "kubernetes_secret" "secrets" {
  metadata {
    name      = "codeclone-secrets"
    namespace = kubernetes_namespace.this.metadata[0].name
  }
  data = {
    "api-key" = var.api_key
  }
  type = "Opaque"
}

resource "helm_release" "codeclone" {
  name       = var.release_name
  namespace  = kubernetes_namespace.this.metadata[0].name
  chart      = var.chart_path
  depends_on = [kubernetes_secret.secrets]

  values = [
    yamlencode({
      image = {
        repository = var.image_repository
        tag        = var.image_tag
      }
      replicaCount = var.replica_count
      secretRefName = "codeclone-secrets"
    })
  ]
}

output "namespace" {
  value = kubernetes_namespace.this.metadata[0].name
}

output "service_name" {
  value = var.release_name
}
