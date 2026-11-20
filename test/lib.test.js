import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, detect, fetchLyrics, nllbTranslator } from '../lib.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('parseLrc converts timestamps and skips empty or metadata lines', () => {
  const out = parseLrc('[ar:Artist]\n[00:12.50] Line one\n[01:02.00]\n[01:05.25]  Line two');
  assert.deepEqual(out, [{ start_ms: 12500, orig: 'Line one' }, { start_ms: 65250, orig: 'Line two' }]);
});

test('detect identifies Arabic, Persian, Turkish and other', () => {
  assert.equal(detect('مرحبا يا قلبي'), 'ar');
  assert.equal(detect('چشمان تو زیباست'), 'fa');
  assert.equal(detect('Gönlümün sultanı'), 'tr');
  assert.equal(detect('میں تم سے پیار کرتا ہوں'), 'ur');
  assert.equal(detect('तुम मेरे दिल के करीब हो'), 'hi');
  assert.equal(detect('Hello darling'), 'other');
});

test('fetchLyrics estimates timings for plain lyrics when duration is available', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ plainLyrics: 'first\nsecond\nthird' }) });
  const out = await fetchLyrics('Song', 'Artist', 90);
  assert.equal(out.synced, 1);
  assert.deepEqual(out.lines.map(l => l.start_ms), [0, 30000, 60000]);
});

function mockNllb(bodies) {
  globalThis.fetch = async (_, o) => {
    const b = JSON.parse(o.body); bodies.push(b);
    return { ok: true, json: async () => ({ translations: b.texts.map(t => 'EN ' + t) }) };
  };
}

test('nllbTranslator batches 16 lines per request and keeps order', async () => {
  const bodies = []; mockNllb(bodies);
  const lines = Array.from({ length: 20 }, (_, i) => ({ orig: 'line' + i }));
  const out = await nllbTranslator('http://x')(lines, 'ar');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].texts.length, 16);
  assert.equal(bodies[0].src, 'arb_Arab');
  assert.equal(out.length, 20);
  assert.equal(out[19].en, 'EN line19');
});

test('nllbTranslator uses the Persian, Turkish and Hindi language codes', async () => {
  const bodies = []; mockNllb(bodies);
  await nllbTranslator('http://x')([{ orig: 'a' }], 'fa');
  await nllbTranslator('http://x')([{ orig: 'a' }], 'tr');
  await nllbTranslator('http://x')([{ orig: 'a' }], 'hi');
  assert.deepEqual(bodies.map(b => b.src), ['pes_Arab', 'tur_Latn', 'hin_Deva']);
});

test('nllbTranslator reports a service error status', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  await assert.rejects(nllbTranslator('http://x')([{ orig: 'a' }], 'ar'), /NLLB service error 500/);
});

test('nllbTranslator explains how to start the service when unreachable', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(nllbTranslator('http://x')([{ orig: 'a' }], 'ar'), /nllb_server\.py/);
});

test('nllbTranslator rejects a wrong number of returned lines', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ translations: ['only one'] }) });
  await assert.rejects(nllbTranslator('http://x')([{ orig: 'a' }, { orig: 'b' }], 'ar'), /wrong number/);
});

import { ollamaTranslator, withFallback, routedTranslator } from '../lib.js';

test('ollamaTranslator returns translations with idiom notes', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: JSON.stringify({ lines: [{ en: 'my heart', note: 'a term of endearment' }, { en: 'love' }] }) } }) });
  const out = await ollamaTranslator('http://x', 'm')([{ orig: 'a' }, { orig: 'b' }], 'ar');
  assert.deepEqual(out, [{ en: 'my heart', note: 'a term of endearment' }, { en: 'love', note: '' }]);
});

test('ollamaTranslator rejects invalid JSON, wrong counts and unreachable servers', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: 'not json' } }) });
  await assert.rejects(ollamaTranslator('http://x', 'm')([{ orig: 'a' }], 'ar'), /invalid JSON/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: '{"lines":[]}' } }) });
  await assert.rejects(ollamaTranslator('http://x', 'm')([{ orig: 'a' }], 'ar'), /wrong number/);
  globalThis.fetch = async () => { throw new Error('down'); };
  await assert.rejects(ollamaTranslator('http://x', 'm')([{ orig: 'a' }], 'ar'), /Cannot reach Ollama/);
});

test('withFallback uses the backup only when the primary fails', async () => {
  let backup = 0;
  const ok = async () => [{ en: 'primary', note: '' }];
  const bk = async () => { backup++; return [{ en: 'backup', note: '' }]; };
  const bad = async () => { throw new Error('nllb down'); };
  assert.equal((await withFallback(ok, bk, () => {})([{}], 'ar'))[0].en, 'primary');
  assert.equal(backup, 0);
  assert.equal((await withFallback(bad, bk, () => {})([{}], 'ar'))[0].en, 'backup');
});

test('withFallback reports both errors when both translators fail', async () => {
  const f = m => async () => { throw new Error(m); };
  await assert.rejects(withFallback(f('one'), f('two'), () => {})([{}], 'ar'), /one.*Fallback also failed: two/);
});

test('routedTranslator sends listed languages to Ollama first', async () => {
  const nllb = async () => [{ en: 'nllb', note: '' }], ollama = async () => [{ en: 'ollama', note: '' }];
  const t = routedTranslator({ nllb, ollama, ollamaFirst: ['fa'], log: () => {} });
  assert.equal((await t([{}], 'fa'))[0].en, 'ollama');
  assert.equal((await t([{}], 'ar'))[0].en, 'nllb');
});

import { searchLrclib } from '../lib.js';
test('searchLrclib maps results and skips incomplete ones', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ([{ id: 5, trackName: 'Bad Day', artistName: 'Daniel Powter', duration: 233.4 }, { id: 6 }]) });
  assert.deepEqual(await searchLrclib('bad day'), [{ id: 5, trackName: 'Bad Day', artistName: 'Daniel Powter', duration: 233 }]);
  assert.deepEqual(await searchLrclib('  '), []);
});

test('ollamaTranslator retries line by line when a batch comes back misaligned', async () => {
  globalThis.fetch = async (_, o) => {
    const texts = JSON.parse(JSON.parse(o.body).messages[1].content);
    const lines = texts.length > 1 ? [{ en: 'merged' }] : [{ en: 'EN ' + texts[0] }];
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ lines }) } }) };
  };
  const out = await ollamaTranslator('http://x', 'm')([{ orig: 'a' }, { orig: 'b' }, { orig: 'c' }], 'ar');
  assert.deepEqual(out.map(x => x.en), ['EN a', 'EN b', 'EN c']);
});

import { openaiCompatTranslator, chainTranslators } from '../lib.js';

const chat = content => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

test('openaiCompatTranslator reads fenced JSON and sends the key and model', async () => {
  let seen;
  globalThis.fetch = async (u, o) => { seen = { u, o }; return chat('```json\n{"lines":[{"en":"my heart","note":"endearment"}]}\n```'); };
  const out = await openaiCompatTranslator({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' })([{ orig: 'a' }], 'ar');
  assert.deepEqual(out, [{ en: 'my heart', note: 'endearment' }]);
  assert.equal(seen.u, 'http://x/v1/chat/completions');
  assert.equal(seen.o.headers.Authorization, 'Bearer k');
  assert.equal(JSON.parse(seen.o.body).model, 'm');
});

test('openaiCompatTranslator gives clear errors for key, rate limit and missing key', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(openaiCompatTranslator({ baseUrl: 'http://x', apiKey: 'k' })([{ orig: 'a' }], 'ar'), /key was rejected/);
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  await assert.rejects(openaiCompatTranslator({ baseUrl: 'http://x', apiKey: 'k' })([{ orig: 'a' }], 'ar'), /rate limit/);
  await assert.rejects(openaiCompatTranslator({ baseUrl: 'http://x', apiKey: '' })([{ orig: 'a' }], 'ar'), /LLM_API_KEY/);
});

test('chainTranslators tries each translator in order', async () => {
  const bad = async () => { throw new Error('x'); };
  const good = async () => [{ en: 'third', note: '' }];
  assert.equal((await chainTranslators([bad, bad, good], () => {})([{}], 'ar'))[0].en, 'third');
});

import { youtubeFinder, isoSeconds } from '../lib.js';
test('youtubeFinder returns null without a key and picks the closest duration', async () => {
  assert.equal(await youtubeFinder('')('T', 'A', 200), null);
  globalThis.fetch = async u => String(u).includes('/search?')
    ? { ok: true, json: async () => ({ items: [{ id: { videoId: 'aaaaaaaaaaa' } }, { id: { videoId: 'bbbbbbbbbbb' } }] }) }
    : { ok: true, json: async () => ({ items: [{ id: 'aaaaaaaaaaa', contentDetails: { duration: 'PT10M' } }, { id: 'bbbbbbbbbbb', contentDetails: { duration: 'PT3M52S' } }] }) };
  assert.equal(await youtubeFinder('k')('T', 'A', 233), 'bbbbbbbbbbb');
  assert.equal(isoSeconds('PT1H2M3S'), 3723);
});
