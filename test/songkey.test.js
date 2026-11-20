import test from 'node:test';
import assert from 'node:assert/strict';
import { songKey, normalizePart } from '../songkey.js';

test('songKey ignores case, accents, punctuation and spacing', () => {
  assert.equal(songKey('Café  Del-Mar!', 'Énrique'), songKey('cafe del mar', 'enrique'));
});
test('songKey strips feat./remaster tags but keeps live/remix/acoustic', () => {
  assert.equal(songKey('Song (feat. X)', 'A'), songKey('Song', 'A'));
  assert.equal(songKey('Song - Remastered 2009', 'A'), songKey('Song', 'A'));
  assert.notEqual(songKey('Song (Live)', 'A'), songKey('Song', 'A'));
  assert.notEqual(songKey('Song (Acoustic)', 'A'), songKey('Song', 'A'));
});
test('Arabic vowel marks and Turkish dotless i do not split the cache', () => {
  assert.equal(normalizePart('حَبِيبِي'), normalizePart('حبيبي'));
  assert.equal(normalizePart('Sıla'), normalizePart('Sila'));
});
test('artist is part of the key', () => assert.notEqual(songKey('Song', 'A'), songKey('Song', 'B')));
