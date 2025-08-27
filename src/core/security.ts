import Joi from 'joi';
import validator from 'validator';
import { logger, logSecurity } from './logger.js';
import { metricsCollector } from './metrics.js';

export interface SecurityConfig {
  enableInputValidation: boolean;
  enableRateLimiting: boolean;
  maxInputLength: number;
  allowedCommands: string[];
  blockedPatterns: RegExp[];
  maxRequestsPerMinute: number;
}

export class SecurityManager {
  private static instance: SecurityManager;
  private config: SecurityConfig;
  private requestCounts: Map<string, { count: number; resetTime: number }> = new Map();
  private schemas: { [key: string]: Joi.ObjectSchema } = {};

  private constructor() {
    this.config = {
      enableInputValidation: process.env.DHRUV_SECURITY_VALIDATION !== 'false',
      enableRateLimiting: process.env.DHRUV_SECURITY_RATE_LIMIT !== 'false',
      maxInputLength: parseInt(process.env.DHRUV_MAX_INPUT_LENGTH || '10000'),
      allowedCommands: [
        'explain', 'suggest', 'fix', 'review', 'optimize',
        'security-check', 'generate', 'init', 'status',
        'project-type', 'menu', 'completion', 'help'
      ],
      blockedPatterns: [
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, // XSS patterns
        /\b(eval|exec|system|shell_exec|passthru|proc_open|popen)\b/i, // Code execution
        /\b(rm\s+(-rf|--force)\s+|del\s+)/i, // File deletion
        /\b(format|fdisk|mkfs)\b/i, // Disk operations
        /password\s*=\s*['"][^'"]*['"]/i, // Password exposure
        /\b(ssh|scp|rsync)\s+.*@\w+/i, // SSH operations
      ],
      maxRequestsPerMinute: parseInt(process.env.DHRUV_RATE_LIMIT || '60')
    };

    this.initializeSchemas();

    logger.info('Security manager initialized', {
      config: {
        ...this.config,
        blockedPatterns: this.config.blockedPatterns.map(p => p.toString())
      }
    });
  }

  private initializeSchemas(): void {
    this.schemas = {
      explain: Joi.object({
        query: Joi.string()
          .min(1)
          .max(this.config.maxInputLength)
          .required()
          .messages({
            'string.empty': 'Query cannot be empty',
            'string.max': `Query too long (max ${this.config.maxInputLength} characters)`
          })
      }),

      suggest: Joi.object({
        query: Joi.string()
          .min(1)
          .max(this.config.maxInputLength)
          .required()
      }),

      fix: Joi.object({
        query: Joi.string()
          .min(1)
          .max(this.config.maxInputLength)
          .required()
      }),

      review: Joi.object({
        fileOrDir: Joi.string()
          .min(1)
          .max(500)
          .pattern(/^[^<>&|;$`]*$/) // Prevent shell injection
          .required()
      }),

      optimize: Joi.object({
        file: Joi.string()
          .min(1)
          .max(500)
          .pattern(/^[^<>&|;$`]*$/)
          .required()
      }),

      generate: Joi.object({
        type: Joi.string()
          .valid('tests', 'documentation', 'docs', 'component')
          .required(),
        target: Joi.string()
          .min(1)
          .max(500)
          .pattern(/^[^<>&|;$`]*$/)
          .required()
      })
    };
  }

  public static getInstance(): SecurityManager {
    if (!SecurityManager.instance) {
      SecurityManager.instance = new SecurityManager();
    }
    return SecurityManager.instance;
  }

  public validateInput(command: string, input: any): { valid: boolean; error?: string } {
    if (!this.config.enableInputValidation) {
      return { valid: true };
    }

    try {
      // Check command is allowed
      if (!this.config.allowedCommands.includes(command)) {
        const error = `Command '${command}' is not allowed`;
        logSecurity('blocked_command', { command, input });
        metricsCollector.recordError('blocked_command', command);
        return { valid: false, error };
      }

      // Get schema for command
      const schema = this.schemas[command];
      if (!schema) {
        return { valid: true }; // No specific validation for this command
      }

      // Validate input
      const { error } = schema.validate(input, { abortEarly: false });
      if (error) {
        const errorMessage = error.details.map((d: any) => d.message).join(', ');
        logSecurity('invalid_input', { command, input, error: errorMessage });
        metricsCollector.recordError('invalid_input', command);
        return { valid: false, error: errorMessage };
      }

      // Check for blocked patterns
      const inputString = JSON.stringify(input);
      for (const pattern of this.config.blockedPatterns) {
        if (pattern.test(inputString)) {
          const error = 'Input contains blocked patterns';
          logSecurity('blocked_pattern', { command, input, pattern: pattern.toString() });
          metricsCollector.recordError('blocked_pattern', command);
          return { valid: false, error };
        }
      }

      // Sanitize input
      const sanitized = this.sanitizeInput(input);
      if (JSON.stringify(sanitized) !== JSON.stringify(input)) {
        logger.warn('Input was sanitized', { command, original: input, sanitized });
      }

      return { valid: true };
    } catch (err) {
      const error = `Validation error: ${(err as Error).message}`;
      logSecurity('validation_error', { command, input, error });
      metricsCollector.recordError('validation_error', command);
      return { valid: false, error };
    }
  }

  public checkRateLimit(identifier: string): { allowed: boolean; remainingRequests: number } {
    if (!this.config.enableRateLimiting) {
      return { allowed: true, remainingRequests: this.config.maxRequestsPerMinute };
    }

    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000; // 1-minute windows
    const windowKey = `${identifier}:${windowStart}`;

    const current = this.requestCounts.get(windowKey) || { count: 0, resetTime: windowStart + 60000 };

    if (now > current.resetTime) {
      // Reset window
      this.requestCounts.set(windowKey, { count: 1, resetTime: windowStart + 60000 });
      return { allowed: true, remainingRequests: this.config.maxRequestsPerMinute - 1 };
    }

    if (current.count >= this.config.maxRequestsPerMinute) {
      logSecurity('rate_limit_exceeded', { identifier, count: current.count });
      metricsCollector.recordError('rate_limit_exceeded', 'unknown');
      return { allowed: false, remainingRequests: 0 };
    }

    current.count++;
    const remaining = Math.max(0, this.config.maxRequestsPerMinute - current.count);
    return { allowed: true, remainingRequests: remaining };
  }

  public sanitizeInput(input: any): any {
    if (typeof input === 'string') {
      return validator.escape(input);
    }

    if (Array.isArray(input)) {
      return input.map(item => this.sanitizeInput(item));
    }

    if (typeof input === 'object' && input !== null) {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(input)) {
        sanitized[key] = this.sanitizeInput(value);
      }
      return sanitized;
    }

    return input;
  }

  public auditLog(action: string, details: Record<string, any>): void {
    logSecurity(action, {
      timestamp: new Date().toISOString(),
      ...details
    });
  }

  public getSecurityStatus(): {
    config: SecurityConfig;
    activeRateLimits: number;
    blockedPatternsCount: number;
  } {
    return {
      config: this.config,
      activeRateLimits: this.requestCounts.size,
      blockedPatternsCount: this.config.blockedPatterns.length
    };
  }

  public resetRateLimits(): void {
    this.requestCounts.clear();
    logger.info('Rate limits reset');
  }
}

export const securityManager = SecurityManager.getInstance();
