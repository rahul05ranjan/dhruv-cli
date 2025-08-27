import promClient from 'prom-client';
import { logger } from './logger.js';

// Create a Registry which registers the metrics
const register = new promClient.Registry();

// Add a default label which is added to all metrics
register.setDefaultLabels({
  app: 'dhruv-cli'
});

// Enable the collection of default metrics
promClient.collectDefaultMetrics({ register });

// Custom metrics
export const metrics = {
  // Command execution metrics
  commandDuration: new promClient.Histogram({
    name: 'dhruv_command_duration_seconds',
    help: 'Duration of command execution in seconds',
    labelNames: ['command', 'success'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30]
  }),

  commandCount: new promClient.Counter({
    name: 'dhruv_command_total',
    help: 'Total number of commands executed',
    labelNames: ['command', 'success']
  }),

  // AI service metrics
  aiRequestDuration: new promClient.Histogram({
    name: 'dhruv_ai_request_duration_seconds',
    help: 'Duration of AI requests in seconds',
    labelNames: ['model', 'command_type'],
    buckets: [1, 5, 10, 30, 60, 120]
  }),

  aiRequestCount: new promClient.Counter({
    name: 'dhruv_ai_request_total',
    help: 'Total number of AI requests',
    labelNames: ['model', 'command_type', 'success']
  }),

  aiTokensUsed: new promClient.Counter({
    name: 'dhruv_ai_tokens_total',
    help: 'Total number of tokens used in AI requests',
    labelNames: ['model', 'command_type']
  }),

  // Cache metrics
  cacheHitCount: new promClient.Counter({
    name: 'dhruv_cache_hit_total',
    help: 'Total number of cache hits',
    labelNames: ['cache_type']
  }),

  cacheMissCount: new promClient.Counter({
    name: 'dhruv_cache_miss_total',
    help: 'Total number of cache misses',
    labelNames: ['cache_type']
  }),

  cacheSize: new promClient.Gauge({
    name: 'dhruv_cache_size_bytes',
    help: 'Current size of cache in bytes',
    labelNames: ['cache_type']
  }),

  // Error metrics
  errorCount: new promClient.Counter({
    name: 'dhruv_error_total',
    help: 'Total number of errors',
    labelNames: ['error_type', 'command']
  }),

  // Performance metrics
  memoryUsage: new promClient.Gauge({
    name: 'dhruv_memory_usage_bytes',
    help: 'Current memory usage in bytes',
    labelNames: ['type']
  }),

  // User engagement metrics
  sessionCount: new promClient.Counter({
    name: 'dhruv_session_total',
    help: 'Total number of user sessions'
  }),

  pluginLoadedCount: new promClient.Counter({
    name: 'dhruv_plugin_loaded_total',
    help: 'Total number of plugins loaded'
  })
};

// Register all metrics
Object.values(metrics).forEach(metric => {
  register.registerMetric(metric);
});

export class MetricsCollector {
  private static instance: MetricsCollector;
  private metricsEnabled: boolean;

  private constructor() {
    this.metricsEnabled = process.env.DHRUV_METRICS_ENABLED !== 'false';
    if (this.metricsEnabled) {
      logger.info('Metrics collection enabled');
    }
  }

  public static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  public recordCommand(command: string, duration: number, success: boolean): void {
    if (!this.metricsEnabled) return;

    try {
      metrics.commandDuration.observe({ command, success: success.toString() }, duration / 1000);
      metrics.commandCount.inc({ command, success: success.toString() });
    } catch (error) {
      logger.error('Failed to record command metrics', error as Error);
    }
  }

  public recordAIRequest(model: string, commandType: string, duration: number, success: boolean, tokensUsed?: number): void {
    if (!this.metricsEnabled) return;

    try {
      metrics.aiRequestDuration.observe({ model, command_type: commandType }, duration / 1000);
      metrics.aiRequestCount.inc({ model, command_type: commandType, success: success.toString() });

      if (tokensUsed) {
        metrics.aiTokensUsed.inc({ model, command_type: commandType }, tokensUsed);
      }
    } catch (error) {
      logger.error('Failed to record AI request metrics', error as Error);
    }
  }

  public recordCacheHit(cacheType: string): void {
    if (!this.metricsEnabled) return;

    try {
      metrics.cacheHitCount.inc({ cache_type: cacheType });
    } catch (error) {
      logger.error('Failed to record cache hit metrics', error as Error);
    }
  }

  public recordCacheMiss(cacheType: string): void {
    if (!this.metricsEnabled) return;

    try {
      metrics.cacheMissCount.inc({ cache_type: cacheType });
    } catch (error) {
      logger.error('Failed to record cache miss metrics', error as Error);
    }
  }

  public updateCacheSize(cacheType: string, size: number): void {
    if (!this.metricsEnabled) return;

    try {
      metrics.cacheSize.set({ cache_type: cacheType }, size);
    } catch (error) {
      logger.error('Failed to update cache size metrics', error as Error);
    }
  }

  public recordError(errorType: string, command?: string): void {
    if (!this.metricsEnabled) return;

    try {
      metrics.errorCount.inc({ error_type: errorType, command: command || 'unknown' });
    } catch (error) {
      logger.error('Failed to record error metrics', error as Error);
    }
  }

  public updateMemoryUsage(): void {
    if (!this.metricsEnabled) return;

    try {
      const memUsage = process.memoryUsage();
      metrics.memoryUsage.set({ type: 'rss' }, memUsage.rss);
      metrics.memoryUsage.set({ type: 'heap_used' }, memUsage.heapUsed);
      metrics.memoryUsage.set({ type: 'heap_total' }, memUsage.heapTotal);
      metrics.memoryUsage.set({ type: 'external' }, memUsage.external);
    } catch (error) {
      logger.error('Failed to update memory usage metrics', error as Error);
    }
  }

  public recordSession(): void {
    if (!this.metricsEnabled) return;

    try {
      metrics.sessionCount.inc();
    } catch (error) {
      logger.error('Failed to record session metrics', error as Error);
    }
  }

  public recordPluginLoaded(): void {
    if (!this.metricsEnabled) return;

    try {
      metrics.pluginLoadedCount.inc();
    } catch (error) {
      logger.error('Failed to record plugin loaded metrics', error as Error);
    }
  }

  public async getMetrics(): Promise<string> {
    return register.metrics();
  }

  public async getMetricsJSON(): Promise<promClient.MetricObjectWithValues<promClient.MetricValue<string>>[]> {
    return register.getMetricsAsJSON();
  }

  public getRegistry(): promClient.Registry {
    return register;
  }
}

export const metricsCollector = MetricsCollector.getInstance();
