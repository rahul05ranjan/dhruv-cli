import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import { loadConfig } from '../config/config.js';

export interface LogEntry {
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  command?: string;
  userId?: string;
  sessionId?: string;
  duration?: number;
  metadata?: Record<string, any>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

class Logger {
  private logger: winston.Logger;
  private sessionId: string;

  constructor() {
    this.sessionId = this.generateSessionId();
    this.logger = this.createLogger();
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private createLogger(): winston.Logger {
    const config = loadConfig();
    const logDir = path.join(process.cwd(), 'logs');

    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.json(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        return JSON.stringify({
          timestamp,
          level,
          message,
          sessionId: this.sessionId,
          ...meta
        });
      })
    );

    const transports: winston.transport[] = [
      // Console transport for development
      new winston.transports.Console({
        level: config.verbose ? 'debug' : 'info',
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple(),
          winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level}: ${message}`;
          })
        )
      }),

      // Daily rotating file for all logs
      new DailyRotateFile({
        filename: path.join(logDir, 'dhruv-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '14d',
        level: 'debug'
      }),

      // Separate error log
      new DailyRotateFile({
        filename: path.join(logDir, 'dhruv-error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '30d',
        level: 'error'
      })
    ];

    return winston.createLogger({
      level: 'debug',
      format: logFormat,
      defaultMeta: { sessionId: this.sessionId },
      transports
    });
  }

  public info(message: string, meta?: Record<string, any>): void {
    this.logger.info(message, meta);
  }

  public warn(message: string, meta?: Record<string, any>): void {
    this.logger.warn(message, meta);
  }

  public error(message: string, error?: Error, meta?: Record<string, any>): void {
    const errorInfo = error ? {
      name: error.name,
      message: error.message,
      stack: error.stack
    } : undefined;

    this.logger.error(message, { error: errorInfo, ...meta });
  }

  public debug(message: string, meta?: Record<string, any>): void {
    this.logger.debug(message, meta);
  }

  public command(command: string, startTime: number, success: boolean, meta?: Record<string, any>): void {
    const duration = Date.now() - startTime;
    const level = success ? 'info' : 'error';
    const message = `Command ${command} ${success ? 'completed' : 'failed'} in ${duration}ms`;

    this.logger.log(level, message, {
      command,
      duration,
      success,
      ...meta
    });
  }

  public performance(metric: string, value: number, unit: string = 'ms', meta?: Record<string, any>): void {
    this.logger.info(`Performance: ${metric} = ${value}${unit}`, {
      metric,
      value,
      unit,
      ...meta
    });
  }

  public security(event: string, details: Record<string, any>): void {
    this.logger.warn(`Security Event: ${event}`, {
      security: true,
      event,
      ...details
    });
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public async flush(): Promise<void> {
    return new Promise((resolve) => {
      this.logger.on('finish', resolve);
      this.logger.end();
    });
  }
}

// Export singleton instance
export const logger = new Logger();

// Helper functions for common logging patterns
export const logCommand = (command: string, startTime: number, success: boolean, meta?: Record<string, any>) => {
  logger.command(command, startTime, success, meta);
};

export const logPerformance = (metric: string, value: number, unit: string = 'ms', meta?: Record<string, any>) => {
  logger.performance(metric, value, unit, meta);
};

export const logSecurity = (event: string, details: Record<string, any>) => {
  logger.security(event, details);
};

export const logError = (message: string, error?: Error, meta?: Record<string, any>) => {
  logger.error(message, error, meta);
};

export const logInfo = (message: string, meta?: Record<string, any>) => {
  logger.info(message, meta);
};

export const logWarn = (message: string, meta?: Record<string, any>) => {
  logger.warn(message, meta);
};

export const logDebug = (message: string, meta?: Record<string, any>) => {
  logger.debug(message, meta);
};
