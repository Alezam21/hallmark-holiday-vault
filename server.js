const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const REGION = process.env.REGION || "CA";
const TMDB_KEY = process.env.TMDB_API_KEY;
const TMDB_TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;

const MOVIES_FILE = path.join(__dirname, "movies.json");

const catalogs = [
  ["hallmark-all", "All Hallmark Movies", "all"],
  ["hallmark-christmas", "Hallmark Christmas Movies", "Christmas"],
  ["hallmark-valentines", "Hallmark Valentine's Day", "Valentines"],
  ["hallmark-thanksgiving", "Hallmark Thanksgiving", "Thanksgiving"],
  ["hallmark-easter", "Hallmark Spring & Easter", "Easter"],
  ["hallmark-halloween", "Hallmark Halloween", "Halloween"],
  ["hallmark-mystery", "Hallmark Mystery & Holiday", "Mystery"],
  ["hallmark-upcoming", "Upcoming Hallmark Movies", "upcoming"],
  ["hallmark-recent", "Recently Released Hallmark Movies", "recent"],
  ["hallmark-2026", "Hallmark Movies 2026", "2026"],
  ["hallmark-2025", "Hallmark Movies 2025", "2025"]
];

const cache = new Map();
const CACHE_TIME = 6 * 60 * 60 * 1000;
const DISCOVERY_CACHE_KEY = "hallmark-discovery-v1";
const COMPANY_SEARCH_TERMS = [
  "Hallmark",
  "Hallmark Channel",
  "Hallmark Movies & Mysteries",
  "Hallmark Entertainment",
  "Hallmark Media",
  "Crown Media",
  "Crown Media Productions"
];
const MAX_DISCOVERY_PAGES = 25;

function readMovies() {
  return JSON.parse(fs.readFileSync(MOVIES_FILE, "utf8"));
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function tmdb(pathname) {
  if (!TMDB_KEY && !TMDB_TOKEN) {
    throw new Error("TMDB credentials are missing");
  }

  const url = new URL("https://api.themoviedb.org/3" + pathname);

  if (TMDB_KEY) url.searchParams.set("api_key", TMDB_KEY);

  const headers = { accept: "application/json" };
  if (TMDB_TOKEN) headers.Authorization = `Bearer ${TMDB_TOKEN}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`TMDB error: ${response.status} ${body.slice(0, 180)}`);
  }
  return response.json();
}

function inferHoliday(movie) {
  const text = normalize([
    movie.title,
    movie.original_title,
    movie.overview,
    ...(movie.holiday || [])
  ].join(" "));

  const holidays = [];
  if (/christmas|xmas|santa|noel|mistletoe|december|holidayseason|yuletide/.test(text)) holidays.push("Christmas");
  if (/valentine|valentines|loveandromance|february14/.test(text)) holidays.push("Valentines");
  if (/thanksgiving|turkeyday|harvest/.test(text)) holidays.push("Thanksgiving");
  if (/easter|springbunny|goodfriday/.test(text)) holidays.push("Easter");
  if (/halloween|spooky|haunted|trickortreat/.test(text)) holidays.push("Halloween");
  if ((movie.genre_ids || []).includes(9648) || /mystery|detective|investigation/.test(text)) holidays.push("Mystery");
  return [...new Set(holidays)];
}

function asMovie(result) {
  const releaseDate = result.release_date || "";
  const movie = {
    tmdbId: result.id,
    title: result.title || result.original_title,
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
    release_date: releaseDate,
    overview: result.overview || "",
    poster_path: result.poster_path || null,
    backdrop_path: result.backdrop_path || null,
    genre_ids: result.genre_ids || [],
    holiday: []
  };
  movie.holiday = inferHoliday(movie);
  return movie;
}

async function discoverHallmarkMovies() {
  const cached = cache.get(DISCOVERY_CACHE_KEY);
  if (cached && cached.expires > Date.now()) return cached.value;

  if (!TMDB_KEY && !TMDB_TOKEN) {
    return readMovies();
  }

  // Resolve Hallmark/Crown Media production-company IDs dynamically rather
  // than relying on a guessed numeric company ID.
  const companySearches = await Promise.all(
    COMPANY_SEARCH_TERMS.map(async term => {
      const params = new URLSearchParams({ query: term, page: "1" });
      const result = await tmdb(`/search/company?${params}`);
      return result.results || [];
    })
  );

  const companies = new Map();
  for (const company of companySearches.flat()) {
    const name = normalize(company.name);
    if (name.includes("hallmark") || name.includes("crownmedia")) {
      companies.set(company.id, company.name);
    }
  }

  if (!companies.size) {
    throw new Error("TMDB did not return a matching Hallmark/Crown Media production company. Check TMDB credentials and company search availability.");
  }

  const companyIds = [...companies.keys()];
  const discovered = new Map();
  let totalPages = 1;

  // TMDB accepts pipe-separated company IDs as OR. Discover is paginated;
  // fetch a bounded number of pages so a cold catalog request stays finite.
  for (let page = 1; page <= Math.min(totalPages, MAX_DISCOVERY_PAGES); page++) {
    const params = new URLSearchParams({
      with_companies: companyIds.join("|"),
      sort_by: "primary_release_date.desc",
      include_adult: "false",
      include_video: "false",
      page: String(page)
    });
    const result = await tmdb(`/discover/movie?${params}`);
    totalPages = Math.min(Number(result.total_pages) || 1, MAX_DISCOVERY_PAGES);

    for (const item of result.results || []) {
      if (!item.id || !(item.title || item.original_title)) continue;
      if (!discovered.has(item.id)) discovered.set(item.id, asMovie(item));
    }
  }

  // Keep the original hand-entered titles as a safety net for TMDB records
  // that are not linked to a Hallmark production-company entry.
  for (const movie of readMovies()) {
    if (movie.tmdbId && !discovered.has(movie.tmdbId)) {
      discovered.set(movie.tmdbId, {
        ...movie,
        holiday: movie.holiday || []
      });
    }
  }

  const movies = [...discovered.values()].sort((a, b) => {
    const dateA = a.release_date || `${a.year || 0}-01-01`;
    const dateB = b.release_date || `${b.year || 0}-01-01`;
    return dateB.localeCompare(dateA) || a.title.localeCompare(b.title);
  });

  cache.set(DISCOVERY_CACHE_KEY, {
    value: movies,
    expires: Date.now() + CACHE_TIME
  });

  console.log(`Hallmark discovery refreshed: ${movies.length} movies from ${companyIds.length} companies and ${Math.min(totalPages, MAX_DISCOVERY_PAGES)} TMDB pages.`);
  return movies;
}

async function resolveMovie(movie) {
  if (movie.tmdbId) return movie.tmdbId;

  const key = `search:${movie.title}:${movie.year}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const params = new URLSearchParams({ query: movie.title });
  if (movie.year) params.set("year", String(movie.year));
  const result = await tmdb(`/search/movie?${params}`);

  const match = (result.results || []).find(item =>
    normalize(item.title) === normalize(movie.title) &&
    (!movie.year || !item.release_date || item.release_date.startsWith(String(movie.year)))
  );

  const id = match ? match.id : null;
  cache.set(key, { value: id, expires: Date.now() + CACHE_TIME });
  return id;
}

async function movieDetails(movie) {
  const tmdbId = await resolveMovie(movie);
  if (!tmdbId) return null;

  const key = `movie:${tmdbId}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const data = await tmdb(`/movie/${tmdbId}`);
  const providerData = await tmdb(`/movie/${tmdbId}/watch/providers`);
  const regional = providerData.results?.[REGION] || {};

  const providers = [
    ...(regional.flatrate || []),
    ...(regional.free || []),
    ...(regional.ads || []),
    ...(regional.rent || []),
    ...(regional.buy || [])
  ];

  const uniqueProviders = [...new Map(
    providers.map(provider => [provider.provider_id, provider])
  ).values()];

  const watchUrl = regional.link ||
    `https://www.justwatch.com/${REGION.toLowerCase()}/search?q=${encodeURIComponent(movie.title)}`;

  const description = [
    data.overview || movie.overview || "Movie description not available.",
    "",
    `Holiday: ${(movie.holiday || inferHoliday({ ...data, title: data.title })).join(", ") || "Not categorized"}`,
    `Network/Studio: ${(data.production_companies || []).map(company => company.name).join(", ") || "Hallmark"}`,
    `Streaming availability (${REGION}): ${uniqueProviders.length
      ? uniqueProviders.map(provider => provider.provider_name).join(", ")
      : "No providers currently listed"}`,
    "",
    "Availability may change. Check the provider before subscribing."
  ].join("\n");

  const meta = {
    id: `hallmark:${tmdbId}`,
    type: "movie",
    name: data.title || movie.title,
    poster: data.poster_path
      ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
      : movie.poster_path
        ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
        : undefined,
    background: data.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}`
      : movie.backdrop_path
        ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}`
        : undefined,
    description,
    releaseInfo: data.release_date
      ? data.release_date.slice(0, 4)
      : String(movie.year || ""),
    genres: (data.genres || []).map(genre => genre.name),
    links: [{
      name: `Find where to watch in ${REGION}`,
      category: "watch",
      url: watchUrl
    }]
  };

  cache.set(key, { value: meta, expires: Date.now() + CACHE_TIME });
  return meta;
}

function belongs(movie, category) {
  if (category === "all") return true;

  const holidays = movie.holiday?.length ? movie.holiday : inferHoliday(movie);
  if (category === "upcoming") {
    return movie.release_date && movie.release_date > new Date().toISOString().slice(0, 10);
  }
  if (category === "recent") {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 2);
    return movie.release_date && movie.release_date >= cutoff.toISOString().slice(0, 10);
  }
  if (/^\d{4}$/.test(category)) return String(movie.year) === category;
  return holidays.some(holiday => normalize(holiday) === normalize(category));
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        output[index] = await mapper(items[index]);
      } catch (error) {
        console.error("Movie skipped:", items[index].title, error.message);
        output[index] = null;
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  ));
  return output.filter(Boolean);
}

async function makeCatalog(id, search = "", skip = 0) {
  const catalog = catalogs.find(item => item[0] === id);
  if (!catalog) return [];

  let movies = await discoverHallmarkMovies();
  movies = movies.filter(movie => belongs(movie, catalog[2]));

  if (search) {
    movies = movies.filter(movie =>
      normalize(movie.title).includes(normalize(search))
    );
  }

  const pageMovies = movies.slice(skip, skip + 100);
  return mapWithConcurrency(pageMovies, 5, movieDetails);
}

const manifest = {
  id: "com.hallmark.holidayvault",
  version: "1.1.0",
  name: "Hallmark Holiday Vault",
  description: "Hallmark holiday movie catalog and seasonal collections.",
  resources: ["catalog", "meta"],
  types: ["movie"],
  idPrefixes: ["hallmark:"],
  catalogs: catalogs.map(([id, name]) => ({
    type: "movie",
    id,
    name,
    extra: [{ name: "search", isRequired: false }]
  }))
};

app.get("/", (req, res) => {
  res.send("Hallmark Holiday Vault is running.");
});

app.get("/health", (req, res) => {
  let localMovieCount = 0;
  try { localMovieCount = readMovies().length; } catch (_) {}
  const cachedDiscovery = cache.get(DISCOVERY_CACHE_KEY);
  res.json({
    status: "ok",
    tmdbConfigured: Boolean(TMDB_KEY || TMDB_TOKEN),
    movies: cachedDiscovery?.value?.length ?? localMovieCount,
    discoveryLoaded: Boolean(cachedDiscovery && cachedDiscovery.expires > Date.now()),
    region: REGION
  });
});

app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

async function catalogHandler(req, res) {
  try {
    const metas = await makeCatalog(
      req.params.id,
      req.query.search || "",
      Math.max(0, Number(req.query.skip) || 0)
    );
    res.json({ metas });
  } catch (error) {
    console.error("Catalog error:", error);
    res.status(500).json({ metas: [], error: error.message });
  }
}

app.get("/catalog/:type/:id.json", catalogHandler);

app.get("/catalog/:type/:id/:extraArgs.json", (req, res) => {
  const params = new URLSearchParams(req.params.extraArgs);
  req.query.search = req.query.search || params.get("search");
  req.query.skip = req.query.skip || params.get("skip");
  return catalogHandler(req, res);
});

/* Preserve the existing Nuvio metadata route and hallmark:<TMDB ID> format. */
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    const id = req.params.id;
    const tmdbId = Number(id.replace("hallmark:", ""));

    if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
      return res.status(400).json({ meta: null });
    }

    let movie = null;
    const cachedDiscovery = cache.get(DISCOVERY_CACHE_KEY);
    const candidates = cachedDiscovery?.value || readMovies();
    movie = candidates.find(item => Number(item.tmdbId) === tmdbId) || {
      tmdbId,
      title: `Hallmark movie ${tmdbId}`
    };

    const meta = await movieDetails(movie);
    res.json({ meta });
  } catch (error) {
    console.error("Metadata error:", error);
    res.status(500).json({ meta: null });
  }
});

app.listen(PORT, () => {
  console.log(`Hallmark Holiday Vault running on port ${PORT}`);
});
