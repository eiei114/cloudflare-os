# Agent integrations and worktree replicas

The kernel remains authoritative for worktrees and their existing `FileChange` transforms.
An integration may keep a fully materialized replica, but never takes ownership of ordinary
agent file operations. Linux runners, images, filesystem implementations, network policy and
snapshots, mount names and single-container policy belong to the integration, not to
`workshop-backend`. Filesystem-to-OT calculation also belongs to the integration. The kernel
only validates scoped anchors and orders submitted transforms using the existing OT engine;
it must never re-diff canonical contents to approximate the journal's operations.

## Authority and lifecycle

`AGENT_INTEGRATION_GRANTS` is trusted deployment configuration, keyed by vendor ID. Its
independent `lifecycle`, `contextualActions`, `worktreeReplica` and `recoverableActions` flags
default to denied. Account provisioning/ambient enablement remains the existing user/admin
policy; a connector cannot grant itself integration privileges.

An eligible agent session obtains an ephemeral `AgentContext` from its approval queue. It can
register a persistent, binding-scoped lifecycle participant and acquire a persistent replica
capability. Contextual action application receives fresh capabilities tied to the original
approved action and logical turn, even after approval delays or eviction. It never falls back
to legacy application after a partial contextual dispatch.

One logical turn may have several invocation segments. Started/resumed/suspended/finished
events have durable IDs and an at-least-once outbox. Participants must deduplicate them.
Nested approvals use the existing action queue: durable submission does not grant permission.
Recoverable actions retain their origin and dispatch identity across resets rather than
executing under a new user prompt.

Lifecycle contexts retain their participant's registration-time worktree selection through retries
and resumed segments; they never acquire later-added bindings implicitly. Replica reads may include
gadgets a spawned agent can inspect, but replica writes obey that chat's ordinary file-tool rules:
spawned agents may modify worktrees, not gadget code. Both live and stored ingestion enforce this.

Active continuations persist the initiating request before asynchronous startup, and each published
integration segment records its execution identity. Recovery skips inference for a completed segment
only when its terminal journal belongs to that continuation; older cleanup cannot discard a new prompt.
If model recovery fails, terminal callbacks are journalled before active state is cleared and the alarm
retries failed cleanup. Malformed model transforms are rejected before buffering and logged with only
stage/count diagnostics, preserving their tool-error transcript instead of aborting at persistence.

## Bootstrap and synchronization

1. Acquire a revocable, expiring lease for the captured worktree selection.
2. Capture a checkpoint containing binding/source metadata, immutable base identities,
   composed transforms, and an exact canonical cursor. The integration chooses collision-free
   paths for repository, gadget and attachment worktrees and retains those paths in snapshots.
3. Enumerate and stream base bytes separately from the transform overlay. No whole-repository
   content buffer or base64 transfer is introduced. A provider may alternatively serve a
   validated native Git v2 pack for the already-advertised exact base commit. GitHub and GitLab
   implement this through the shared gatekeeper-kit validator and their authenticated
   upload-pack transports, including configured Access credentials for self-hosted GitLab.
   Source credentials
   and unrelated repository grants never enter the replica; Git bootstrap is explicitly closed
   before exposing it for agent commands.
4. Replay ordered canonical events through `changesSince()`. A receipt's acceptance marker is
   not a replay cursor: clients must consume every intervening event before advancing.
5. Submit frozen, bounded text transforms anchored by canonical cursor and SHA-256. The kernel
   checks path/checkout scope and base anchors, applies the existing OT resolution rules, and
   atomically stores a payload-bound batch receipt. Identical retries return the same receipt;
   reusing an ID for different content fails. Corrections bring the replica to canonical content.
6. Renew within the original grant/turn bounds; release fences further writes without removing
   already accepted changes. Live leases retain their required journal rows beyond the ordinary
   retired-row TTL, so caught-up clients can reconstruct anchors after long commands or DO resets.
   Expiry/revocation or an epoch change requires reacquiring a lease and checkpoint, not replaying
   an empty successful page. A checkpoint is immutable for its lease.

Journal events tag each replica-owned OT row with its batch, including an empty acceptance marker
for no-op batches. Ordinary DO edits flushed at the same barrier are not tagged. Echo batch IDs
are lease-local: another replica never mistakes a coincidentally equal batch ID for its own write.

UTF-8 text attachments become ordinary worktree files; BOMs are preserved as content, and downloads
read the original Git blob bytes. Rev 0 leaves non-UTF-8 attachments in the byte-preserving attachment
store rather than silently substituting replacement characters into a text worktree.

The bootstrap API preserves Git modes and binary base bytes. Rev 0 mutation submission is text
only; it does not promise arbitrary binary/mode/Gitlink mutation support. A client cannot push
commits to a source repository through this capability. Unacknowledged local effects remain
subject to the integration's explicitly documented crash/loss boundary.

## Review and verification

The public kernel contains no Linux image, container service binding, standalone shell tool or
integration-specific release grant. The optional ambient connection card is generic; accepting
it uses the existing provisioning policy, not a new resource picker or authorization bypass.

Workerd tests cover contextual recovery, outbox eviction, grant/revocation checks, bounded raw
binary RPC transfer, anchored batch deduplication and deterministic bidirectional collisions.
The native Git bootstrap fixture uses a separate real Git server. Kernel transfer fixtures are
independent sinks: they do not import a private integration package.

## Storage and porting

Integration journals, leases, receipts, accepted OT prefixes, and attachment references live in
`storage-schema/overseer-storage.ts`. Schema version 6 adds their empty collections without
eagerly fetching repository contents. Checkout IDs are existing workpiece IDs; source provenance
remains in worktree records and the OID store, without a separate filesystem/repository catalog.
Replica overlays use the same compacted-history fold as agent replay, followed by live OT rows.
At accept, the original operations compose into a per-path durable prefix relative to a stable
hydration commit. Bootstrap therefore retains positional intent and small deltas across accepts,
compaction and eviction without loading untouched file contents or expanding edits to full-file sets.
Pre-prototype worktrees without that prefix start from their current accepted commit; if it is
local-only, the integration uses binary base streaming rather than fetching it from a provider.

Retention is deliberately lease-bounded, not a longer global TTL: a long live lease retains more
journal rows on disk, and ordinary lazy pruning resumes after it ends. Advancing compact per-client
anchors to reduce that retention is a future optimization, not another merge algorithm.

Bootstrap adapters validate the immutable commit before contacting upstream and return the
binary response stream directly. Native Git tests belong in gatekeeper-kit; provider workerd
tests cover authentication, project scope, failures, and streaming. DO cache pulls are a separate
protocol path and must not inherit native Git's `have` negotiation semantics.
