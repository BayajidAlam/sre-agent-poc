#!/usr/bin/env bash
# port-forwards.sh — host-side port-forwards for UIs whose NodePort lands on
# a worker node (kind's extraPortMappings only forwards on the control-plane,
# so NodePort -> control-plane -> worker pod is sometimes broken).
# This script forwards such services to fixed localhost ports.
#
# Usage:  ./scripts/port-forwards.sh   (run in background; Ctrl-C to stop)
#
# Adds:
#   18080 -> ui-kagent:8080                       (kagent chat UI)
#   18443 -> kubernetes-dashboard:443            (k8s dashboard)
#   19091 -> alertmanager-kube-prom-kube-prometheus-alertmanager:9093  (Alertmanager UI)
#   19091 -> kube-prom-kube-prometheus-prometheus:9090  (Prometheus UI, same port)
#     Note: we run both on 19091 by setting Prom first then AM on 19092.
#   19091 -> prometheus
#   19092 -> alertmanager
set -euo pipefail
CTX=kind-sre-poc
KUBECTL="kubectl --context $CTX"

echo ">>> Forwarding:"
echo "    localhost:15000 -> demo-control:80 (demo inject + agent fix UI)"
echo "    localhost:18080 -> ui-kagent:8080 (kagent UI)"
echo "    localhost:18443 -> kubernetes-dashboard:443 (k8s dashboard)"
echo "    localhost:19091 -> kube-prom-kube-prometheus-prometheus:9090 (Prometheus UI)"
echo "    localhost:19092 -> kube-prom-kube-prometheus-alertmanager:9093 (Alertmanager UI)"
echo "    Press Ctrl-C to stop all."

trap "echo '>>> stopping'; kill 0" SIGINT SIGTERM EXIT
$KUBECTL port-forward -n apps-demo svc/demo-control 15000:80 &
$KUBECTL port-forward -n kagent svc/ui-kagent 18080:8080 &
$KUBECTL port-forward -n kubernetes-dashboard svc/kubernetes-dashboard 18443:443 &
$KUBECTL port-forward -n observability svc/kube-prom-kube-prometheus-prometheus 19091:9090 &
$KUBECTL port-forward -n observability svc/kube-prom-kube-prometheus-alertmanager 19092:9093 &
wait

