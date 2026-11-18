# Available now

Popular movies and series that were released recently and already have torrents, shown in a
Seerr-style page where each title can be requested in Seerr with one click.

- Page: `http://<host>:1600`
- RSS: `http://<host>:1600/movies.xml`, `http://<host>:1600/tv.xml`

## Dashboard widget

`http://<host>:1600/widget` is a compact view for an iframe (Homarr's iFrame widget): a row of
posters and, below them, more titles as text. Each one opens the full page with its details.
The background is transparent, so it takes the dashboard card's color.

| Parameter | Default | |
|---|---|---|
| `type` | `movie` | `movie` or `tv` |
| `n` | `5` | posters in the row |
| `more` | `5` | titles listed below |
| `sort` | `seeders` | `seeders`, `recent` or `rating` |
| `owned` | | `1` also shows what Seerr already has |
| `bg` | transparent | a hex color (`25262b`) for a solid background |

Example: `http://<host>:1600/widget?type=tv&n=6&more=8`. If the dashboard is served over HTTPS,
the browser blocks an HTTP iframe: put this app behind the same HTTPS proxy.

## How it decides what to show

Once an hour it walks Seerr's discover lists (TMDB), most popular first:

- movies released in the last `MOVIE_MAX_AGE_DAYS` with at least `MIN_VOTES_MOVIE` votes;
- series with at least `MIN_VOTES_TV` votes whose last episode aired in the last `MAX_AGE_DAYS`
  (news and talk shows skipped).

Each one is searched in Prowlarr by title. Only releases of that exact title count (movies: the
same year; series: the airing season, published in the last `MAX_AGE_DAYS`), CAM/TS/screeners
are dropped, and the best release needs `MIN_SEEDERS`. It stops once `MAX_ITEMS` titles qualify
per row. Searches are cached for `CHECK_HOURS` and spaced by `SEARCH_DELAY_MS`: the first run
makes a few hundred searches (several minutes), later runs only redo the expired ones.
Status (available, requested) comes from Seerr.

## Run

    cp .env.example .env   # fill PROWLARR_API_KEY and SEERR_API_KEY
    docker compose up -d --build

It joins the existing `servarr_default` network to reach `prowlarr:9696` and `seerr:5055`.
State lives in `./data/state.json`; delete it to start over.

The page has no login: anyone on the LAN who can open it can request through Seerr as the
admin (or as `SEERR_USER_ID`). Do not expose port 1600 to the internet.

## Test

    npm test

## License

[GPL-3.0-or-later](LICENSE).
