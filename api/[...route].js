const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { Pool } = require("pg");

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
let pool;
let initialization;

function database() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL n’est pas configurée.");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

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

async function currentUser(request) {
  const token = sessionToken(request);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await database().query(`
    SELECT users.id, users.email, users.role
    FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.session_hash = $1 AND auth_sessions.expires_at > $2
  `, [sessionHash(token), Date.now()]);
  return result.rows[0] || null;
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
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const secure = process.env.NODE_ENV === "production" || forwardedProtocol === "https";
  response.setHeader(
    "set-cookie",
    `${sessionCookie}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`
  );
}

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role };
}

async function createSession(response, request, userId) {
  const db = database();
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + sessionDurationMs;
  await db.query("DELETE FROM auth_sessions WHERE expires_at <= $1", [Date.now()]);
  await db.query(
    "INSERT INTO auth_sessions (session_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [sessionHash(token), userId, expiresAt]
  );
  setSessionCookie(response, request, token, Math.floor(sessionDurationMs / 1000));
}

async function initializeAdminAccount() {
  const email = normalizedEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email && !password) return;
  if (!validEmail(email) || password.length < 14 || password.length > 128) {
    throw new Error("ADMIN_EMAIL doit être valide et ADMIN_PASSWORD doit contenir entre 14 et 128 caractères.");
  }

  await database().query(`
    INSERT INTO users (id, email, password_hash, role, created_at)
    VALUES ($1, $2, $3, 'admin', $4)
    ON CONFLICT (email) DO UPDATE
    SET password_hash = EXCLUDED.password_hash, role = 'admin'
  `, [randomUUID(), email, await hashPassword(password), Date.now()]);
}

async function ensureInitialized() {
  if (!initialization) initialization = initializeAdminAccount();
  try {
    await initialization;
  } catch (error) {
    initialization = null;
    throw error;
  }
}

async function readJson(request) {
  if (request.body !== undefined) {
    if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
    try {
      return JSON.parse(Buffer.isBuffer(request.body) ? request.body.toString("utf8") : request.body);
    } catch {
      const error = new Error("Le corps JSON est invalide.");
      error.status = 400;
      throw error;
    }
  }

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

async function handleAuthRequest(request, response, url) {
  const db = database();
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const user = await currentUser(request);
    sendJson(response, 200, { user: user ? publicUser(user) : null });
    return;
  }

  if (request.method === "POST" && !sameOrigin(request)) {
    sendJson(response, 403, { error: "Origine de requête refusée." });
    return;
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = sessionToken(request);
    if (token) await db.query("DELETE FROM auth_sessions WHERE session_hash = $1", [sessionHash(token)]);
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
        const user = { id: randomUUID(), email, role: "user" };
        try {
          await db.query(
            "INSERT INTO users (id, email, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5)",
            [user.id, user.email, await hashPassword(password), user.role, Date.now()]
          );
        } catch (error) {
          if (error.code === "23505") {
            sendJson(response, 409, { error: "Un compte existe déjà pour cette adresse courriel." });
            return;
          }
          throw error;
        }
        await createSession(response, request, user.id);
        sendJson(response, 201, { user: publicUser(user) });
        return;
      }

      const role = body.role === "admin" ? "admin" : "user";
      const result = await db.query(
        "SELECT id, email, password_hash, role FROM users WHERE email = $1",
        [email]
      );
      const user = result.rows[0];
      if (!user || user.role !== role || !(await verifyPassword(password, user.password_hash))) {
        sendJson(response, 401, { error: "Adresse courriel, mot de passe ou type de compte incorrect." });
        return;
      }
      await createSession(response, request, user.id);
      sendJson(response, 200, { user: publicUser(user) });
    } catch (error) {
      sendJson(response, error.status || 500, {
        error: error.status ? error.message : "Impossible de traiter la demande."
      });
      if (!error.status) console.error("Échec de l’authentification PostgreSQL.", error);
    }
    return;
  }

  sendJson(response, 404, { error: "Route d’authentification introuvable." });
}

module.exports = async function handler(request, response) {
  try {
    await ensureInitialized();
    const url = new URL(request.url, `https://${request.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/auth/")) {
      await handleAuthRequest(request, response, url);
      return;
    }

    if (url.pathname === "/api/observations" && request.method === "GET") {
      if (!(await currentUser(request))) {
        sendJson(response, 401, { error: "Connexion requise." });
        return;
      }
      const result = await database().query(`
        SELECT id, zone, type, value, unit, material, contributor, date, note
        FROM observations
        ORDER BY date DESC
      `);
      sendJson(response, 200, result.rows.map((row) => ({ ...row, demo: false })));
      return;
    }

    if (url.pathname === "/api/observations" && request.method === "POST") {
      if (!(await currentUser(request))) {
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
        const result = await database().query(`
          INSERT INTO observations (id, zone, type, value, unit, material, contributor, date, note)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO NOTHING
        `, [
          observation.id,
          observation.zone,
          observation.type,
          observation.value,
          observation.unit,
          observation.material,
          observation.contributor,
          observation.date,
          observation.note
        ]);
        sendJson(response, result.rowCount ? 201 : 200, { saved: true });
      } catch (error) {
        sendJson(response, error.status || 500, {
          error: error.status ? error.message : "Erreur lors de l’enregistrement."
        });
        if (!error.status) console.error("Échec de l’enregistrement PostgreSQL.", error);
      }
      return;
    }

    sendJson(response, 404, { error: "Route API introuvable." });
  } catch (error) {
    console.error("Erreur de l’API Vercel.", error);
    sendJson(response, 500, { error: "Le service est temporairement indisponible." });
  }
};
