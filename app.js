import express from 'express';
import { fileURLToPath } from 'node:url';
import { detect } from './lib.js';
import { songKey } from './songkey.js';

// Everything external is injected, so tests run without Spotify, Postgres or an LLM.
export function createApp({ store, getLyrics, translate, searchSongs = async () => [], findVideo = async () => null, buildsPerHour = 30 }) {
  async function build({ id, title, artist, duration }) {
    const { lines, synced } = await getLyrics(title, artist, duration);
    const lang = detect(lines.map(l => l.orig).join(' '));
    // No lyrics found: answer without saving, so the song is looked up again next time instead of being cached as empty.
    if (!lines.length) return { track_id: id, title, artist, lang, synced: 0, lines: [] };
    const tr = lang === 'other' ? lines.map(l => ({ en: l.orig, note: '' })) : await translate(lines, lang);
    if (tr.length !== lines.length) throw new Error('Translation line count mismatch');
    await store.saveSong({ track_id: id, title, artist, lang, synced, lines: lines.map((l, n) => ({ start_ms: l.start_ms, orig: l.orig, en: tr[n].en, note: tr[n].note })) });
    return null;
  }

  const limiter = max => { const m = new Map(); return ip => { const now = Date.now(), a = (m.get(ip) || []).filter(t => now - t < 3600e3); if (a.length >= max) { m.set(ip, a); return false; } a.push(now); m.set(ip, a); return true; }; };
  const allow = limiter(buildsPerHour), allowVideo = limiter(60); // per-IP hourly guards (the YouTube search quota is small)
  const inflight = new Map(); // single-flight: concurrent requests share one translation job

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.get('/healthz', (_, res) => res.send('ok'));
  app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
  app.get('/api/search', async (req, res) => {
    try { res.json(await searchSongs(String(req.query.q || ''))); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/song', async (req, res) => {
    const { id, title, artist, duration } = req.query;
    if (!id || !title) return res.status(400).json({ error: 'id and title required' });
    try {
      // 1) same track id, 2) same title + artist under any id (normalised), 3) translate once and save.
      let s = await store.getSong(id), cached = !!s;
      if (!s && artist && store.getSongByIdentity) { s = await store.getSongByIdentity(title, artist); cached = !!s; }
      if (s && s.lang === 'other' && Array.isArray(s.lines) && s.lines.length) {
        const detected = detect(s.lines.map(l => l.orig).join(' '));
        if (detected !== 'other') s = null, cached = false;
      }
      if (!s) {
        const key = songKey(title, artist || '');
        if (!inflight.has(key)) {
          if (!allow(req.ip)) return res.status(429).json({ error: 'Too many new songs from your connection. Try again in a while.' });
          inflight.set(key, build({ id, title, artist: artist || '', duration }).finally(() => inflight.delete(key)));
        }
        const unsaved = await inflight.get(key);
        s = unsaved || await store.getSong(id) || (artist && store.getSongByIdentity ? await store.getSongByIdentity(title, artist) : null);
      }
      res.set('X-Lyra-Cache', cached ? 'hit' : 'miss');
      res.json(s && { ...s, cached });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/video', async (req, res) => {
    const { id, title, artist, duration } = req.query;
    if (!id || !title) return res.status(400).json({ error: 'id and title required' });
    try {
      let v = await store.getVideo(id);
      if (!v) {
        if (!allowVideo(req.ip)) return res.status(429).json({ error: 'Too many video lookups. Paste the YouTube link instead.' });
        v = await findVideo(String(title), String(artist || ''), Number(duration) || 0);
        if (v) await store.saveVideo(id, v);
      }
      res.json({ videoId: v || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  return app;
}
