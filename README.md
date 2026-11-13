# Hallmark Holiday Vault

Nuvio movie-catalog addon that automatically discovers Hallmark and Crown Media movies through TMDB.

## How discovery works

- Searches TMDB production-company records for Hallmark and Crown Media companies.
- Uses the matching company IDs with TMDB's paginated `/discover/movie` endpoint.
- Reads up to 25 discovery pages per refresh (up to 500 TMDB results, depending on the result count).
- Merges discovered movies with the small `movies.json` seed list, removes duplicate TMDB IDs, and sorts newest first.
- Caches the discovered catalog and movie metadata in memory for six hours.
- Builds the Nuvio catalog pages on demand, up to 100 movies per page.
- Assigns seasonal collections using title, overview, and TMDB genre metadata. These holiday labels are best-effort classifications; TMDB metadata is not always complete.

The catalog refreshes automatically when Nuvio requests a catalog after the six-hour cache expires. No manual movie-list maintenance is required for normal discovery. A Render restart clears the in-memory cache and the next catalog request refreshes it.

## Render deployment

This repository includes `render.yaml` for a Render Node web service.

1. In Render, create or update the service from this GitHub repository and use the included Blueprint configuration.
2. In the service's Environment settings, set at least one TMDB credential:
   - `TMDB_READ_ACCESS_TOKEN` — TMDB API Read Access Token (recommended), or
   - `TMDB_API_KEY` — TMDB v3 API key.
3. Keep `REGION=CA` for Canadian watch-provider links, or change it to another TMDB-supported country code.
4. Deploy the latest commit. Render uses `npm install` and `npm start`; Node 20 is configured.
5. Confirm the service health at `https://YOUR-SERVICE.onrender.com/health`. The response includes `tmdbConfigured`, `discoveryLoaded`, `movies`, and `region`.

Do not commit TMDB credentials to this repository. Configure them as private Render environment variables.

## Add to Nuvio

Use the deployed service URL as the addon base URL, ending in `/manifest.json`:

`https://YOUR-SERVICE.onrender.com/manifest.json`

The existing addon ID and Nuvio routes are preserved:

- `/manifest.json`
- `/catalog/:type/:id.json`
- `/catalog/:type/:id/:extraArgs.json`
- `/meta/:type/:id.json`

## Catalog limitations

Discovery depends on TMDB production-company attribution. Hallmark titles missing a Hallmark/Crown Media company credit in TMDB may not be found automatically. The seed file can retain known exceptions, but the catalog is not a guarantee of every Hallmark title ever released. Seasonal category assignment is heuristic and may occasionally miss or misclassify a title.

TMDB data and images are provided by [The Movie Database](https://www.themoviedb.org/). This product uses the TMDB API but is not endorsed or certified by TMDB.
