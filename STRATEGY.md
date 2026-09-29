---
name: AssetWeave
last_updated: 2026-09-29
---

# AssetWeave Strategy

## Purpose

Solo game developers iterating on artwork in freely named folders struggle to review what they have and find the artifact they need. Scattered files and decision history make it hard to see progress or resume an earlier direction without spending time reconstructing context.

## Positioning

AssetWeave is a local-first, agent-native game-art pipeline that organizes work around logical assets and their artifact lineage rather than folder locations. Developers accept deliberate organization, while AI agents carry context and handle recordkeeping across external art tools, making work easier to find, review, and iterate without turning the developer into a filing clerk.

## Users

**Primary:** Technically capable solo/indie game developers working heavily with AI agents — they hire AssetWeave to carry an artwork request from concept through derived outputs under the right project and logical asset, keeping enough context to compare alternatives and direct the next iteration.

The developer remains the creative decision-maker; agents handle execution and recordkeeping. Small-team use should remain intelligible, but does not drive initial product decisions.

## Boundaries

- **Pipeline, not art creation or editing:** integrations with generators and editors, not an image generator, pixel-art editor, or Photoshop/Krita replacement
- **Solo developer first:** no initial optimization for studio-scale collaboration, enterprise DAM, generic project management, or Git/Perforce replacement
- **Independently useful locally:** no required cloud account or AssetWeave-owned online service; no hosted AI service, cloud-storage business, marketplace, or collaboration SaaS
- **Art workflow before engine integration:** no initial tight engine-project synchronization or Godot-editor replacement; Godot as an important later target, not a core dependency; a selected version is not a verified in-game version
- **Trustworthy records over apparent progress:** capture separate from approval; rejected work retained by default; missing provenance explicitly unknown; creative approval and selection human-controlled by default

_Resist a change when:_ it hides uncertainty, removes creative control, or expands tool coverage and adjacent product responsibilities at the expense of finding, reviewing, and continuing artwork.

## Key metrics

Initially measured through manual checks in the founder's own game-art workflow, using local project records rather than hosted analytics.

- **Asset-state clarity** — proportion of sampled assets where the developer can correctly identify the current stage, approved alternatives, and selected version, including an explicit absence of selection; checked against recorded local decisions
- **Decision-ready retrieval time** — time to find the intended artifact and establish enough context for the next iteration decision; measured through timed tasks in the developer's own workflow
- **History reconstruction success** — proportion of sampled results whose exact recorded inputs, steps, and decisions can be traced without searching old chats or unrelated folders; checked against local provenance records, with missing history identified rather than inferred

## Tracks

### Agent-driven workflow continuity

Enable agents to establish project and asset context and carry work between external tools without repeated explanations or manual filing, with MCP as a first-class interface and the human UI operating on the same domain model.

_Why it serves the approach:_ agents do the coordination and recordkeeping that make deliberate organization practical.

### Asset review and decision clarity

Make artwork easy to find and compare, with visible stages, approved alternatives, and an explicit selected version.

_Why it serves the approach:_ the developer can decide what to do next from recorded progress instead of reconstructing it from folders and chats.

### Trustworthy lineage and history

Keep logical assets distinct from concrete artifacts, preserving exact source relationships, multiple-input derivations, branches, and past decisions rather than flattening history into a revision counter.

_Why it serves the approach:_ earlier directions remain usable, and developers can trace how a result was reached and which downstream work depends on a superseded source.

### Generator-independent interoperability

Connect external generators, art tools, and human-created files through a common integration model, with narrow initial coverage driven by the founder's actual workflow.

_Why it serves the approach:_ no single generator defines the asset model, and tools can change without discarding the context and history needed to continue work.
