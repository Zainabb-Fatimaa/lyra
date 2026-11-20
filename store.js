import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { songKey } from './songkey.js';

// Local/dev store: in memory, optionally persisted to a JSON file.
export function memoryStore(file) {
  const songs = new Map(), videos = new Map();
  if (file && existsSync(file)) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      for (const s of Array.isArray(d) ? d : d.songs || []) songs.set(s.track_id, s);
      for (const [k, v] of Object.entries(d.videos || {})) videos.set(k, v);
    } catch {  }
  }
  const persist = () => file && writeFileSync(file, JSON.stringify({ songs: [...songs.values()], videos: Object.fromEntries(videos) }));
  return {
    async getSong(id) { return songs.get(id) || null; },
    async getSongByIdentity(title, artist) {
      const wanted = songKey(title, artist);
      const same = [...songs.values()].filter(s => songKey(s.title, s.artist) === wanted);
      return same.find(s => s.synced) || same[0] || null; // prefer a version that has timings
    },
    async saveSong(s, replace = false) { if (replace || !songs.has(s.track_id)) { songs.set(s.track_id, s); persist(); } },
    async getVideo(id) { return videos.get(id) || null; },
    async saveVideo(id, v) { videos.set(id, v); persist(); },
  };
}

// Production store: Postgres (Neon, Supabase, ...). A song and its lines are saved in one transaction.
export function pgStore(pool) {
  return {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS songs(track_id TEXT PRIMARY KEY,title TEXT,artist TEXT,lang TEXT,synced INTEGER,created_at TIMESTAMPTZ DEFAULT now());
        CREATE TABLE IF NOT EXISTS lines(track_id TEXT NOT NULL,n INTEGER NOT NULL,start_ms INTEGER,orig TEXT,en TEXT,note TEXT,PRIMARY KEY(track_id,n));
        CREATE TABLE IF NOT EXISTS videos(track_id TEXT PRIMARY KEY,video_id TEXT NOT NULL);
        ALTER TABLE songs ADD COLUMN IF NOT EXISTS song_key TEXT;
        CREATE INDEX IF NOT EXISTS songs_song_key_idx ON songs(song_key)`);
      // Older rows have no identity key yet: fill it in once so they join the cache.
      const old = (await pool.query('SELECT track_id,title,artist FROM songs WHERE song_key IS NULL')).rows;
      for (const r of old) await pool.query('UPDATE songs SET song_key=$1 WHERE track_id=$2', [songKey(r.title, r.artist || ''), r.track_id]);
    },
    async getVideo(id) { return (await pool.query('SELECT video_id FROM videos WHERE track_id=$1', [id])).rows[0]?.video_id || null; },
    async saveVideo(id, v) { await pool.query('INSERT INTO videos(track_id,video_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, v]); },
    async getSong(id) {
      const s = (await pool.query('SELECT track_id,title,artist,lang,synced FROM songs WHERE track_id=$1', [id])).rows[0];
      if (!s) return null;
      s.lines = (await pool.query('SELECT start_ms,orig,en,note FROM lines WHERE track_id=$1 ORDER BY n', [id])).rows; // one query, no N+1
      return s;
    },
    async getSongByIdentity(title, artist) {
      const s = (await pool.query('SELECT track_id,title,artist,lang,synced FROM songs WHERE song_key=$1 ORDER BY synced DESC, created_at LIMIT 1', [songKey(title, artist)])).rows[0];
      if (!s) return null;
      s.lines = (await pool.query('SELECT start_ms,orig,en,note FROM lines WHERE track_id=$1 ORDER BY n', [s.track_id])).rows;
      return s;
    },
    async saveSong(s, replace = false) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = replace
          ? await c.query(`INSERT INTO songs(track_id,title,artist,lang,synced,song_key) VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT (track_id) DO UPDATE SET title=EXCLUDED.title,artist=EXCLUDED.artist,lang=EXCLUDED.lang,synced=EXCLUDED.synced,song_key=EXCLUDED.song_key`, [s.track_id, s.title, s.artist, s.lang, s.synced, songKey(s.title, s.artist || '')])
          : await c.query('INSERT INTO songs(track_id,title,artist,lang,synced,song_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [s.track_id, s.title, s.artist, s.lang, s.synced, songKey(s.title, s.artist || '')]);
        if (r.rowCount) {
          if (replace) await c.query('DELETE FROM lines WHERE track_id=$1', [s.track_id]);
          await c.query(`INSERT INTO lines(track_id,n,start_ms,orig,en,note) SELECT $1,n,st,o,e,nt FROM unnest($2::int[],$3::int[],$4::text[],$5::text[],$6::text[]) AS t(n,st,o,e,nt)`,
            [s.track_id, s.lines.map((_, i) => i), s.lines.map(l => l.start_ms), s.lines.map(l => l.orig), s.lines.map(l => l.en), s.lines.map(l => l.note)]);
        }
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    },
  };
}
