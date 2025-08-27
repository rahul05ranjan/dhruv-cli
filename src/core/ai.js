/* global process */
import { Ollama } from 'ollama';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

const CACHE_DIR = path.join(process.cwd(), '.dhruv-cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function getCacheKey(prompt, model) {
  const hash = crypto.createHash('sha256').update(`${model || 'default'}:${prompt}`).digest('hex');
  return path.join(CACHE_DIR, hash);
}

export async function askOllama({ prompt, model, onToken }) {
  const cacheKey = getCacheKey(prompt, model);
  if (fs.existsSync(cacheKey)) {
    const cached = fs.readFileSync(cacheKey, 'utf-8');
    if (onToken) onToken(cached);
    return cached;
  }
  try {
    let result = '';
    const ollama = new Ollama();
    // Await the iterator, then stream
    const iterator = await ollama.generate({ model: model || 'codellama', prompt, stream: true });
    for await (const chunk of iterator) {
      let token = '';
      if (typeof chunk === 'object' && chunk !== null && 'response' in chunk) {
        token = chunk.response;
      } else if (typeof chunk === 'string') {
        token = chunk;
      }
      if (onToken) onToken(token);
      result += token;
    }
    fs.writeFileSync(cacheKey, result.trim());
    return result.trim();
  } catch (err) {
    throw new Error('Ollama AI error: ' + (err && err.message ? err.message : err));
  }
}