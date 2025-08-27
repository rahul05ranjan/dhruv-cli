import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { printSuccess, printError, printInfo, printWarning } from '../utils/ux.js';
import { logger } from '../core/logger.js';
import { metricsCollector } from '../core/metrics.js';
import { securityManager } from '../core/security.js';
import { detectProjectType } from '../utils/projectType.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

interface HealthCheckResult {
  category: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: unknown;
  recommendation?: string;
}

interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  totalMemory: string;
  freeMemory: string;
  uptime: string;
  cpuCount: number;
}

export async function health(): Promise<void> {
  console.log(chalk.blue.bold('🔍 Dhruv CLI Health Check\n'));

  const results: HealthCheckResult[] = [];
  const startTime = Date.now();

  try {
    // System Information
    const systemInfo = getSystemInfo();
    console.log(chalk.cyan('📊 System Information:'));
    Object.entries(systemInfo).forEach(([key, value]) => {
      console.log(`  ${key}: ${chalk.yellow(value)}`);
    });
    console.log();

    // Configuration Check
    results.push(...await checkConfiguration());

    // Dependencies Check
    results.push(...await checkDependencies());

    // AI Service Check
    results.push(...await checkAIService());

    // Security Check
    results.push(...await checkSecurity());

    // Performance Check
    results.push(...await checkPerformance());

    // File System Check
    results.push(...await checkFileSystem());

    // Plugin System Check
    results.push(...await checkPlugins());

    // Display Results
    displayResults(results);

    const duration = Date.now() - startTime;
    logger.info('Health check completed', { duration, results: results.length });

  } catch (error) {
    printError('Health check failed');
    console.error(chalk.red((error as Error).message));
    logger.error('Health check failed', error as Error);
  }
}

function getSystemInfo(): SystemInfo {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const uptime = os.uptime();

  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    nodeVersion: process.version,
    totalMemory: `${(totalMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
    freeMemory: `${(freeMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    cpuCount: os.cpus().length
  };
}

async function checkConfiguration(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  try {
    const config = loadConfig();

    // Check if config file exists
    const configPath = path.join(process.cwd(), '.dhruv-config.json');
    if (fs.existsSync(configPath)) {
      results.push({
        category: 'Configuration',
        status: 'pass',
        message: 'Configuration file found and loaded successfully'
      });
    } else {
      results.push({
        category: 'Configuration',
        status: 'warn',
        message: 'No configuration file found',
        recommendation: 'Run "dhruv init" to create a configuration file'
      });
    }

    // Check model configuration
    if (config.model && config.model.trim().length > 0) {
      results.push({
        category: 'Configuration',
        status: 'pass',
        message: `Model configured: ${config.model}`
      });
    } else {
      results.push({
        category: 'Configuration',
        status: 'fail',
        message: 'No model configured',
        recommendation: 'Set a model using "dhruv init" or --model flag'
      });
    }

    // Check theme configuration
    if (config.theme && ['default', 'dark', 'light', 'mono'].includes(config.theme)) {
      results.push({
        category: 'Configuration',
        status: 'pass',
        message: `Theme configured: ${config.theme}`
      });
    } else {
      results.push({
        category: 'Configuration',
        status: 'warn',
        message: 'Invalid or missing theme configuration',
        recommendation: 'Set theme using "dhruv init"'
      });
    }

  } catch (error) {
    results.push({
      category: 'Configuration',
      status: 'fail',
      message: `Configuration check failed: ${(error as Error).message}`,
      details: error
    });
  }

  return results;
}

async function checkDependencies(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  try {
    // Check package.json
    const packagePath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      results.push({
        category: 'Dependencies',
        status: 'pass',
        message: `Package.json found with ${Object.keys(packageJson.dependencies || {}).length} dependencies`
      });
    } else {
      results.push({
        category: 'Dependencies',
        status: 'fail',
        message: 'package.json not found',
        recommendation: 'Ensure you are in the correct project directory'
      });
    }

    // Check node_modules
    const nodeModulesPath = path.join(process.cwd(), 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
      results.push({
        category: 'Dependencies',
        status: 'pass',
        message: 'Node modules installed'
      });
    } else {
      results.push({
        category: 'Dependencies',
        status: 'fail',
        message: 'Node modules not found',
        recommendation: 'Run "npm install" to install dependencies'
      });
    }

  } catch (error) {
    results.push({
      category: 'Dependencies',
      status: 'fail',
      message: `Dependencies check failed: ${(error as Error).message}`,
      details: error
    });
  }

  return results;
}

async function checkAIService(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  try {
    // Check if Ollama is running (basic connectivity test)
    const { Ollama } = await import('ollama');

    try {
      const ollama = new Ollama();
      await ollama.list();
      results.push({
        category: 'AI Service',
        status: 'pass',
        message: 'Ollama service is running and accessible'
      });
    } catch (error) {
      results.push({
        category: 'AI Service',
        status: 'fail',
        message: 'Ollama service is not accessible',
        details: error,
        recommendation: 'Start Ollama with "ollama serve"'
      });
    }

  } catch (error) {
    results.push({
      category: 'AI Service',
      status: 'fail',
      message: `AI service check failed: ${(error as Error).message}`,
      details: error
    });
  }

  return results;
}

async function checkSecurity(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  try {
    const securityStatus = securityManager.getSecurityStatus();

    results.push({
      category: 'Security',
      status: 'pass',
      message: `Security manager active with ${securityStatus.blockedPatternsCount} patterns`,
      details: {
        inputValidation: securityStatus.config.enableInputValidation,
        rateLimiting: securityStatus.config.enableRateLimiting,
        activeRateLimits: securityStatus.activeRateLimits
      }
    });

  } catch (error) {
    results.push({
      category: 'Security',
      status: 'fail',
      message: `Security check failed: ${(error as Error).message}`,
      details: error
    });
  }

  return results;
}

async function checkPerformance(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  try {
    // Memory usage check
    const memUsage = process.memoryUsage();
    const memUsageMB = memUsage.heapUsed / 1024 / 1024;

    if (memUsageMB < 100) {
      results.push({
        category: 'Performance',
        status: 'pass',
        message: `Memory usage: ${memUsageMB.toFixed(2)} MB`
      });
    } else if (memUsageMB < 500) {
      results.push({
        category: 'Performance',
        status: 'warn',
        message: `High memory usage: ${memUsageMB.toFixed(2)} MB`,
        recommendation: 'Monitor memory usage during extended use'
      });
    } else {
      results.push({
        category: 'Performance',
        status: 'fail',
        message: `Excessive memory usage: ${memUsageMB.toFixed(2)} MB`,
        recommendation: 'Restart the application or investigate memory leaks'
      });
    }

    // Update metrics
    metricsCollector.updateMemoryUsage();

  } catch (error) {
    results.push({
      category: 'Performance',
      status: 'fail',
      message: `Performance check failed: ${(error as Error).message}`,
      details: error
    });
  }

  return results;
}

async function checkFileSystem(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  try {
    // Check cache directory
    const cacheDir = path.join(process.cwd(), '.dhruv-cache');
    if (fs.existsSync(cacheDir)) {
      const cacheFiles = fs.readdirSync(cacheDir);
      results.push({
        category: 'File System',
        status: 'pass',
        message: `Cache directory healthy with ${cacheFiles.length} files`
      });
    } else {
      results.push({
        category: 'File System',
        status: 'pass',
        message: 'Cache directory will be created on first use'
      });
    }

    // Check logs directory
    const logsDir = path.join(process.cwd(), 'logs');
    if (fs.existsSync(logsDir)) {
      const logFiles = fs.readdirSync(logsDir);
      results.push({
        category: 'File System',
        status: 'pass',
        message: `Logs directory healthy with ${logFiles.length} files`
      });
    } else {
      results.push({
        category: 'File System',
        status: 'pass',
        message: 'Logs directory will be created on first use'
      });
    }

  } catch (error) {
    results.push({
      category: 'File System',
      status: 'fail',
      message: `File system check failed: ${(error as Error).message}`,
      details: error
    });
  }

  return results;
}

async function checkPlugins(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  try {
    const pluginsDir = path.join(process.cwd(), 'plugins');

    if (fs.existsSync(pluginsDir)) {
      const pluginFiles = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
      results.push({
        category: 'Plugins',
        status: 'pass',
        message: `Plugin system active with ${pluginFiles.length} plugins`,
        details: pluginFiles
      });
    } else {
      results.push({
        category: 'Plugins',
        status: 'pass',
        message: 'Plugin system ready (no plugins installed)'
      });
    }

  } catch (error) {
    results.push({
      category: 'Plugins',
      status: 'fail',
      message: `Plugin check failed: ${(error as Error).message}`,
      details: error
    });
  }

  return results;
}

function displayResults(results: HealthCheckResult[]): void {
  const categories = ['Configuration', 'Dependencies', 'AI Service', 'Security', 'Performance', 'File System', 'Plugins'];

  categories.forEach(category => {
    const categoryResults = results.filter(r => r.category === category);

    if (categoryResults.length > 0) {
      console.log(chalk.cyan(`\n📋 ${category}:`));

      categoryResults.forEach(result => {
        const icon = result.status === 'pass' ? '✅' : result.status === 'warn' ? '⚠️' : '❌';
        const color = result.status === 'pass' ? chalk.green : result.status === 'warn' ? chalk.yellow : chalk.red;

        console.log(`  ${icon} ${color(result.message)}`);

        if (result.details) {
          console.log(`    ${chalk.gray(JSON.stringify(result.details, null, 2))}`);
        }

        if (result.recommendation) {
          console.log(`    💡 ${chalk.blue(result.recommendation)}`);
        }
      });
    }
  });

  // Summary
  const summary = {
    pass: results.filter(r => r.status === 'pass').length,
    warn: results.filter(r => r.status === 'warn').length,
    fail: results.filter(r => r.status === 'fail').length
  };

  console.log(chalk.blue.bold('\n📊 Summary:'));
  console.log(`  ✅ Passed: ${chalk.green(summary.pass)}`);
  console.log(`  ⚠️  Warnings: ${chalk.yellow(summary.warn)}`);
  console.log(`  ❌ Failed: ${chalk.red(summary.fail)}`);

  const overallStatus = summary.fail > 0 ? 'fail' : summary.warn > 0 ? 'warn' : 'pass';
  const statusIcon = overallStatus === 'pass' ? '🎉' : overallStatus === 'warn' ? '⚠️' : '❌';
  const statusColor = overallStatus === 'pass' ? chalk.green : overallStatus === 'warn' ? chalk.yellow : chalk.red;

  console.log(`\n${statusIcon} ${statusColor('Overall Status: ' + overallStatus.toUpperCase())}`);
}
