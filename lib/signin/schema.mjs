// Tables of email sign-in (lib/signin/store.mjs, AUTOMATION.md "Email
// sign-in"). Additive and idempotent: lib/schema.mjs applies them with the
// rest of the schema.
//
//   email_accounts         one row per email account: the address (to show it
//                          to its owner and to export or delete it), a keyed
//                          hash of it (unique: one account per address), and
//                          the account id behind the rater id em:<id>
//   email_signin_tokens    one-time sign-in links: only a hash of the token,
//                          the address it signs in, 15 minutes to live, used
//                          once; expired and used rows go in the nightly
//                          retention and on every new request
export const SIGNIN_TABLES = [
  `CREATE TABLE IF NOT EXISTS email_accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    email_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_sign_in_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS email_signin_tokens (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    callback TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS email_signin_tokens_expires_idx ON email_signin_tokens (expires_at)`,
];
