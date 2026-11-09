# Owner to-do

## Keys

Checked 2026-11-09 against the secret names on the Worker and in GitHub Actions (names only, no values).
New values go into the owner's pass-env store and are sent with `pass-env pipe <entry> -- <command>`; never commit or paste a value.

- [ ] `GEMINI_API_KEY` Actions secret: set, but the key no longer works, so grading workflows have failed since late July (PR #10). Make a new key, then `pass-env pipe portfolio-rank/GEMINI_API_KEY -- gh secret set GEMINI_API_KEY -R n8watkins/portfolio-rank`.
- [x] `TURSO_AUTH_TOKEN`, `PSI_API_KEY`: replaced 2026-11-04.
- [x] `AUTH_SECRET` on the Worker; R2, Turso and sync secrets in Actions: set.
