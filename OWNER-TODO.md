# Owner to-do

## Keys

Checked 2026-11-09 against the secret names on the Worker and in GitHub Actions (names only, no values).
New values go into the owner's pass-env store and are sent with `pass-env pipe <entry> -- <command>`; never commit or paste a value.

- [x] `GEMINI_API_KEY` Actions secret: replaced with a new AI Studio key 2026-11-10 (the old one had been dead since late July).
- [x] `TURSO_AUTH_TOKEN`, `PSI_API_KEY`: replaced 2026-11-04.
- [x] `AUTH_SECRET` on the Worker; R2, Turso and sync secrets in Actions: set.
