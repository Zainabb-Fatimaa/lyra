# Lyra

**A full-stack lyrics translation product that turns song lyrics into understandable, synced English.**

Lyra started with a creative problem: I wanted to understand songs in Persian, Turkish and Arabic while listening to them. It searches for a song, finds its lyrics, detects the language, translates it line by line, and highlights the translation in time with the music.

## What it does

- Searches songs and fetches timed or plain lyrics
- Detects Arabic, Persian, Turkish, and Latin-script lyrics
- Shows the original lyric and an English translation
- Highlights the active line while YouTube playback continues
- Allows users to adjust timing for different recordings
- Caches translations so a song is processed only once
- Finds matching YouTube recordings through YouTube's official API

## Engineering mindset

The project uses small, replaceable pieces instead of one tightly coupled system:

- Lyrics providers, translators, and databases are separate adapters
- Translator providers run in fallback order when one service fails
- Repeated songs are matched by track ID or normalised title and artist
- Parallel requests share a single translation job
- Missing lyrics and unavailable videos are handled as normal states
- The UI supports desktop, mobile, and reduced-motion preferences
- External services are mocked in tests

The work combines product thinking, backend systems, AI integration, error handling, caching, responsive UI, and testing.

## Explainable AI interest

Lyra makes the AI pipeline visible and inspectable: language detection → source-language selection → translation → timing → cache reuse → fallback. It also preserves the original text next to the result, because a translation should be understandable and reviewable rather than appearing as an unexplained output.

I am interested in building AI systems that show uncertainty, recover safely, and keep human context around generated decisions.

## Tech stack

`Node.js` · `Express` · `JavaScript` · `HTML/CSS` · `PostgreSQL` · `Python` · `Flask` · `PyTorch` · `Transformers` · `NLLB-200` · `YouTube Data API`

## Run it locally

```bash
npm install
cp .env.example .env
npm run dev
```

Optional local NLLB server:

```bash
python -m pip install flask transformers torch sentencepiece
python nllb_server.py
```

## Tests

```bash
npm test
```
