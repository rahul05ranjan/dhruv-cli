import { ChatOllama } from '@langchain/ollama';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.join(process.cwd(), '.dhruv-cache');
const MAX_CACHE_SIZE = 100;
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

interface LangChainConfig {
  model: string;
  temperature?: number;
  streaming?: boolean;
}

interface AIRequest {
  prompt: string;
  context?: string;
  systemMessage?: string;
  model?: string;
  onToken?: (token: string) => void;
}

// System message templates
const SYSTEM_MESSAGES = {
  explain: `You are a knowledgeable programming instructor and technical expert. Your role is to provide clear, accurate, and practical explanations of technical concepts.

Guidelines:
- Provide structured explanations with clear sections
- Use practical examples where helpful
- Focus on concepts that developers need to understand
- Avoid unnecessary jargon, but use precise technical terminology
- Keep responses concise but comprehensive
- Format code examples clearly
- Provide context for why something matters

Output Format:
- Use plain text with clear structure
- Use bullet points for lists
- Use numbered steps for procedures
- Separate code examples with clear labels
- Avoid markdown formatting except for code blocks when absolutely necessary`,

  suggest: `You are an expert software architect and senior developer providing actionable recommendations and best practices.

Guidelines:
- Provide specific, actionable suggestions
- Prioritize recommendations by importance
- Include practical implementation steps
- Mention relevant tools, libraries, or patterns
- Consider performance, maintainability, and scalability
- Provide concrete examples where helpful
- Focus on industry best practices

Output Format:
- Use clear numbered or bulleted lists
- Separate different types of suggestions
- Provide brief explanations for each recommendation
- Use plain text formatting for better readability`,

  fix: `You are a debugging expert and problem-solving specialist helping developers resolve technical issues.

Guidelines:
- Analyze the problem systematically
- Identify the root cause
- Provide step-by-step solutions
- Include preventive measures
- Show corrected code examples
- Explain why the fix works
- Suggest testing approaches

Output Format:
- Start with problem analysis
- Provide clear solution steps
- Show before/after code examples
- Use plain text with clear structure
- Avoid complex markdown formatting`,

  review: `You are a senior code reviewer focused on code quality, best practices, and maintainability.

Guidelines:
- Analyze code structure and patterns
- Identify potential issues or improvements
- Comment on performance implications
- Suggest refactoring opportunities
- Check for security considerations
- Evaluate readability and maintainability
- Provide constructive feedback

Output Format:
- Organize feedback by categories (Structure, Performance, Security, etc.)
- Use clear, actionable language
- Provide specific line-by-line suggestions where relevant
- Use plain text formatting for better CLI readability`,

  optimize: `You are a performance optimization expert specializing in code efficiency and best practices.

Guidelines:
- Focus on measurable performance improvements
- Consider different types of optimization (runtime, memory, bundle size, etc.)
- Provide specific, implementable suggestions
- Explain the impact of each optimization
- Consider trade-offs between performance and maintainability
- Suggest profiling and measurement approaches

Output Format:
- Categorize optimizations by type
- Provide clear before/after examples
- Include estimated impact where possible
- Use structured plain text formatting`,

  security: `You are a cybersecurity expert specializing in application security and secure coding practices.

Guidelines:
- Identify potential security vulnerabilities
- Provide remediation steps
- Suggest secure coding patterns
- Consider common attack vectors
- Recommend security tools and practices
- Focus on practical security measures
- Explain security implications

Output Format:
- Categorize findings by severity
- Provide clear remediation steps
- Use plain text formatting for better readability
- Include references to security standards where relevant`,

  generate: `You are a code generation specialist creating high-quality, well-structured code.

Guidelines:
- Generate clean, readable code
- Follow established conventions
- Include appropriate comments
- Consider edge cases
- Use proper error handling
- Follow best practices for the target language
- Generate comprehensive test cases when requested

Output Format:
- Provide clean code without excessive markdown
- Use minimal formatting for better CLI display
- Include brief explanations only when necessary
- Focus on practical, working code`
};

function getCacheKey(prompt: string, model?: string, systemMessage?: string): string {
  const hash = crypto.createHash('sha256')
    .update(`${model || 'default'}:${systemMessage || ''}:${prompt}`)
    .digest('hex');
  return path.join(CACHE_DIR, hash);
}

function cleanupCache(): void {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    const now = Date.now();
    
    const validFiles = files.filter(file => {
      const filePath = path.join(CACHE_DIR, file);
      const stats = fs.statSync(filePath);
      const isExpired = now - stats.mtime.getTime() > CACHE_EXPIRY;
      
      if (isExpired) {
        fs.unlinkSync(filePath);
        return false;
      }
      return true;
    });
    
    if (validFiles.length > MAX_CACHE_SIZE) {
      const sortedFiles = validFiles
        .map(file => ({
          name: file,
          path: path.join(CACHE_DIR, file),
          mtime: fs.statSync(path.join(CACHE_DIR, file)).mtime.getTime()
        }))
        .sort((a, b) => a.mtime - b.mtime);
      
      const toRemove = sortedFiles.slice(0, sortedFiles.length - MAX_CACHE_SIZE);
      toRemove.forEach(file => fs.unlinkSync(file.path));
    }
  } catch (error) {
    // Ignore cleanup errors
  }
}

export async function askLangChain({
  prompt,
  context,
  systemMessage,
  model = 'gemma3:270m',
  onToken
}: AIRequest): Promise<string> {
  const cacheKey = getCacheKey(prompt, model, systemMessage);
  
  // Check cache first
  if (fs.existsSync(cacheKey)) {
    const cached = fs.readFileSync(cacheKey, 'utf-8');
    if (onToken) {
      // Simulate streaming for cached responses
      const words = cached.split(' ');
      for (const word of words) {
        onToken(word + ' ');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    return cached;
  }

  try {
    // Use direct HTTP request to Ollama to avoid LangChain template issues
    const http = await import('http');

    return new Promise((resolve, reject) => {
      const fullPrompt = context
        ? `System: ${systemMessage}\n\nContext: ${context}\n\nQuery: ${prompt}`
        : `System: ${systemMessage}\n\nQuery: ${prompt}`;

      const postData = JSON.stringify({
        model: model,
        prompt: fullPrompt,
        stream: !!onToken
      });

      const req = http.request({
        hostname: 'localhost',
        port: 11434,
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';

        // Check for HTTP error status codes
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Ollama API error: HTTP ${res.statusCode} ${res.statusMessage || ''}`));
          return;
        }

        res.on('data', (chunk) => {
          data += chunk;
          if (onToken) {
            try {
              const parsed = JSON.parse(chunk.toString());
              if (parsed.response) {
                onToken(parsed.response);
              }
            } catch (e) {
              // Ignore JSON parse errors for streaming
            }
          }
        });

        res.on('end', () => {
          try {
            if (onToken) {
              resolve(''); // Return empty string for streaming mode
            } else {
              const response = JSON.parse(data);
              
              // Check if Ollama returned an error
              if (response.error) {
                reject(new Error(`Ollama error: ${response.error}`));
                return;
              }
              
              const result = response.response || '';
              
              // Treat empty responses as errors for nonexistent models
              if (!result.trim()) {
                reject(new Error(`Model '${model}' not found or returned empty response. Please install it: ollama pull ${model}`));
                return;
              }
              
              fs.writeFileSync(cacheKey, result);
              resolve(result);
            }
          } catch (e) {
            reject(new Error('Failed to parse Ollama response'));
          }
        });
      });

      req.on('error', (err) => {
        let errorMessage = err.message || 'Unknown error';
        if (errorMessage.includes('ECONNREFUSED')) {
          errorMessage = 'Connection refused - Ollama may not be running';
        } else if (errorMessage.includes('ENOTFOUND')) {
          errorMessage = 'Host not found - Ollama service unavailable';
        } else if (errorMessage === '' || errorMessage === 'Unknown error') {
          errorMessage = 'Network error occurred while connecting to Ollama';
        }
        reject(new Error(`Ollama request failed: ${errorMessage}`));
      });

      req.write(postData);
      req.end();
    });
  } catch (error) {
    const errorMessage = (error as Error).message;
    if (errorMessage.includes('connect ECONNREFUSED') || errorMessage.includes('fetch failed')) {
      throw new Error('Ollama is not running. Please start Ollama: ollama serve');
    }
    if (errorMessage.includes('model') && errorMessage.includes('not found')) {
      throw new Error(`Model '${model}' not found. Please install it: ollama pull ${model}`);
    }
    throw new Error(`LangChain AI error: ${errorMessage}`);
  }
}

export function getSystemMessage(type: string): string {
  return SYSTEM_MESSAGES[type as keyof typeof SYSTEM_MESSAGES] || SYSTEM_MESSAGES.explain;
}

// Tool definitions for advanced use cases
export const AVAILABLE_TOOLS = {
  file_reader: {
    name: 'file_reader',
    description: 'Read and analyze file contents',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to read'
        }
      },
      required: ['file_path']
    }
  },
  code_analyzer: {
    name: 'code_analyzer',
    description: 'Analyze code for patterns, complexity, and issues',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Code to analyze'
        },
        language: {
          type: 'string',
          description: 'Programming language'
        }
      },
      required: ['code']
    }
  },
  project_analyzer: {
    name: 'project_analyzer',
    description: 'Analyze project structure and dependencies',
    parameters: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Path to the project directory'
        }
      },
      required: ['project_path']
    }
  }
};

export { ChatOllama };
