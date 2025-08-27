import chalk from 'chalk';
import { highlightCode } from './ux.js';

interface FormatOptions {
  stripMarkdown?: boolean;
  highlightCode?: boolean;
  maxWidth?: number;
}

/**
 * Clean markdown formatting for better CLI display
 */
export function cleanMarkdown(text: string): string {
  return text
    // Remove markdown headers but keep the text
    .replace(/^#{1,6}\s+(.+)$/gm, (match, title) => {
      return chalk.bold.blue(title);
    })
    // Remove bold/italic markdown but keep emphasis
    .replace(/\*\*([^*]+)\*\*/g, (match, text) => chalk.bold(text))
    .replace(/\*([^*]+)\*/g, (match, text) => chalk.italic(text))
    // Remove inline code backticks
    .replace(/`([^`]+)`/g, (match, code) => chalk.yellow(code))
    // Clean up code blocks - extract code but mark it clearly
    .replace(/```(\w+)?\n([\s\S]*?)\n```/g, (match, lang, code) => {
      const language = lang || 'text';
      return `\n${chalk.dim('Code (' + language + '):')}$
${chalk.gray(code.trim())}
`;
    })
    // Remove markdown links but keep the text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Clean up list formatting
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, (match, offset, string) => {
      const lineStart = string.lastIndexOf('\n', offset) + 1;
      const line = string.slice(lineStart, offset + match.length);
      const number = match.match(/\d+/)?.[0] || '1';
      return `${number}. `;
    })
    // Clean up excessive whitespace
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Format code blocks for better CLI display
 */
export function formatCodeBlocks(text: string): string {
  return text.replace(/```(\w+)?\n([\s\S]*?)\n```/g, (match, lang, code) => {
    try {
      const language = lang || 'javascript';
      const highlighted = highlightCode(code.trim(), language);
      return `\n${chalk.dim(`Code (${language}):`)}
${highlighted}
`;
    } catch {
      // Fallback to simple formatting if highlighting fails
      return `\n${chalk.dim(`Code (${lang || 'text'}):`)}
${chalk.gray(code.trim())}
`;
    }
  });
}

/**
 * Format response for optimal CLI display
 */
export function formatResponse(text: string, options: FormatOptions = {}): string {
  const {
    stripMarkdown = true,
    highlightCode: shouldHighlightCode = true,
    maxWidth = 80
  } = options;

  let formatted = text;

  // First, extract and properly format code blocks if highlighting is enabled
  if (shouldHighlightCode) {
    formatted = formatCodeBlocks(formatted);
  }

  // Then clean markdown formatting if requested
  if (stripMarkdown) {
    formatted = cleanMarkdown(formatted);
  }

  // Word wrap for better readability (simple implementation)
  if (maxWidth > 0) {
    formatted = wordWrap(formatted, maxWidth);
  }

  return formatted;
}

/**
 * Simple word wrapping that preserves code blocks and formatting
 */
function wordWrap(text: string, maxWidth: number): string {
  const lines = text.split('\n');
  const wrappedLines: string[] = [];

  for (const line of lines) {
    // Don't wrap code blocks or empty lines
    if (line.trim().startsWith('Code (') || 
        line.trim().length === 0 || 
        line.includes('\u001b[')) { // Contains ANSI codes
      wrappedLines.push(line);
      continue;
    }

    // Simple word wrapping
    const words = line.split(' ');
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) wrappedLines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) wrappedLines.push(currentLine);
  }

  return wrappedLines.join('\n');
}

/**
 * Stream formatted response token by token
 */
export function createFormattedTokenHandler(
  onFormattedToken: (token: string) => void,
  _options: FormatOptions = {}
): (token: string) => void {
  const buffer = '';
  let wordBuffer = '';
  
  return (token: string) => {
    // For each character in the token
    for (const char of token) {
      if (char === ' ' || char === '\n' || char === '\t') {
        // End of word - output the word buffer and the space/newline
        if (wordBuffer) {
          onFormattedToken(wordBuffer);
          wordBuffer = '';
        }
        onFormattedToken(char);
      } else {
        // Add to word buffer
        wordBuffer += char;
      }
    }
    
    // If there's remaining text in word buffer at end of token, output it
    if (wordBuffer && token.endsWith(' ')) {
      onFormattedToken(wordBuffer);
      wordBuffer = '';
    }
  };
}

/**
 * Extract structured information from AI responses
 */
export function extractStructuredInfo(text: string): {
  summary: string;
  codeExamples: Array<{ language: string; code: string }>;
  recommendations: string[];
  issues: string[];
} {
  const codeExamples: Array<{ language: string; code: string }> = [];
  const recommendations: string[] = [];
  const issues: string[] = [];
  
  // Extract code blocks
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)\n```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    codeExamples.push({
      language: match[1] || 'text',
      code: match[2].trim()
    });
  }
  
  // Extract recommendations (lines that suggest actions)
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/^[-*•]\s*(Consider|Use|Try|Implement|Add|Remove|Replace)/i)) {
      recommendations.push(trimmed.replace(/^[-*•]\s*/, ''));
    }
    if (trimmed.match(/^[-*•]\s*(Issue|Problem|Warning|Error|Bug)/i)) {
      issues.push(trimmed.replace(/^[-*•]\s*/, ''));
    }
  }
  
  // Create summary (first paragraph)
  const paragraphs = text.split('\n\n');
  const summary = paragraphs[0]?.replace(/^#+\s*/, '').trim() || '';
  
  return {
    summary,
    codeExamples,
    recommendations,
    issues
  };
}
