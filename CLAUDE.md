# Project Context

## Bird Game
- The bird guessing game lives in a **separate repo**: `https://github.com/thetomgreen/Bird-game`
- It is cloned locally at `/home/user/Bird-game/`
- It is hosted at `https://realbirdorfake.com`

### Bird Game Structure
- `birds.js` — 500 real birds with names and facts (BIRDS pool ~300, HARD_BIRDS ~200)
- `fake-names.js` — generates fake bird names at 3 difficulty levels
- `game.js` — main game logic (rounds, scoring, adaptive difficulty)
- `fetch-photos.js` — Node script to populate `photo:` URLs in birds.js from iNaturalist API
- `index.html` / `styles.css` — UI

### Status
- Photos are populated in `birds.js` (492/500 birds have photos)
- `fetch-photos.js` queries iNaturalist API and patches `photo: "url"` into each bird entry; only accepts results where `iconic_taxon_name === 'Aves'`
- Running it takes ~6 minutes for all 500 birds (700ms delay per bird for rate limits)
