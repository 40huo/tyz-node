-- User roles + login credentials.
--
-- The platform admin is a users row with role='admin' (created once via the
-- first-run /setup wizard; multiple admins are allowed). Regular business
-- users keep role='user' and have no password until a future user-facing
-- login ships. password_hash NEVER appears in API responses or audit rows
-- (same trust level as relay_nodes.token_hash).

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN password_hash TEXT; -- NULL = cannot log in
