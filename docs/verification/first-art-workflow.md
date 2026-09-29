# First art workflow verification

This record distinguishes exercised behavior from acceptance still to be demonstrated. It is not a claim that the complete art workflow has passed.

## Runtime boundary — U1

Observed on Windows x64 with Node.js 24.21.0 and Windows PowerShell 5.1:

- Actual bundled SQLite version: 3.53.4; FTS5 compile option enabled. Persistence startup enforcement belongs to the database implementation and is not established by this probe.
- Dependency installation completed with pinned pnpm 12.6.0 through Corepack.
- Production workspace build passed.
- Type checks passed; Svelte reported zero errors and zero warnings.
- Six runtime tests passed with zero skips. They use real temporary private profiles and loopback listeners.
- Verified exclusive live ownership, confirmed-dead-owner recovery, malformed-lock refusal, profile-bound credentials, startup credential rotation, pairing expiry/single use, CSRF enforcement, exact Host and Origin rejection, unauthorized media refusal, and API/media 404s that do not return the browser shell.
- Verified insecure profile/ancestor and junction rejection, checkout and sync-root exclusion, and hostile multipart rejection before staging.
- Actual browser smoke exercised `/`, `/pair`, and `/connection` against the production static build. Pairing established a browser session; navigation retained it; ending the session returned to the pairing form. Desktop and 390px mobile surfaces were inspected, with no horizontal overflow or uncaught browser errors observed.

Integration failures found and corrected: root scripts assumed a global pnpm executable; Nest listener return types were used incorrectly; malformed pairing attempts consumed a valid pending code; equal character counts in non-ASCII bearer tokens caused an invalid constant-time buffer comparison. Existing or extended runtime scenarios cover the authorization defects.

The initial test fixtures correctly failed under the machine's temporary directory because foreign principals had inherited Modify access. Tests were moved to isolated local-application-data directories; security checks were not bypassed. Ancestor checks were also corrected to distinguish sibling creation from authority to replace an existing path.

## Acceptance boundary

The main artwork interface has no approved visual design. The current pairing shell is not design approval for catalog or review screens.

No real producer round trip, fresh-agent artwork reconstruction, media playback exercise, or founder metrics have been demonstrated by the runtime checks above. Those remain separate requirements under the plan's Verification Contract.
