export function parseLrc(text) {
  const out = [];
  for (const l of text.split('\n')) {
    const m = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (m && m[3].trim()) out.push({ start_ms: Math.round((+m[1] * 60 + +m[2]) * 1000), orig: m[3].trim() });
  }
  return out;
}

export function detect(t) {
  if (/[\u0900-\u097F]/.test(t)) return 'hi';
  if (/[\u0400-\u04FF]/.test(t)) return 'ru';
  if (/[\u0600-\u06FF]/.test(t)) {
    if (/[\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06C3\u06D2]/.test(t)) return 'ur'; // letters only Urdu uses
    return /[\u067E\u0686\u0698\u06AF\u06CC\u06A9]/.test(t) ? 'fa' : 'ar';
  }
  if (/[ğşıİĞŞ]/.test(t)) return 'tr';
  if (/[ñ¿¡áéíóúü]/i.test(t) || /\b(hola|buenos|buenas|amor|corazon|corazón|cancion|canción|quiero|tienes|somos|estoy|eres|porque|cuando|siempre|nunca)\b/i.test(t)) return 'es';
  return 'other';
}

//  Lyrics provider (adapter): swap for Musixmatch/LyricFind when licensed.
export async function fetchLyrics(title, artist, duration) {
  const q = new URLSearchParams({ track_name: title, artist_name: artist, duration });
  let r = await fetch('https://lrclib.net/api/get?' + q, { headers: { 'User-Agent': 'Lyra/1.0' } });
  let j = r.ok ? await r.json() : null;
  if (!j) {
    r = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(`${title} ${artist}`));
    j = r.ok ? (await r.json())[0] : null;
  }
  if (!j) return { lines: [], synced: 0 };
  if (j.syncedLyrics) {
    const lines = parseLrc(j.syncedLyrics);
    if (lines.length) return { lines, synced: 1 };
  }
  const lines = (j.plainLyrics || '').split('\n').filter(s => s.trim()).map(s => ({ start_ms: null, orig: s.trim() }));
  if (!lines.length) return { lines: [], synced: 0 };
  const durationMs = Number(duration) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return { lines, synced: 0 };
  const step = durationMs / lines.length;
  return { lines: lines.map((line, i) => ({ ...line, start_ms: Math.round(i * step) })), synced: 1 };
}

// Translation engine (strategy): your local NLLB model, served by nllb_server.py.
export const NLLB_CODES = { ar: 'arb_Arab', fa: 'pes_Arab', ur: 'urd_Arab', hi: 'hin_Deva', tr: 'tur_Latn', es: 'spa_Latn', ru: 'rus_Cyrl' };

export function nllbTranslator(url = process.env.NLLB_URL || 'http://127.0.0.1:8001') {
  return async (lines, lang) => {
    const out = [];
    for (let i = 0; i < lines.length; i += 16) {
      const texts = lines.slice(i, i + 16).map(l => l.orig);
      let r;
      try {
        r = await fetch(url + '/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src: NLLB_CODES[lang], texts }) });
      } catch { throw new Error('Cannot reach the NLLB service. Start it with: python nllb_server.py'); }
      if (!r.ok) throw new Error(`NLLB service error ${r.status}`);
      const { translations } = await r.json();
      if (!Array.isArray(translations) || translations.length !== texts.length) throw new Error('NLLB returned the wrong number of lines');
      translations.forEach(en => out.push({ en, note: '' }));
    }
    return out;
  };
}

// Fallback translator (strategy): Ollama also writes idiom notes.
const NAMES = { ar: 'Arabic', fa: 'Persian', ur: 'Urdu', tr: 'Turkish', hi: 'Hindi', es: 'Spanish', ru: 'Russian' };
const SYSTEM = lang => `You translate ${NAMES[lang]} song lyrics into natural, poetic English. Keep imagery and emotion; never translate word for word. The input is a JSON array of lines. Reply with JSON only: {"lines":[{"en":"translation","note":"short idiom or cultural note, or empty string"}]} with exactly one object per input line, in the same order, even for repeated or very short lines. Never merge or split lines.`;

function readLines(content, n, who) {
  let j;
  try { j = JSON.parse(String(content).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')); } catch { throw new Error(`${who} returned invalid JSON`); }
  const arr = Array.isArray(j) ? j : j.lines;
  if (!Array.isArray(arr) || arr.length !== n) throw new Error(`${who} returned the wrong number of lines`);
  return arr.map(x => typeof x === 'string' ? { en: x, note: '' } : { en: String(x.en || ''), note: String(x.note || '') });
}

// 8 lines per request; a misaligned batch is retried line by line so translations never drift.
const batched = ask => async (lines, lang) => {
  const out = [];
  for (let i = 0; i < lines.length; i += 8) {
    const texts = lines.slice(i, i + 8).map(l => l.orig);
    try { out.push(...await ask(texts, lang)); }
    catch (e) {
      if (!/wrong number/.test(e.message) || texts.length === 1) throw e;
      for (const t of texts) out.push(...await ask([t], lang));
    }
  }
  return out;
};

export function ollamaTranslator(url = process.env.OLLAMA_URL || 'http://localhost:11434', model = process.env.OLLAMA_MODEL || 'qwen2.5:7b') {
  return batched(async (texts, lang) => {
    let r;
    try {
      r = await fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: false, format: 'json', options: { temperature: 0.2 }, messages: [{ role: 'system', content: SYSTEM(lang) }, { role: 'user', content: JSON.stringify(texts) }] }) });
    } catch { throw new Error('Cannot reach Ollama. Is it running?'); }
    if (!r.ok) throw new Error(`Ollama error ${r.status}. Is "${model}" pulled?`);
    return readLines((await r.json()).message?.content, texts.length, 'Ollama');
  });
}

// Any OpenAI-compatible host: Groq, OpenRouter, Hugging Face router, Together...
export function openaiCompatTranslator({ baseUrl = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1', apiKey = process.env.LLM_API_KEY, model = process.env.LLM_MODEL || 'llama-3.3-70b-versatile' } = {}) {
  return batched(async (texts, lang) => {
    if (!apiKey) throw new Error('LLM_API_KEY is not set');
    let r;
    try {
      r = await fetch(baseUrl + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }, body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYSTEM(lang) }, { role: 'user', content: JSON.stringify(texts) }] }) });
    } catch { throw new Error('Cannot reach the translation API'); }
    if (r.status === 401 || r.status === 403) throw new Error('The translation API key was rejected');
    if (r.status === 429) throw new Error('Translation API rate limit reached');
    if (!r.ok) throw new Error(`Translation API error ${r.status} for ${model}; check LLM_BASE_URL and LLM_MODEL`);
    return readLines((await r.json()).choices?.[0]?.message?.content, texts.length, 'The translation API');
  });
}

export const withFallback = (primary, secondary, log = console.warn) => async (lines, lang) => {
  try { return await primary(lines, lang); }
  catch (e1) {
    log('Primary translator failed, falling back:', e1.message);
    try { return await secondary(lines, lang); }
    catch (e2) { throw new Error(`${e1.message} | Fallback also failed: ${e2.message}`); }
  }
};

// NLLB first; languages listed in ollamaFirst (e.g. ['fa']) try Ollama first. Either one backs up the other.
export const routedTranslator = ({ nllb, ollama, ollamaFirst = [], log }) => (lines, lang) =>
  (ollamaFirst.includes(lang) ? withFallback(ollama, nllb, log) : withFallback(nllb, ollama, log))(lines, lang);

// Song search against the open LRCLIB library (every result has lyrics).
export async function searchLrclib(q) {
  if (!q || !q.trim()) return [];
  const r = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'Lyra/1.0' } });
  if (!r.ok) throw new Error('Lyrics search failed');
  return (await r.json()).filter(x => x.trackName && x.artistName).slice(0, 8)
    .map(x => ({ id: x.id, trackName: x.trackName, artistName: x.artistName, duration: Math.round(x.duration || 0) }));
}

export const chainTranslators = (list, log) => list.reduce((a, b) => withFallback(a, b, log));

// Finds the most likely YouTube video for a song (official Data API; needs YOUTUBE_API_KEY).
export const isoSeconds = iso => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso) || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
export function youtubeFinder(apiKey = process.env.YOUTUBE_API_KEY) {
  return async (title, artist, duration) => {
    if (!apiKey) return null;
    const r = await fetch('https://www.googleapis.com/youtube/v3/search?' + new URLSearchParams({ part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '5', q: `${artist} ${title}`, key: apiKey }));
    if (!r.ok) throw new Error(`YouTube search error ${r.status}`);
    const ids = ((await r.json()).items || []).map(i => i.id?.videoId).filter(Boolean);
    if (!ids.length) return null;
    if (!duration) return ids[0];
    const d = await fetch('https://www.googleapis.com/youtube/v3/videos?' + new URLSearchParams({ part: 'contentDetails', id: ids.join(','), key: apiKey }));
    if (!d.ok) return ids[0];
    const best = ((await d.json()).items || []).map(v => ({ id: v.id, diff: Math.abs(isoSeconds(v.contentDetails.duration) - duration) })).sort((a, b) => a.diff - b.diff)[0];
    return best ? best.id : ids[0]; // closest length to the studio version
  };
}
