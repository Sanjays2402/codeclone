{{- define "codeclone.name" -}}
codeclone
{{- end -}}

{{- define "codeclone.fullname" -}}
{{- printf "%s" (include "codeclone.name" .) -}}
{{- end -}}

{{- define "codeclone.labels" -}}
app.kubernetes.io/name: {{ include "codeclone.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "codeclone.selectorLabels" -}}
app.kubernetes.io/name: {{ include "codeclone.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
