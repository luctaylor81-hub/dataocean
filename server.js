const { createServer } = require("node:http");
const { createReadStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");

const root = __dirname;
const databasePath = process.env.DATA_OCEAN_DB || path.join(root, "data-ocean.sqlite");
const port = Number(process.env.PORT) || 3000;
const sessionCookie = "data_ocean_session";
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
const scryptAsync = promisify(scrypt);
const zones = [
  "Plage Akewni",
  "Pointe Denis",
  "Parc national de Pongara",
  "Cap Lopez",
  "Port-Gentil",
  "Gamba",
  "Mayumba"
];
const unitsByType = {
  "Déchets collectés": "kg",
  Biodiversité: "espèces",
  "Qualité de l’eau": "°C",
  "Érosion côtière": "niveau 1–5",
  Pollution: "niveau 1–5"
};
const materials = ["Plastique", "Métal", "Verre", "Autre"];
const database = new DatabaseSync(databasePath);

database.exec(`
  CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    zone TEXT NOT NULL,
    type TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    material TEXT NOT NULL DEFAULT '',
    contributor TEXT NOT NULL,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS observations_date_idx ON observations(date DESC);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    session_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
`);

database.exec("PRAGMA foreign_keys = ON");

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function normalizedEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex || !/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

function sessionToken(request) {
  const cookies = (request.headers.cookie || "").split(";");
  const session = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${sessionCookie}=`));
  return session ? session.slice(sessionCookie.length + 1) : "";
}

function sessionHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function currentUser(request) {
  const token = sessionToken(request);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return database.prepare(`
    SELECT users.id, users.email, users.role
    FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.session_hash = ? AND auth_sessions.expires_at > ?
  `).get(sessionHash(token), Date.now()) || null;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function setSessionCookie(response, request, token, maxAge) {
  const secure = request.socket.encrypted ? "; Secure" : "";
  response.setHeader("set-cookie", `${sessionCookie}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role };
}

async function createSession(response, request, userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + sessionDurationMs;
  database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(Date.now());
  database.prepare("INSERT INTO auth_sessions (session_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sessionHash(token), userId, expiresAt);
  setSessionCookie(response, request, token, Math.floor(sessionDurationMs / 1000));
}

async function handleAuthRequest(request, response, url) {
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const user = currentUser(request);
    if (!user) {
      sendJson(response, 200, { user: null });
      return;
    }
    sendJson(response, 200, { user: publicUser(user) });
    return;
  }

  if (request.method === "POST" && !sameOrigin(request)) {
    sendJson(response, 403, { error: "Origine de requête refusée." });
    return;
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = sessionToken(request);
    if (token) database.prepare("DELETE FROM auth_sessions WHERE session_hash = ?").run(sessionHash(token));
    setSessionCookie(response, request, "", 0);
    sendJson(response, 200, { loggedOut: true });
    return;
  }

  if ((url.pathname === "/api/auth/login" || url.pathname === "/api/auth/register") && request.method === "POST") {
    try {
      const body = await readJson(request);
      const email = normalizedEmail(body.email);
      const password = typeof body.password === "string" ? body.password : "";
      if (!validEmail(email)) {
        sendJson(response, 400, { error: "Saisissez une adresse courriel valide." });
        return;
      }

      if (url.pathname === "/api/auth/register") {
        if (password.length < 10 || password.length > 128) {
          sendJson(response, 400, { error: "Le mot de passe doit contenir entre 10 et 128 caractères." });
          return;
        }
        if (database.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
          sendJson(response, 409, { error: "Un compte existe déjà pour cette adresse courriel." });
          return;
        }
        const user = { id: randomUUID(), email, role: "user" };
        database.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(user.id, user.email, await hashPassword(password), user.role, Date.now());
        await createSession(response, request, user.id);
        sendJson(response, 201, { user: publicUser(user) });
        return;
      }

      const role = body.role === "admin" ? "admin" : "user";
      const user = database.prepare("SELECT id, email, password_hash, role FROM users WHERE email = ?").get(email);
      if (!user || user.role !== role || !(await verifyPassword(password, user.password_hash))) {
        sendJson(response, 401, { error: "Adresse courriel, mot de passe ou type de compte incorrect." });
        return;
      }
      await createSession(response, request, user.id);
      sendJson(response, 200, { user: publicUser(user) });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : "Impossible de traiter la demande." });
      if (!error.status) console.error("Échec de l’authentification.", error);
    }
    return;
  }

  sendJson(response, 404, { error: "Route d’authentification introuvable." });
}

function validateObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Observation invalide.";
  if (typeof value.id !== "string" || !value.id.trim() || value.id.length > 100) return "Identifiant invalide.";
  if (!zones.includes(value.zone)) return "Zone invalide.";
  if (!Object.hasOwn(unitsByType, value.type)) return "Type d’observation invalide.";
  if (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0) return "Valeur invalide.";
  if ((value.type === "Pollution" || value.type === "Érosion côtière") && value.value > 5) {
    return "La valeur doit être comprise entre 0 et 5 pour ce type d’observation.";
  }
  if (value.unit !== unitsByType[value.type]) return "Unité invalide.";
  if (typeof value.material !== "string" || (value.type === "Déchets collectés" && !materials.includes(value.material))) {
    return "Matière invalide.";
  }
  if (value.type !== "Déchets collectés" && value.material !== "") return "La matière ne s’applique qu’aux déchets collectés.";
  if (typeof value.contributor !== "string" || value.contributor.length > 80) return "Contributeur invalide.";
  if (typeof value.note !== "string" || value.note.length > 240) return "Commentaire invalide.";
  if (typeof value.date !== "string" || !Number.isFinite(Date.parse(value.date))) return "Date invalide.";
  return null;
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16_384) {
      const error = new Error("La requête est trop volumineuse.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Le corps JSON est invalide.");
    error.status = 400;
    throw error;
  }
}

function contentType(filePath) {
  return ({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end("Chemin invalide.");
    return;
  }
  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath === "/connexion" ? "/connexion.html" : decodedPath;
  const filePath = path.resolve(root, `.${requestedPath}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403);
    response.end("Accès interdit.");
    return;
  }

  try {
    const file = await fs.stat(filePath);
    if (!file.isFile()) throw new Error("Fichier introuvable.");
    response.writeHead(200, {
      "content-length": file.size,
      "content-type": contentType(filePath)
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      createReadStream(filePath).pipe(response);
    }
  } catch {
    response.writeHead(404);
    response.end("Fichier introuvable.");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/auth/")) {
    await handleAuthRequest(request, response, url);
    return;
  }
  if (url.pathname === "/api/observations" && request.method === "GET") {
    if (!currentUser(request)) {
      sendJson(response, 401, { error: "Connexion requise." });
      return;
    }
    const rows = database.prepare(`
      SELECT id, zone, type, value, unit, material, contributor, date, note
      FROM observations
      ORDER BY date DESC
    `).all();
    sendJson(response, 200, rows.map((row) => ({ ...row, demo: false })));
    return;
  }

  if (url.pathname === "/api/observations" && request.method === "POST") {
    const user = currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Connexion requise." });
      return;
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: "Origine de requête refusée." });
      return;
    }
    try {
      const observation = await readJson(request);
      const validationError = validateObservation(observation);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }
      const result = database.prepare(`
        INSERT OR IGNORE INTO observations (id, zone, type, value, unit, material, contributor, date, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.id,
        observation.zone,
        observation.type,
        observation.value,
        observation.unit,
        observation.material,
        observation.contributor,
        observation.date,
        observation.note
      );
      sendJson(response, result.changes ? 201 : 200, { saved: true });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : "Erreur lors de l’enregistrement." });
      if (!error.status) console.error("Échec de l’enregistrement SQLite.", error);
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "Route API introuvable." });
    return;
  }
  const user = currentUser(request);
  const publicPaths = new Set(["/connexion", "/connexion.html", "/connexion.css", "/connexion.js", "/coastline.jpg"]);
  if (!user && !publicPaths.has(url.pathname)) {
    response.writeHead(302, { location: "/connexion" });
    response.end();
    return;
  }
  if (user && (url.pathname === "/connexion" || url.pathname === "/connexion.html")) {
    response.writeHead(302, { location: "/" });
    response.end();
    return;
  }
  await serveStatic(request, response, url.pathname);
});

async function initializeAdminAccount() {
  const email = normalizedEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email && !password) {
    console.warn("Compte administrateur non configuré. Définissez ADMIN_EMAIL et ADMIN_PASSWORD.");
    return;
  }
  if (!validEmail(email) || password.length < 14 || password.length > 128) {
    throw new Error("ADMIN_EMAIL doit être valide et ADMIN_PASSWORD doit contenir entre 14 et 128 caractères.");
  }
  const existing = database.prepare("SELECT id FROM users WHERE email = ?").get(email);
  const userId = existing?.id || randomUUID();
  database.prepare(`
    INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)
    ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin'
  `).run(userId, email, await hashPassword(password), Date.now());
}

initializeAdminAccount().then(() => {
  server.listen(port, "0.0.0.0", () => {
    console.log(`Data Ocean disponible sur http://127.0.0.1:${port}`);
    console.log(`Base SQLite : ${databasePath}`);
  });
}).catch((error) => {
  console.error("Impossible de configurer le compte administrateur.", error.message);
  database.close();
  process.exitCode = 1;
});

function closeDatabase() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", closeDatabase);
process.on("SIGTERM", closeDatabase);
