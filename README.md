# AssetWeave

Keep game artwork, alternatives, and production history together.

AssetWeave is a local-first game-art workbench for solo and indie developers using AI agents. Its browser and MCP interface share records for finding artwork, comparing candidates, and continuing from recorded context instead of scattered files and chats.

[Workflow](#a-workflow-you-can-return-to) · [Current status](#current-status) · [Get started](#get-started) · [Documentation](#documentation)

## Artwork organized around the work

A character, prop, or environment can have several directions, derived outputs, and different uses. A folder name alone does not tell you which result you selected, what you reviewed, or what produced a later version.

Projects contain logical assets: the things you are making. Named slots represent their purposes, such as a portrait or Walk animation. Captured artifacts are the concrete outputs. Keep alternatives and rejected work alongside their decision history.

The developer makes the creative decisions. Agents can retrieve context and handle recordkeeping through MCP; generation and editing happen in external tools. Importing existing human-made artwork does not require a generator account or a managed request.

## What stays with the artwork

- **Logical assets and purpose-specific slots.** Compare whole artifacts or named clips for a particular use. The same captured result can appear in several slots without changing its original ownership or lineage. Placement does not imply approval or selection.
- **Exact originals, separate from previews.** Captures preserve submitted bytes and ordered members, with hashes and operation receipts. Download an original even when its format cannot be previewed. A successful capture is not a claim that the media can be displayed or played.
- **Sourced production history.** Record producer, prompt, parameters, and other claims with their sources. Keep actual inputs distinct from a request's proposed inputs, including multiple-input branches and exact clip revisions. Missing history can be an explicit gap; facts can remain unknown or absent. Corrections retain earlier revisions rather than inventing a complete origin story.
- **Human review, independent selection.** Review a candidate as unreviewed, reviewed-undecided, approved, or rejected. Selection is a separate decision for its slot: multiple approvals can coexist with no selection. Viewed artwork, review status, and current selection are separately labeled; simply opening a record changes none of them.
- **Searchable records shared with agents.** Find artwork by recorded facts, text, or historical values, then inspect lineage and decisions. MCP exposes the same records, exact revisions, and task context to an agent. It returns ambiguous identities for clarification rather than choosing for you; agent-relayed creative decisions require an explicit reported human instruction.

## A workflow you can return to

1. **Set the context.** Create a project, logical asset, and any named slots needed for the work. Add notes that explain the intended use.
2. **Make or import artwork.** For new external work, record a request before invoking the producer separately. Capture its output and report the outcome when known. For an existing file, capture it directly without inventing a request or missing provenance.
3. **Record what actually happened.** Attach sourced claims, exact inputs and their roles, and any upstream gaps. A captured output does not turn an unreported request outcome into success.
4. **Inspect and decide.** Browse alternatives, preview supported media, and configure clips where needed. Record review and selection deliberately; optionally set an asset stage yourself.
5. **Continue later.** Search current or historical records and retrieve the relevant context through the browser or MCP. Earlier directions, decisions, and pinned clip revisions remain available to inspect.

### Where this helps

- **Revisit an earlier direction:** find a character candidate and inspect its recorded prompt, inputs, and review history before requesting another iteration.
- **Track a derived output:** retain an externally generated original and a separately captured conversion, with the conversion's actual input and source information instead of copied attribution.
- **Compare animation candidates:** define Walk or Attack clips from a regular PNG sheet or ordered PNG sequence. Compare them in a slot while retaining the exact older playback revisions used by prior work.

## Current status

AssetWeave is a working local application on **Windows**. Browser capture, search, review, playback, retained originals after restart, and fresh-agent MCP context reconstruction have been exercised locally. See the [verification record](docs/verification/first-art-workflow.md) for evidence and limitations.

Inline inspection supports fully decoded **PNG and GIF** within documented limits. Regular PNG sheets and ordered same-sized PNG sequences support explicitly configured clips with frame order and timing; irregular atlases remain still-only. Generation and editing are not built in. There is no cloud sync or engine-project synchronization.

Founder acceptance remains open: asset-state clarity, decision-ready retrieval time, history reconstruction, and continuity still require human participation. Local verification is not a claim of measured time savings or final product acceptance.

## Get started

Requirements: **Windows, Node.js 24.21.0, Windows PowerShell 5.1, and Corepack**. The workspace pins **pnpm 12.6.0**; no global pnpm installation is required.

From the checkout root:

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm start
```

Leave the service running and open the exact `http://127.0.0.1:<port>` address it prints. In a second interactive terminal, from the same checkout:

```sh
corepack pnpm pair
```

Press Enter and paste the code into the browser pairing form. Codes expire after two minutes, work once, and are replaced when you request another. Closing the browser does not stop the service; Ctrl+C does. Restarting invalidates browser sessions, bridge credentials, and pairing codes.

The default private profile is `%LOCALAPPDATA%/AssetWeave`. Keep it on a fixed local drive, outside the checkout and synchronized folders; it contains artwork and access credentials. There is no managed backup/restore command. For a manual backup, stop the service and retain the entire profile together in protected storage. See [private-profile and recovery guidance](docs/local-workflow.md#private-profile) before changing its location or investigating an interruption.

## Documentation

- [Local workflow and operations](docs/local-workflow.md): setup, privacy, capture, media limits, decisions, search, and recovery.
- [MCP connection](docs/local-workflow.md#agent-connection-mcp): host configuration and service/bridge lifecycle.
- [Product strategy](STRATEGY.md): intended users, boundaries, and goals.
- [Implementation plan](docs/plans/2026-09-29-1434-feat-first-complete-art-workflow-plan.md) and [verification evidence](docs/verification/first-art-workflow.md): implementation contract, exercised behavior, and acceptance limitations.

## Technical overview

A TypeScript/pnpm workspace combines a NestJS/Fastify local service, Svelte browser UI, SQLite records, and immutable artwork files. The service owns application behavior and serves the browser and API on IPv4 loopback. A separate MCP stdio bridge connects to that independently running service; it does not start the service or generate artwork.

## Contributing

For changes, run the existing local checks on Windows:

```sh
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
```

See [local checks](docs/local-workflow.md#local-checks) for their scope. Exercise changed browser or MCP behavior as well; a green test run does not establish human product acceptance.

## License

No license is declared in this repository. Do not assume permission to reuse, modify, or redistribute its contents.
