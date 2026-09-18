import { Command } from 'commander';
import chalk from 'chalk';
import { printSuccess, printError, printInfo } from '../utils/ux.js';
import { metricsCollector } from '../core/metrics.js';
import { logger } from '../core/logger.js';
import { loadConfig } from '../config/config.js';

export interface MetricsOptions {
  raw?: boolean;
  reset?: boolean;
}

export async function metrics(options: MetricsOptions = {}): Promise<void> {
  try {
    if (options.reset) {
      metricsCollector.resetPersistent();
      if (loadConfig().responseFormat === 'json') {
        process.stdout.write(`${JSON.stringify({ ok: true, command: 'metrics', reset: true, summary: metricsCollector.getSummary() })}\n`);
      } else {
        printSuccess('Local metrics reset.');
      }
      return;
    }

    // Get metrics data
    const metricsData = await metricsCollector.getMetricsJSON();
    const summary = metricsCollector.getSummary();

    if (loadConfig().responseFormat === 'json') {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        command: 'metrics',
        summary,
        metrics: metricsData,
      })}\n`);
      return;
    }

    console.log(chalk.blue.bold('📊 Dhruv CLI Metrics\n'));
    console.log(chalk.cyan('📌 Local summary:'));
    console.log(`  Sessions: ${chalk.green(summary.sessions)}`);
    Object.entries(summary.commands).forEach(([command, data]) => {
      console.log(`  ${chalk.yellow(command)}: ${data.runs} runs, ${data.successes} succeeded, ${data.failures} failed, ${data.durationMs}ms`);
    });
    Object.entries(summary.models).forEach(([model, data]) => {
      console.log(`  ${chalk.yellow(model)}: ${data.requests} requests, ${data.successes} succeeded, ${data.failures} failed, ${data.durationMs}ms`);
    });
    console.log(`  Cache: ${chalk.green(summary.cache.hits)} hits, ${chalk.yellow(summary.cache.misses)} misses`);

    if (metricsData.length === 0) {
      printInfo('No metrics data available yet. Metrics are collected during CLI usage.');
      return;
    }

    // Display metrics by category
    const categories = {
      'Command Metrics': ['dhruv_command', 'dhruv_session'],
      'AI Service Metrics': ['dhruv_ai_request', 'dhruv_ai_tokens', 'dhruv_cache'],
      'Performance Metrics': ['dhruv_memory', 'dhruv_performance'],
      'Error Metrics': ['dhruv_error'],
      'Plugin Metrics': ['dhruv_plugin']
    };

    Object.entries(categories).forEach(([category, prefixes]) => {
      const categoryMetrics = metricsData.filter(metric =>
        prefixes.some(prefix => metric.name.startsWith(prefix))
      );

      if (categoryMetrics.length > 0) {
        console.log(chalk.cyan(`\n📈 ${category}:`));

        categoryMetrics.forEach(metric => {
          const name = metric.name.replace('dhruv_', '').replace(/_/g, ' ');
          const value = metric.values?.[0]?.value || 0;
          const labels = metric.values?.[0]?.labels || {};

          console.log(`  ${chalk.yellow(name)}: ${chalk.green(value)}`);

          // Display labels if available
          const labelEntries = Object.entries(labels);
          if (labelEntries.length > 0) {
            console.log(`    ${chalk.gray('Labels:')} ${labelEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
          }
        });
      }
    });

    if (options.raw) {
      const rawMetrics = await metricsCollector.getMetrics();
      process.stdout.write(rawMetrics);
    }

    logger.info('Metrics displayed successfully', { metricsCount: metricsData.length });

  } catch (error) {
    process.exitCode = 1;
    if (loadConfig().responseFormat === 'json') {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        command: 'metrics',
        error: (error as Error).message,
      })}\n`);
    } else {
      printError('Failed to retrieve metrics');
      console.error(chalk.red((error as Error).message));
    }
    logger.error('Metrics command failed', error as Error);
  }
}
