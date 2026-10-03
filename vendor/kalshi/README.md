# Shared Kalshi Market Intelligence client

Vendor these three files UNCHANGED into a product (e.g. `src/vendor/kalshi/`):

- `kalshi-market-ui.js`  — `kalshiCard`, `kalshiStrip`, `kalshiLine`, `sparkline`, `wireKalshi`
- `kalshi-market-ui.css` — component styles (uses product `--pbe-*` tokens when present)
- `kalshi-market-client.js` — `createKalshiClient({ sport })` → `loadBoard`, `forEvent`, `loadEvent`, `pollMsFor`

Rules every product keeps: the browser never calls Kalshi; no entry → render nothing; every price
links to the verified Kalshi market (`rel="noopener noreferrer sponsored"`); copy says "prediction
market", never sportsbook odds or a PBE prediction; movement only from observed snapshots.

Placements: full card on the event page (load it WITH the event data so it is in the first paint —
zero layout shift), `kalshiStrip` in the live/PBEcast view, `kalshiLine` on compact schedule cards.
