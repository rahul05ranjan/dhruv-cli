import { Ollama } from 'ollama';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.join(process.cwd(), '.dhruv-cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function getCacheKey(prompt: string, model?: string) {
  const hash = crypto.createHash('sha256').update(`${model || 'default'}:${prompt}`).digest('hex');
  return path.join(CACHE_DIR, hash);
}

export async function askOllama({ prompt, model, onToken }: { prompt: string; model?: string; onToken?: (token: string) => void }) {
  const cacheKey = getCacheKey(prompt, model);
  if (fs.existsSync(cacheKey)) {
    const cached = fs.readFileSync(cacheKey, 'utf-8');
    if (onToken) onToken(cached);
    return cached;
  }
  try {
    let result = '';
    const ollama = new Ollama();
    for await (const chunk of ollama.generate(model || 'codellama', prompt)) {
      let token = '';
      if (typeof chunk === 'object' && chunk !== null && 'response' in chunk) {
        token = (chunk as unknown as { response: string }).response;
      } else if (typeof chunk === 'string') {
        token = chunk;
      }
      if (onToken) onToken(token);
      result += token;
    }
    fs.writeFileSync(cacheKey, result.trim());
    return result.trim();
  } catch (err) {
    throw new Error('Ollama AI error: ' + (err as Error).message);
  }
}
