import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { Cursor } from "@gadgets/workshop-shared/gatekeeper";
import type { WorktreeBase, WorktreeBaseEntry, WorktreeChange, WorktreeChangesPage,
  WorktreeReplicaBatch, WorktreeReplicaReceipt, WorkspaceCheckpoint, WorkspaceReplica }
  from "@gadgets/workshop-shared/agent-integration";
import { applyCodeChange, composeCodeChange, codeChangeSerializedSize, type CodeChange }
  from "@gadgets/workshop-shared/code-change";
import { mergeReplicaBatch, replicaTextHash, type ReplicaBatch } from "./workspace-replica";

/** Persisted checkpoint and lease; IDs are bearer capabilities, not workspace lookup keys. */
export type WorktreeReplicaLease = {
  id: string;
  gatekeeperId: number;
  chatId: number;
  turnId: string;
  expiresAt: number;
  released?: boolean;
  /** Bootstrap authority is one-shot even if the replica remains live for synchronization. */
  gitBootstrapClosed?: boolean;
  worktrees: WorktreeBase[];
  checkpoint?: WorkspaceCheckpoint & { overlay: WorktreeChange[] };
};

/** Written in the same transaction as canonical OTs, never in a subsequent RPC. */
export type WorktreeReplicaCommit = {
  id: string;
  leaseId: string;
  digest: string;
  receipt: WorktreeReplicaReceipt;
};

/** Kernel storage/OT plumbing, not a parallel RPC interface. */
export interface WorktreeReplicaHost {
  requireLease(id: string): WorktreeReplicaLease;
  saveLease(lease: WorktreeReplicaLease): void;
  capture(lease: WorktreeReplicaLease): Promise<{ cursor: string; overlay: WorktreeChange[] }>;
  entries(lease: WorktreeReplicaLease, checkoutId: number): Promise<WorktreeBaseEntry[]>;
  baseFile(lease: WorktreeReplicaLease, checkoutId: number, path: string): Promise<Uint8Array>;
  /** Fetch only a lease-selected immutable repository commit, without storing its blobs. */
  gitPack?(lease: WorktreeReplicaLease, checkoutId: number, request: Uint8Array): Promise<ReadableStream<Uint8Array>>;
  events(lease: WorktreeReplicaLease, cursor: string, limit: number): WorktreeChangesPage;
  readCanonical(lease: WorktreeReplicaLease, checkoutId: number, path: string): Promise<string | undefined>;
  version(lease: WorktreeReplicaLease): string;
  getCommit(id: string): WorktreeReplicaCommit | undefined;
  commit(lease: WorktreeReplicaLease, version: string, change: CodeChange,
    receipt: WorktreeReplicaCommit): Promise<boolean>;
}

/** Filesystem aliases/private Git metadata must never become OID-store capabilities. */
export function requireReplicaPath(path: string): void {
  if (!path || path.length > 4096 || path.includes("\0") || path.includes("\\") ||
      path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error("Invalid replica path.");
  }
}

/** Fresh native session behind the persistent, lease-scoped entrypoint. */
@validateRpc()
export class WorktreeReplicaSession extends RpcTarget implements Pick<WorkspaceReplica,
  "checkpoint" | "listBaseEntries" | "readBaseFile" | "readOverlay" | "changesSince" |
  "readGitPack" | "closeGitBootstrap" | "submitBatch" | "renew" | "release"> {
  constructor(private host: WorktreeReplicaHost, private leaseId: string) { super(); }

  async checkpoint(): Promise<WorkspaceCheckpoint> {
    let lease = this.host.requireLease(this.leaseId);
    if (!lease.checkpoint) {
      const captured = await this.host.capture(lease);
      // Capture awaits source pulls. Revocation/expiry must still win at the publication barrier.
      lease = this.host.requireLease(this.leaseId);
      lease.checkpoint ??= { checkpointId: crypto.randomUUID(), cursor: captured.cursor,
        worktrees: lease.worktrees, overlay: captured.overlay };
      this.host.saveLease(lease);
    }
    const { overlay: _overlay, ...checkpoint } = lease.checkpoint;
    return checkpoint;
  }

  async listBaseEntries(checkpointId: string, checkoutId: number): Promise<Cursor<WorktreeBaseEntry>> {
    const lease = this.#checkpoint(checkpointId, checkoutId);
    const entries = await this.host.entries(lease, checkoutId);
    this.host.requireLease(this.leaseId);
    return new ReplicaCursor(entries, () => this.host.requireLease(this.leaseId));
  }

  async readBaseFile(checkpointId: string, checkoutId: number, path: string): Promise<ReadableStream<Uint8Array>> {
    requireReplicaPath(path);
    const lease = this.#checkpoint(checkpointId, checkoutId);
    const bytes = await this.host.baseFile(lease, checkoutId, path);
    this.host.requireLease(this.leaseId);
    // One bounded blob per request; no whole-repository content in an RPC return value.
    return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  }

  async readOverlay(checkpointId: string): Promise<Cursor<WorktreeChange>> {
    const lease = this.#checkpoint(checkpointId);
    return new ReplicaCursor(lease.checkpoint!.overlay, () => this.host.requireLease(this.leaseId));
  }

  async readGitPack(checkpointId: string, checkoutId: number, request: Uint8Array): Promise<ReadableStream<Uint8Array>> {
    const lease = this.#checkpoint(checkpointId, checkoutId);
    if (lease.gitBootstrapClosed || request.byteLength > 64 * 1024 ||
        lease.worktrees.find(tree => tree.checkoutId === checkoutId)?.source !== "repository") {
      throw new Error("Git bootstrap is closed or outside the granted repository.");
    }
    if (!this.host.gitPack) throw new Error("This repository source does not support native Git hydration.");
    const stream = await this.host.gitPack(lease, checkoutId, request);
    try {
      if (this.host.requireLease(this.leaseId).gitBootstrapClosed) throw new Error("Git bootstrap was revoked.");
    } catch (error) {
      await stream.cancel().catch(() => {});
      throw error;
    }
    return stream;
  }

  async closeGitBootstrap(checkpointId: string): Promise<void> {
    const lease = this.#checkpoint(checkpointId);
    lease.gitBootstrapClosed = true;
    this.host.saveLease(lease);
  }

  async changesSince(cursor: string, limit: number): Promise<WorktreeChangesPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error("Invalid replica page limit.");
    const lease = this.host.requireLease(this.leaseId);
    if (!lease.checkpoint) throw new Error("Replica needs a checkpoint.");
    return this.host.events(lease, cursor, limit);
  }

  async submitBatch(batch: WorktreeReplicaBatch): Promise<WorktreeReplicaReceipt> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(batch.batchId) || batch.files.length > 128 ||
        JSON.stringify(batch).length > 1024 * 1024) throw new Error("Replica batch exceeds its budget.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(JSON.stringify(batch)))).toHex();
    const commitId = `${this.leaseId}:${batch.batchId}`;
    for (let retry = 0; retry < 8; ++retry) {
      const lease = this.host.requireLease(this.leaseId);
      const prior = this.host.getCommit(commitId);
      if (prior) {
        if (prior.digest !== digest) throw new Error("Replica batch ID was reused with a different payload.");
        return prior.receipt;
      }
      if (!lease.checkpoint) throw new Error("Replica needs a checkpoint.");
      const version = this.host.version(lease);
      const seen = new Set<string>();
      let change: CodeChange = {};
      const receipt: WorktreeReplicaReceipt = { batchId: batch.batchId, committedAt: crypto.randomUUID(),
        corrections: [], accepted: [] };
      for (const tree of lease.worktrees) {
        const files = batch.files.filter(file => file.checkoutId === tree.checkoutId);
        const anchored: ReplicaBatch["files"] = [];
        for (const file of files) {
          requireReplicaPath(file.path);
          const key = `${file.checkoutId}:${file.path}`;
          if (seen.has(key)) throw new Error("Duplicate replica path.");
          seen.add(key);
          // Reconstruct exactly the anchor the caller claims, never trust a supplied 'before'.
          const anchor = await this.#anchor(lease, file.checkoutId, file.path, batch.baseCursor);
          if ("change" in file ? await replicaTextHash(anchor) !== file.baseHash : anchor !== file.before)
            throw new Error("Replica anchor does not match the consumed canonical cursor.");
          anchored.push("change" in file ? {path: file.path, before: anchor, change: file.change} : file);
          const entry = (await this.host.entries(lease, file.checkoutId)).find(candidate => candidate.path === file.path);
          if (entry && entry.mode !== "100644" && entry.mode !== "100755") {
            throw new Error("Replica mutations of symlinks and Gitlinks are unsupported.");
          }
        }
        if (!files.length) continue;
        const merged = await mergeReplicaBatch(tree.checkoutId, { batchId: batch.batchId, files: anchored },
          path => this.host.readCanonical(lease, tree.checkoutId, path));
        change = composeCodeChange(change, merged.change);
        receipt.corrections.push(...merged.ack.changes.map(([path, correction]) => ({ checkoutId: tree.checkoutId, path, change: correction })));
        for (const [path, content] of merged.ack.accepted)
          receipt.accepted.push(files.some(file => file.path === path && "change" in file)
            ? {checkoutId: tree.checkoutId, path, hash: await replicaTextHash(content)}
            : {checkoutId: tree.checkoutId, path, content});
      }
      if (seen.size !== batch.files.length) throw new Error("Replica batch names an ungranted checkout.");
      if (codeChangeSerializedSize(change) > 1024 * 1024) throw new Error("Replica OT transaction exceeds its budget.");
      this.host.requireLease(this.leaseId);
      if (await this.host.commit(lease, version, change, { id: commitId, leaseId: lease.id, digest, receipt })) return receipt;
    }
    throw new Error("Workspace kept changing during replica reconciliation; retry the same batch.");
  }

  async renew(): Promise<void> {
    const lease = this.host.requireLease(this.leaseId);
    this.host.saveLease({ ...lease, expiresAt: Date.now() + 60_000 });
  }
  async release(): Promise<void> {
    const lease = this.host.requireLease(this.leaseId);
    this.host.saveLease({ ...lease, released: true });
  }

  #checkpoint(checkpointId: string, checkoutId?: number): WorktreeReplicaLease {
    const lease = this.host.requireLease(this.leaseId);
    if (lease.checkpoint?.checkpointId !== checkpointId) throw new Error("Unknown replica checkpoint.");
    if (checkoutId !== undefined && !lease.worktrees.some(tree => tree.checkoutId === checkoutId)) {
      throw new Error("Checkout is outside this replica grant.");
    }
    return lease;
  }

  async #anchor(lease: WorktreeReplicaLease, checkoutId: number, path: string, cursor: string): Promise<string | null> {
    let bytes: Uint8Array;
    try { bytes = await this.host.baseFile(lease, checkoutId, path); }
    catch (error) {
      // Absence is determined by tree metadata, not by swallowing authorization/pull errors.
      if ((await this.host.entries(lease, checkoutId)).some(entry => entry.path === path)) throw error;
      bytes = new Uint8Array();
    }
    const exists = (await this.host.entries(lease, checkoutId)).some(entry => entry.path === path);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Replica mutations of binary files are unsupported.");
    let content = new Map([[checkoutId, new Map(exists ? [[path, text]] : [])]]);
    const apply = (changes: WorktreeChange[]) => {
      for (const item of changes) if (item.checkoutId === checkoutId && item.path === path) {
        content = applyCodeChange(content, { [checkoutId]: [[path, item.change]] });
      }
    };
    apply(lease.checkpoint!.overlay);
    let position = lease.checkpoint!.cursor;
    for (let pages = 0; position !== cursor; ++pages) {
      if (pages >= 128) throw new Error("Replica anchor history exceeds its replay budget; checkpoint again.");
      const page = this.host.events(lease, position, 128);
      let found = false;
      for (const event of page.events) {
        apply(event.changes);
        position = event.cursor;
        if (position === cursor) { found = true; break; }
      }
      if (!found && (!page.hasMore || !page.events.length)) throw new Error("Unknown replica anchor cursor.");
    }
    return content.get(checkoutId)?.get(path) ?? null;
  }
}

@validateRpc()
class ReplicaCursor<T extends WorktreeBaseEntry | WorktreeChange> extends RpcTarget implements Cursor<T> {
  #index = 0;
  constructor(private items: T[], private requireLive: () => unknown) { super(); }
  async next(): Promise<T[] | null> {
    this.requireLive();
    if (this.#index >= this.items.length) return null;
    const page = this.items.slice(this.#index, this.#index + 128);
    this.#index += page.length;
    return page;
  }
}
