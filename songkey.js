// One identity for "the same song", shared by the API and both stores.
// It ignores case, accents, Arabic vowel marks, punctuation, spacing and harmless
// version tags such as "(Remastered 2011)" or "feat. X", so a song searched twice
// (different spellings from search results) is translated only once.
// "Live", "Acoustic", "Remix" and "Cover" are NOT stripped: those are different recordings.
const ARABIC_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u0640]/g;
const TAG = /(feat|ft\.?|featuring|remaster(?:ed)?|official|lyrics?|audio|video|mono|stereo|explicit|clean)/;

export function normalizePart(input) {
  let t = String(input ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(ARABIC_MARKS, '').replace(/ı/g, 'i');
  t = t.replace(/[([][^)\]]*[)\]]/g, m => (TAG.test(m) ? ' ' : m));       // "(feat. X)", "[Remastered]"
  t = t.replace(/\s[-–—]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|feat\.?|ft\.?|featuring)\b.*$/, ''); // " - 2011 Remaster"
  t = t.replace(/\b(?:feat|ft|featuring)\.?\s.*$/, '');                      // "Song feat. X"
  return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function songKey(title, artist = '') {
  const t = normalizePart(title), a = normalizePart(artist);
  return `${t || String(title).trim().toLowerCase()}|${a}`;
}
