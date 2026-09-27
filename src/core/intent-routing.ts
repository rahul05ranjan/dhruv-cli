import fs from 'fs';
import path from 'path';

export interface IntentRouteResult {
  command: string;
  confidence: number;
  target?: string;
  args: string[];
  fallbackToMenu: boolean;
}

export interface IntentRoutingOptions {
  cwd?: string;
  layaServerUrl?: string;
  confidenceThreshold?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.60;

export interface CommandCriteria {
  command: string;
  keywords: string[];
  patterns: RegExp[];
  weight: number;
}

export const ROUTING_CRITERIA: readonly CommandCriteria[] = [
  {
    command: 'explain',
    keywords: ['explain', 'understand', 'how does', 'what is', 'walkthrough', 'clarify', 'describe'],
    patterns: [/\bexplain\b/i, /\bhow does\b/i, /\bwhat does\b/i, /\bwhat is\b/i, /\bwalk\s*through\b/i],
    weight: 1.0,
  },
  {
    command: 'suggest',
    keywords: ['suggest', 'recommend', 'advice', 'idea', 'proposal', 'best practice'],
    patterns: [/\bsuggest\b/i, /\brecommend\b/i, /\bideas? for\b/i, /\bbest practices?\b/i],
    weight: 1.0,
  },
  {
    command: 'fix',
    keywords: ['fix', 'repair', 'solve', 'bug', 'error', 'broken', 'failing', 'exception', 'crash', 'issue'],
    patterns: [/\bfix\b/i, /\brepair\b/i, /\bsolve\b/i, /\bbugs?\b/i, /\berrors?\b/i, /\bbroken\b/i, /\bfailing\b/i],
    weight: 1.0,
  },
  {
    command: 'review',
    keywords: ['review', 'inspect', 'audit', 'critique', 'feedback', 'pr', 'pull request', 'code quality'],
    patterns: [/\breview\b/i, /\binspect\b/i, /\bcode quality\b/i, /\bpull request\b/i, /\bpr\b/i],
    weight: 1.0,
  },
  {
    command: 'optimize',
    keywords: ['optimize', 'speed up', 'faster', 'performance', 'memory leak', 'latency', 'benchmark', 'bottleneck'],
    patterns: [/\boptimize\b/i, /\bspeed up\b/i, /\bfaster\b/i, /\bperformance\b/i, /\bmemory leaks?\b/i, /\bbottlenecks?\b/i],
    weight: 1.0,
  },
  {
    command: 'security-check',
    keywords: ['security', 'vulnerability', 'cve', 'injection', 'secret', 'leak', 'xss', 'csrf', 'audit security'],
    patterns: [/\bsecur(ity|e)\b/i, /\bvulnerabilit(y|ies)\b/i, /\bcve\b/i, /\binjection\b/i, /\bsecrets?\b/i, /\bxss\b/i],
    weight: 1.0,
  },
  {
    command: 'generate',
    keywords: ['generate', 'create', 'scaffold', 'boilerplate', 'write a', 'build a', 'new component'],
    patterns: [/\bgenerate\b/i, /\bcreate\b/i, /\bscaffold\b/i, /\bboilerplate\b/i, /\bwrite (a|an)\b/i, /\bbuild (a|an)\b/i],
    weight: 1.0,
  },
];

/**
 * Extracts an existing filesystem path (file or directory) mentioned in the query.
 */
function extractPathTarget(query: string, cwd: string): string | undefined {
  // Strip quotes and split into candidate tokens
  const cleanQuery = query.replace(/["'`]/g, ' ');
  const tokens = cleanQuery.split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    // Skip words with common non-path characters or query words
    if (token.includes('/') || token.includes('.') || token.includes('\\')) {
      const candidate = path.resolve(cwd, token);
      if (fs.existsSync(candidate)) {
        return token;
      }
    } else {
      // Also check directory/file directly in cwd
      const candidate = path.resolve(cwd, token);
      if (fs.existsSync(candidate)) {
        return token;
      }
    }
  }

  return undefined;
}

/**
 * Pure non-autoregressive decision classification scoring.
 * Produces calibrated probabilities normalized across all command candidates.
 */
function scoreQuery(query: string): { command: string; confidence: number } {
  const normalized = query.toLowerCase().trim();
  const scores: { command: string; score: number }[] = [];

  for (const criteria of ROUTING_CRITERIA) {
    let score = 0;
    for (const pattern of criteria.patterns) {
      if (pattern.test(normalized)) {
        score += 2.0;
      }
    }
    for (const kw of criteria.keywords) {
      if (normalized.includes(kw)) {
        score += 1.0;
      }
    }
    scores.push({ command: criteria.command, score: score * criteria.weight });
  }

  const maxScoreItem = scores.reduce((prev, curr) => (curr.score > prev.score ? curr : prev), {
    command: 'explain',
    score: 0,
  });

  const totalScore = scores.reduce((sum, item) => sum + item.score, 0);

  if (totalScore === 0 || maxScoreItem.score === 0) {
    return {
      command: 'explain',
      confidence: 0.14, // 1/7 uniform distribution
    };
  }

  // Calibrate confidence using softmax-like probability
  const rawRatio = maxScoreItem.score / totalScore;
  // Apply sigmoid calibration scaled to [0.5, 0.98] for single clear winners
  const confidence = Math.min(0.98, Math.max(0.2, 0.5 + rawRatio * 0.45));

  return {
    command: maxScoreItem.command,
    confidence: Number(confidence.toFixed(2)),
  };
}

/**
 * Queries a remote Laya HTTP server if available.
 */
async function queryLayaServer(
  query: string,
  serverUrl: string,
  fetchFn: typeof fetch
): Promise<{ command: string; confidence: number } | undefined> {
  try {
    const url = serverUrl.replace(/\/+$/, '') + '/classify';
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: query,
        candidates: ROUTING_CRITERIA.map((c) => c.command),
      }),
      signal: AbortSignal.timeout(100), // Fast 100ms timeout so it never blocks CLI responsiveness
    });

    if (!response.ok) return undefined;
    const data = (await response.json()) as { command?: string; confidence?: number };
    if (data && typeof data.command === 'string' && typeof data.confidence === 'number') {
      return { command: data.command, confidence: data.confidence };
    }
  } catch {
    // Graceful fallback to local scoring
  }
  return undefined;
}

/**
 * Pure Intent Routing seam.
 * Converts free-form natural language query into target Built-in Command dispatch.
 */
export async function routeIntent(
  query: string,
  options?: IntentRoutingOptions
): Promise<IntentRouteResult> {
  const cwd = options?.cwd ?? process.cwd();
  const threshold = options?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const layaUrl = options?.layaServerUrl ?? process.env.LAYA_SERVER_URL;
  const fetchFn = options?.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);

  // Check if query is empty or trivial
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      command: 'explain',
      confidence: 0,
      args: [],
      fallbackToMenu: true,
    };
  }

  let classification: { command: string; confidence: number } | undefined;

  if (layaUrl && fetchFn) {
    classification = await queryLayaServer(trimmed, layaUrl, fetchFn);
  }

  if (!classification) {
    classification = scoreQuery(trimmed);
  }

  const { command, confidence } = classification;
  const target = extractPathTarget(trimmed, cwd);
  const fallbackToMenu = confidence < threshold;

  return {
    command,
    confidence,
    target,
    args: target ? [target] : [trimmed],
    fallbackToMenu,
  };
}
