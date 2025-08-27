import { Command } from 'commander';
import chalk from 'chalk';
import { printSuccess, printError, printInfo } from '../utils/ux.js';
import { metricsCollector } from '../core/metrics.js';
import { logger } from '../core/logger.js';

export async function metrics(): Promise<void> {
  console.log(chalk.blue.bold('📊 Dhruv CLI Metrics\n'));

  try {
    // Get metrics data
    const metricsData = await metricsCollector.getMetricsJSON();

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

    // Display raw Prometheus metrics
    console.log(chalk.cyan('\n📋 Raw Prometheus Metrics:'));
    console.log(chalk.gray('─'.repeat(50)));
    const rawMetrics = await metricsCollector.getMetrics();
    console.log(rawMetrics);

    logger.info('Metrics displayed successfully', { metricsCount: metricsData.length });

  } catch (error) {
    printError('Failed to retrieve metrics');
    console.error(chalk.red((error as Error).message));
    logger.error('Metrics command failed', error as Error);
  }
}
