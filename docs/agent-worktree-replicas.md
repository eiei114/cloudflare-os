# Agent integrations and worktree replicas

The kernel remains authoritative for worktrees and their existing `FileChange` transforms.
An integration may keep a fully materialized replica, but never takes ownership of ordinary
agent file operations. Linux runners, images, filesystem implementations, network policy and
snapshots belong to the integration, not to `workshop-backend`.

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

## Bootstrap and synchronization

1. Acquire a revocable, expiring lease for the captured worktree selection.
2. Capture a checkpoint containing mount/provenance metadata, immutable base identities,
   pending transforms, and an exact canonical cursor. Repository, gadget and attachment
   worktrees have collision-free mounts; attachments are ordinary indexed worktree content.
3. Enumerate and stream base bytes separately from the transform overlay. No whole-repository
   content buffer or base64 transfer is introduced. A provider may alternatively serve a
   validated native Git v2 pack for the already-advertised exact base commit. Source credentials
   and unrelated repository grants never enter the replica; Git bootstrap is explicitly closed
   before exposing it for agent commands.
4. Replay ordered canonical events through `changesSince()`. A receipt's acceptance marker is
   not a replay cursor: clients must consume every intervening event before advancing.
5. Submit frozen, bounded text transforms anchored by canonical cursor and SHA-256. The kernel
   checks path/checkout scope and base anchors, applies the existing OT resolution rules, and
   atomically stores a payload-bound batch receipt. Identical retries return the same receipt;
   reusing an ID for different content fails. Corrections bring the replica to canonical content.
6. Renew within the original grant/turn bounds; release fences further writes without removing
   already accepted changes. Expired cursors require a new checkpoint, not an empty success.

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
