variable "namespace" {
  type        = string
  default     = "codeclone"
  description = "Kubernetes namespace to deploy CodeClone into."
}

variable "release_name" {
  type        = string
  default     = "codeclone"
  description = "Helm release name."
}

variable "chart_path" {
  type        = string
  default     = "../helm/codeclone"
  description = "Path to the CodeClone Helm chart (relative to this dir)."
}

variable "image_repository" {
  type        = string
  default     = "ghcr.io/sanjays2402/codeclone"
}

variable "image_tag" {
  type        = string
  default     = "0.1.0"
}

variable "replica_count" {
  type    = number
  default = 1
}

variable "api_key" {
  type        = string
  sensitive   = true
  description = "API key clients must send in Authorization: Bearer."
}

variable "kubeconfig_path" {
  type    = string
  default = "~/.kube/config"
}

variable "kube_context" {
  type        = string
  default     = ""
  description = "Optional kube context. Leave empty to use current."
}
