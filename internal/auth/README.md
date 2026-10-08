# Authentication boundary

The first server profile does not enable login. `internal/auth` defines the
interfaces for server-side sessions so a later login flow can use Argon2id
password hashes and opaque, revocable session cookies. Provider API keys are
never accepted in request bodies or returned to the browser.
