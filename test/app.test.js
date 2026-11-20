import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { memoryStore } from '../store.js';

const AR = [{ start_ms: 1000, orig: 'مرحبا يا قلبي' }, { start_ms: 5000, orig: 'أحبك كثيرا' }];

async function start(over = {}) {
  const calls = { lyrics: 0, translate: 0 };
  const store = memoryStore();
  const app = createApp({
    store,
    getLyrics: async () => { calls.lyrics++; return { lines: AR, synced: 1 }; },
    translate: async lines => { calls.translate++; return lines.map(l => ({ en: 'EN ' + l.orig, note: 'n' })); },
    ...over,
  });
  const server = app.listen(0); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, store, base, get: (id = 't1') => fetch(`${base}/api/song?id=${id}&title=Song&artist=Artist&duration=200`), close: () => { server.closeAllConnections?.(); server.close(); } };
}

test('returns translated lines in order with language and sync flag', async t => {
  const s = await start(); t.after(s.close);
  const j = await (await s.get()).json();
  assert.equal(j.lang, 'ar'); assert.equal(j.synced, 1);
  assert.deepEqual(j.lines.map(l => l.orig), AR.map(l => l.orig));
  assert.equal(j.lines[0].en, 'EN ' + AR[0].orig);
  assert.equal(j.lines[1].start_ms, 5000);
});

test('translates a song once, then serves it from the store', async t => {
  const s = await start(); t.after(s.close);
  const a = await (await s.get()).json(); const b = await (await s.get()).json();
  assert.deepEqual(a.lines, b.lines); assert.equal(a.cached, false); assert.equal(b.cached, true);
  assert.equal(s.calls.lyrics, 1); assert.equal(s.calls.translate, 1);
});

test('reuses a translation when title and artist match another track id', async t => {
  const s = await start(); t.after(s.close);
  const first = await (await s.get('first')).json();
  const second = await (await s.get('second')).json();
  assert.deepEqual(second.lines, first.lines);
  assert.equal(s.calls.lyrics, 1); assert.equal(s.calls.translate, 1);
});

test('same song spelled differently (case, accents, feat., remaster tags) is a cache hit', async t => {
  const s = await start(); t.after(s.close);
  const q = (id, title, artist) => fetch(`${s.base}/api/song?` + new URLSearchParams({ id, title, artist, duration: '200' }));
  const first = await (await q('a', 'Habibi Ya Nour El Ain', 'Amr Diab')).json();
  for (const [id, title, artist] of [['b', 'habibi ya nour el-ain (Remastered 2011)', 'AMR DIAB'], ['c', 'Habibi Ya Nour El Ain - 2011 Remaster', 'Amr  Diab'], ['d', 'Habibi Ya Nour El Ain (feat. Someone)', 'Amr Diab']]) {
    const r = await q(id, title, artist); assert.equal(r.headers.get('x-lyra-cache'), 'hit');
    const j = await r.json(); assert.equal(j.cached, true); assert.deepEqual(j.lines, first.lines);
  }
  assert.equal(s.calls.lyrics, 1); assert.equal(s.calls.translate, 1);
});

test('a different artist or a live version is NOT mistaken for the cached song', async t => {
  const s = await start(); t.after(s.close);
  const q = (id, title, artist) => fetch(`${s.base}/api/song?` + new URLSearchParams({ id, title, artist, duration: '200' }));
  await q('a', 'Song', 'Artist');
  assert.equal((await q('b', 'Song', 'Other Artist')).headers.get('x-lyra-cache'), 'miss');
  assert.equal((await q('c', 'Song (Live)', 'Artist')).headers.get('x-lyra-cache'), 'miss');
  assert.equal(s.calls.translate, 3);
});

test('songs with no lyrics found are not cached, so they are retried later', async t => {
  let n = 0;
  const s = await start({ getLyrics: async () => { n++; return { lines: [], synced: 0 }; } }); t.after(s.close);
  assert.deepEqual((await (await s.get()).json()).lines, []); await s.get();
  assert.equal(n, 2); assert.equal(await s.store.getSong('t1'), null);
});

test('concurrent requests for a new song share one translation job', async t => {
  let n = 0;
  const s = await start({ translate: async lines => { n++; await new Promise(r => setTimeout(r, 60)); return lines.map(() => ({ en: 'x', note: '' })); } }); t.after(s.close);
  const rs = await Promise.all(Array.from({ length: 5 }, () => s.get()));
  assert.ok(rs.every(r => r.status === 200)); assert.equal(n, 1);
  assert.equal((await s.store.getSong('t1')).lines.length, 2);
});

test('a failed translation saves nothing and a retry succeeds', async t => {
  let n = 0;
  const s = await start({ translate: async lines => { if (n++ === 0) throw new Error('boom'); return lines.map(() => ({ en: 'ok', note: '' })); } }); t.after(s.close);
  const r1 = await s.get(); assert.equal(r1.status, 500); assert.match((await r1.json()).error, /boom/);
  assert.equal(await s.store.getSong('t1'), null);
  assert.equal((await s.get()).status, 200);
});

test('reports a missing-lyrics error', async t => {
  const s = await start({ getLyrics: async () => { throw new Error('No lyrics found for this track'); } }); t.after(s.close);
  const r = await s.get(); assert.equal(r.status, 500); assert.match((await r.json()).error, /No lyrics/);
});

test('serves instrumental songs without lyrics', async t => {
  const s = await start({ getLyrics: async () => ({ lines: [], synced: 0 }) }); t.after(s.close);
  const r = await s.get(); assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.synced, 0); assert.deepEqual(j.lines, []);
});

test('non-Arabic-script, non-Turkish lyrics skip translation', async t => {
  let n = 0;
  const s = await start({ getLyrics: async () => ({ lines: [{ start_ms: null, orig: 'Hello darling' }], synced: 0 }), translate: async () => { n++; return []; } }); t.after(s.close);
  const j = await (await s.get()).json();
  assert.equal(j.lang, 'other'); assert.equal(j.synced, 0); assert.equal(n, 0);
});

test('Hindi lyrics are detected and translated', async t => {
  let seenLang;
  const hindi = [{ start_ms: null, orig: 'तुम मेरे दिल के करीब हो' }];
  const s = await start({
    getLyrics: async () => ({ lines: hindi, synced: 0 }),
    translate: async (lines, lang) => { seenLang = lang; return lines.map(() => ({ en: 'You are close to my heart', note: '' })); },
  }); t.after(s.close);
  const j = await (await s.get()).json();
  assert.equal(j.lang, 'hi');
  assert.equal(seenLang, 'hi');
  assert.equal(j.lines[0].en, 'You are close to my heart');
});

test('old Hindi cache entries marked as other are rebuilt', async t => {
  const hindi = [{ start_ms: null, orig: 'तुम मेरे दिल के करीब हो' }];
  let translations = 0;
  const s = await start({
    getLyrics: async () => ({ lines: hindi, synced: 0 }),
    translate: async (lines, lang) => { translations++; assert.equal(lang, 'hi'); return lines.map(() => ({ en: 'translated', note: '' })); },
  }); t.after(s.close);
  await s.store.saveSong({ track_id: 't1', title: 'Song', artist: 'Artist', lang: 'other', synced: 0, lines: hindi });
  const j = await (await s.get()).json();
  assert.equal(j.lang, 'hi');
  assert.equal(j.lines[0].en, 'translated');
  assert.equal(translations, 1);
});

test('rejects requests without id and title', async t => {
  const s = await start(); t.after(s.close);
  assert.equal((await fetch(s.base + '/api/song')).status, 400);
});

test('search endpoint returns provider results and handles empty queries', async t => {
  const s = await start({ searchSongs: async q => q ? [{ id: 1, trackName: 'T', artistName: 'A', duration: 100 }] : [] }); t.after(s.close);
  assert.equal((await (await fetch(s.base + '/api/search?q=bad')).json())[0].trackName, 'T');
  assert.deepEqual(await (await fetch(s.base + '/api/search')).json(), []);
});

test('limits new-song translations per client but cached songs stay free', async t => {
  const s = await start({ buildsPerHour: 1 }); t.after(s.close);
  assert.equal((await s.get('a')).status, 200);
  assert.equal((await fetch(`${s.base}/api/song?id=b&title=Other&artist=Artist&duration=200`)).status, 429);
  assert.equal((await s.get('a')).status, 200);
});

test('healthz responds ok', async t => {
  const s = await start(); t.after(s.close);
  assert.equal(await (await fetch(s.base + '/healthz')).text(), 'ok');
});

test('memoryStore persists to a file and keeps the first saved version', async () => {
  const f = join(tmpdir(), `lyra-${Date.now()}.json`);
  const a = memoryStore(f);
  await a.saveSong({ track_id: 'x', title: 'T', artist: 'A', lang: 'ar', synced: 1, lines: [{ orig: 'o', en: 'first' }] });
  await a.saveSong({ track_id: 'x', title: 'T', artist: 'A', lang: 'ar', synced: 1, lines: [{ orig: 'o', en: 'second' }] });
  assert.equal((await memoryStore(f).getSong('x')).lines[0].en, 'first');
});

test('video lookup finds once, caches in the store and handles misses', async t => {
  let n = 0;
  const s = await start({ findVideo: async () => { n++; return 'abcdefghijk'; } }); t.after(s.close);
  const url = `${s.base}/api/video?id=lrclib:1&title=T&artist=A&duration=200`;
  assert.equal((await (await fetch(url)).json()).videoId, 'abcdefghijk');
  assert.equal((await (await fetch(url)).json()).videoId, 'abcdefghijk');
  assert.equal(n, 1);
  const m = await start(); t.after(m.close);
  assert.equal((await (await fetch(`${m.base}/api/video?id=x&title=T`)).json()).videoId, null);
  assert.equal((await fetch(`${m.base}/api/video`)).status, 400);
});

test('memoryStore remembers video ids across restarts', async () => {
  const f = join(tmpdir(), `lyra-v-${Date.now()}.json`);
  await memoryStore(f).saveVideo('lrclib:1', 'abcdefghijk');
  assert.equal(await memoryStore(f).getVideo('lrclib:1'), 'abcdefghijk');
});

test('serves the player at / and keeps /full.html working', async t => {
  const s = await start(); t.after(s.close);
  assert.match(await (await fetch(s.base + '/')).text(), /Every song is a letter/);
  assert.equal((await fetch(s.base + '/full.html')).status, 200);
});
