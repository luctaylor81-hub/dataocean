CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  zone TEXT NOT NULL,
  type TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  material TEXT NOT NULL DEFAULT '',
  contributor TEXT NOT NULL,
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS observations_date_idx ON observations(date DESC);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
