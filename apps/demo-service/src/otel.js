// OTel bootstrap — must be required BEFORE the app code so auto-instrumentation can patch modules.
'use strict';
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

const exporterUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector.observability:4318';

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'demo-service',
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.APP_VERSION || 'dev',
  }),
  traceExporter: new OTLPTraceExporter({ url: `${exporterUrl}/v1/traces` }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));