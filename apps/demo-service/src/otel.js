// OTel bootstrap — must be required BEFORE the app code so auto-instrumentation can patch modules.
'use strict';
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

// The Helm chart name-suffixes the release: the Service is
// `otel-collector-opentelemetry-collector.observability.svc.cluster.local`,
// not the bare `otel-collector.observability`. We use the FQDN so DNS
// resolution works from any namespace (the short name depends on the
// pod's search-domain list, which doesn't include `observability.svc`).
const OTEL_FQDN = 'otel-collector-opentelemetry-collector.observability.svc.cluster.local';
const exporterUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || `http://${OTEL_FQDN}:4318`;

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'demo-service',
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.APP_VERSION || 'dev',
  }),
  traceExporter: new OTLPTraceExporter({ url: `${exporterUrl}/v1/traces` }),
  // Auto-instrumentation emits HTTP duration histograms as metrics; without
  // a MetricReader + exporter those are discarded. The OTel collector's
  // prometheus exporter then translates them to Prometheus exposition so
  // Grafana's HTTP server panel has data.
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${exporterUrl}/v1/metrics` }),
    exportIntervalMillis: 10000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));