
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

  const url = new URL(
    "https://api.themoviedb.org/3" + pathname
  );

  if (TMDB_KEY) {
    url.searchParams.set("api_key", TMDB_KEY);
  }

  const headers = { accept: "application/json" };

  if (TMDB_TOKEN) {
    headers.Authorization = `Bearer ${TMDB_TOKEN}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`TMDB error: ${response.status}`);
  }

  return response.json();
}

async function resolveMovie(movie) {
  if (movie.tmdbId) return movie.tmdbId;

  const key = `search:${movie.title}:${movie.year}`;
  const cached = cache.get(key);

  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }

  const params = new URLSearchParams({
    query: movie.title,
    year: String(movie.year)
  });

  const result = await tmdb(`/search/movie?${params}`);

  const match = (result.results || []).find(item =>
    normalize(item.title) === normalize(movie.title) &&
    (!movie.year ||
      !item.release_date ||
      item.release_date.startsWith(String(movie.year)))
  );

  const id = match ? match.id : null;

  cache.set(key, {
    value: id,
    expires: Date.now() + CACHE_TIME
  });

  return id;
}

async function movieDetails(movie) {
  const tmdbId = await resolveMovie(movie);

  if (!tmdbId) return null;

  const key = `movie:${tmdbId}`;
  const cached = cache.get(key);

  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }

  const data = await tmdb(`/movie/${tmdbId}`);
  const providerData = await tmdb(
    `/movie/${tmdbId}/watch/providers`
  );

  const regional = providerData.results?.[REGION] || {};

  const providers = [
    ...(regional.flatrate || []),
    ...(regional.free || []),
    ...(regional.ads || []),
    ...(regional.rent || []),
    ...(regional.buy || [])
  ];

  const uniqueProviders = [
    ...new Map(
      providers.map(p => [p.provider_id, p])
    ).values()
  ];

  const watchUrl = regional.link ||
    `https://www.justwatch.com/${REGION.toLowerCase()}/search?q=${encodeURIComponent(movie.title)}`;

  const description = [
    data.overview || "Movie description not available.",
    "",
    `Holiday: ${(movie.holiday || []).join(", ")}`,
    `Network: ${movie.network || "Hallmark"}`,
    `Streaming availability (${REGION}): ${
      uniqueProviders.length
        ? uniqueProviders.map(p => p.provider_name).join(", ")
        : "No providers currently listed"
    }`,
    "",
    "Availability may change. Check the provider before subscribing."
  ].join("\n");

  const meta = {
    id: `hallmark:${tmdbId}`,
    type: "movie",
    name: data.title || movie.title,
    poster: data.poster_path
      ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
      : undefined,
    background: data.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}`
      : undefined,
    description,
    releaseInfo: data.release_date
      ? data.release_date.slice(0, 4)
      : String(movie.year || ""),
    genres: (data.genres || []).map(g => g.name),
    links: [{
      name: `Find where to watch in ${REGION}`,
      category: "watch",
      url: watchUrl
    }]
  };

  cache.set(key, {
    value: meta,
    expires: Date.now() + CACHE_TIME
  });

  return meta;
}

function belongs(movie, category) {
  if (category === "all") return true;

  if (category === "upcoming") {
    return movie.status === "upcoming";
  }

  if (category === "recent") {
    return movie.status === "recent";
  }

  if (/^\d{4}$/.test(category)) {
    return String(movie.year) === category;
  }

  return (movie.holiday || []).some(
    holiday => normalize(holiday) === normalize(category)
  ) || (
    category === "Mystery" &&
    normalize(movie.network).includes("mystery")
  );
}

async function makeCatalog(id, search = "", skip = 0) {
  const catalog = catalogs.find(c => c[0] === id);

  if (!catalog) return [];

  let movies = readMovies().filter(movie =>
    belongs(movie, catalog[2])
  );

  if (search) {
    movies = movies.filter(movie =>
      normalize(movie.title).includes(normalize(search))
    );
  }

  movies = movies.slice(skip, skip + 100);

  const metas = [];

  for (const movie of movies) {
    try {
      const meta = await movieDetails(movie);
      if (meta) metas.push(meta);
    } catch (error) {
      console.error("Movie skipped:", movie.title, error.message);
    }
  }

  return metas;
}

const manifest = {
  id: "com.hallmark.holidayvault",
  version: "1.0.0",
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
  res.json({
    status: "ok",
    tmdbConfigured: Boolean(TMDB_KEY || TMDB_TOKEN),
    movies: readMovies().length,
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
    console.error(error);
    res.status(500).json({ metas: [] });
  }
}

app.get("/catalog/:type/:id.json", catalogHandler);

app.get("/catalog/:type/:id/:extraArgs.json", (req, res) => {
  const params = new URLSearchParams(req.params.extraArgs);

  req.query.search = req.query.search || params.get("search");
  req.query.skip = req.query.skip || params.get("skip");

  return catalogHandler(req, res);
});

/* Corrected movie metadata route */
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    const id = req.params.id;
    const tmdbId = Number(id.replace("hallmark:", ""));

    if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
      return res.status(400).json({ meta: null });
    }

    let movie = null;

    for (const item of readMovies()) {
      const resolvedId = await resolveMovie(item);

      if (String(resolvedId) === String(tmdbId)) {
        movie = item;
        break;
      }
    }

    if (!movie) {
      return res.json({ meta: null });
    }

    const meta = await movieDetails(movie);
    res.json({ meta });

  } catch (error) {
    console.error(error);
    res.status(500).json({ meta: null });
  }
});

app.listen(PORT, () => {
  console.log(`Hallmark Holiday Vault running on port ${PORT}`);
});
