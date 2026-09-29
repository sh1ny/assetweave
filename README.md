# AssetWeave

AssetWeave preserves local artwork and its recorded production history. The product contract is in `STRATEGY.md`; the implementation contract is in `docs/plans/2026-09-29-1434-feat-first-complete-art-workflow-plan.md`.

## Run the local service

Requirements: Windows, Node.js 24.21.0, Windows PowerShell 5.1, and Corepack. The workspace pins pnpm 12.6.0. No global pnpm installation is required.

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm start
```

Open the exact `http://127.0.0.1:<port>` address printed by the service. In a second interactive terminal, from this checkout:

```sh
corepack pnpm pair
```

Press Enter to request a code, then paste it into the browser pairing form. Codes expire after two minutes and can be used once. Requesting a new code replaces the outstanding code. Codes are not placed in URLs, application logs, or static assets.

The service runs independently of the browser. Closing a tab or ending a browser session does not stop it. Stop the foreground service with Ctrl+C. Restarting invalidates existing browser sessions, bridge credentials, and pairing codes.

## Private profile

The default profile is `%LOCALAPPDATA%/AssetWeave`. Set `ASSETWEAVE_DATA_DIR` before starting the service and before invoking the pairing launcher to choose another profile. Its parent directory must already exist. Set `ASSETWEAVE_PORT` to choose a nondefault port; the default is 4317.

The profile must be outside the application checkout, on a fixed local drive, and outside synchronized folders. Startup rejects Windows-registered sync roots and configured OneDrive roots; do not use another live-synchronized folder merely because its synchronizer does not register with Windows.

A new profile receives a protected ACL owned by the current Windows user. Startup verifies ownership, permissions, and the absence of reparse points throughout the profile and checks ancestors for replacement authority. Existing insecure directories are refused, not silently repaired. System and administrators remain trusted; other principals cannot receive profile access. The profile contains private discovery credentials: do not share or publish it.

Only one live service may own a profile. A stale ownership lock is reclaimed only when its recorded process is confirmed absent. Malformed locks or an abandoned recovery gate require inspection; do not delete a lock belonging to a live process.

Browser access requires pairing, an HttpOnly SameSite=Strict session, and same-origin CSRF-protected mutations. The stdio bridge uses a separate startup-rotated bearer credential. The service binds only IPv4 loopback, validates the exact Host, refuses foreign origins before body parsing, and does not trust reverse proxies. Same-user malware, administrators, and compromised agent hosts are outside this boundary.

## Local checks

```sh
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
```

The current runtime tests exercise real Windows ACLs and loopback listeners, not mocked permission checks. Test profiles are isolated under local application data because the system temporary directory may grant other principals inherited access.

Exercised evidence and acceptance limitations are recorded in `docs/verification/first-art-workflow.md`.
