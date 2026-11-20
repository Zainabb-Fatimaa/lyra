import pg from 'pg';
import { createApp } from './app.js';
import { memoryStore, pgStore } from './store.js';
import { fetchLyrics, nllbTranslator, ollamaTranslator, openaiCompatTranslator, chainTranslators, searchLrclib, youtubeFinder } from './lib.js';

// TRANSLATORS=llm,ollama,nllb sets the order; each backs up the one before it.
const ENGINES = { llm: openaiCompatTranslator, ollama: ollamaTranslator, nllb: nllbTranslator };
const order = (process.env.TRANSLATORS || (process.env.LLM_API_KEY ? 'llm,ollama,nllb' : 'ollama,nllb')).split(',').map(s => s.trim()).filter(Boolean);
const translate = chainTranslators(order.map(k => { if (!ENGINES[k]) throw new Error(`Unknown translator "${k}"`); return ENGINES[k](); }));

let store;
if (process.env.DATABASE_URL) {
  const url = process.env.DATABASE_URL;
  store = pgStore(new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } }));
  await store.init();
  console.log('Using Postgres');
} else {
  store = memoryStore(process.env.DB_PATH || 'lyra-cache.json');
  console.log('No DATABASE_URL: using a local JSON cache file');
}

const port = process.env.PORT || 3000;
createApp({ store, getLyrics: fetchLyrics, translate, searchSongs: searchLrclib, findVideo: youtubeFinder() }).listen(port, () => console.log('Lyra running on port ' + port));
