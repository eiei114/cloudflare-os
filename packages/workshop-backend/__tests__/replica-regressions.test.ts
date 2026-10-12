import {describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import {applyCodeChange, type CodeChange} from "@gadgets/workshop-shared/code-change";
import {replicaTextHash} from "../src/workspace-replica";
import {runAgent} from "../src/agent";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}
type Impl = OverseerDurableObject["impl"];
const AUTHOR = {type: "agent" as const, id: "test", name: "Test"};
const USER = {type: "user" as const, id: "test-user", name: "Test"};
async function inKernel<T>(name: string, test: (impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), async instance => {
    const impl = instance["impl"];
    impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true}}';
    for (const id of [31, 32]) if (!impl.storage.gatekeepers.get(id)) {
      impl.storage.gatekeepers.put({id, class: impl.ctx.exports.AgentSpawnerGatekeeper({props: {
        overseerId: impl.ctx.id.toString(), config: {displayName: "Replica fixture", modelId: null, env: {}},
      }}), creationSpec: {type: "ambient", vendorId: "container"}});
    }
    try { return await test(impl); }
    finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
  });
}
async function step(impl: Impl, chatId: number, change: CodeChange) {
  await impl.commitAgentStep(chatId, AUTHOR, [], {changes: [{change}], createdGadgets: [],
    createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: []});
}
async function worktree(impl: Impl, chatId = 1, files = new Map([["a.txt", "aaa"]])) {
  const timestamp = impl.getChatTimestamp();
  impl.storage.chatMeta.put({id: chatId, title: "Replica", started: timestamp, lastActive: timestamp});
  const commit = await impl.gitStore.writeFilesAsCommit(files, {parents: [],
    author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
  const tree = await impl.createWorktree("Repo", chatId, commit);
  impl.storage.chatContext.put({chatId, bindings: {REPO: tree.id}});
  await impl.commitAgentStep(chatId, AUTHOR, [], {changes: [], createdGadgets: [],
    createdWorktrees: [{worktreeId: tree.id, title: tree.title, bindingName: "REPO"}],
    addedBindings: [], worktreeCommits: [], blueprintMerges: []});
  return tree;
}
async function open(impl: Impl, chatId = 1, gatekeeperId = 31) {
  const origin = impl.captureIntegrationOrigin({from: "agent", chatId})!;
  return impl.getIntegrationContext(gatekeeperId, origin)!.openWorktreeReplica();
}

describe("replica review regressions over durable kernel storage", () => {
  it.each(["set", "delete/recreate"])("preserves canonical %s replacement semantics against a concurrent edit", mode => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl, 1, new Map([["a.txt", "one\ntwo\n"]]));
    await impl.beginAgentIntegrationTurn(1);
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    if (mode === "delete/recreate") await step(impl, 1, {[tree.id]: [["a.txt", {remove: true}]]});
    await step(impl, 1, {[tree.id]: [["a.txt", {set: "ONE\ntwo\n"}]]});
    const receipt = await replica.submitBatch({batchId: "replacement", baseCursor: checkpoint.cursor, files: [
      {checkoutId: tree.id, path: "a.txt", baseHash: await replicaTextHash("one\ntwo\n"),
        change: {edit: [4, [3, "TWO"], 1]}},
    ]});
    const content = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
    expect(content.get(tree.id)?.get("a.txt")).toBe("ONE\ntwo\n");
    expect(receipt.accepted[0].hash).toBe(await replicaTextHash("ONE\ntwo\n"));
  }));

  it.each(["live", "stored"])("preserves spawned-chat write restrictions on the %s replica path", mode => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    const commit = await impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "safe"]]), {
      parents: [], author: {name: "Test", email: "test@example.com"}, message: "Gadget", timestamp: new Date(0),
    });
    const gadgetId = 100;
    impl.storage.gadgets.put({type: "gadget", id: gadgetId, title: "Read-only gadget",
      bindingName: "SHARED", bindings: {}, created: new Date(0), commitId: commit});
    impl.storage.chatContext.put({chatId: 1, bindings: {REPO: tree.id, SHARED: gadgetId},
      alwaysAvailableCapsuleIds: [], spawnerConfig: {displayName: "Spawned", modelId: null, env: {}}});
    impl.addChatMessages(1, USER, [{type: "message", message: "Work on the repo; the gadget is read-only."}]);
    await impl.beginAgentIntegrationTurn(1);
    const checkReplica = async () => {
      const replica = await open(impl), checkpoint = await replica.checkpoint();
      expect(checkpoint.worktrees.some(item => item.checkoutId === gadgetId)).toBe(true);
      await expect((async () => { await replica.submitBatch({batchId: "forbidden", baseCursor: checkpoint.cursor, files: [
        {checkoutId: gadgetId, path: "a.txt", baseHash: await replicaTextHash("safe"), change: {set: "hacked"}},
      ]}); })()).rejects.toThrow(/permission to edit/);
      expect([...impl.storage.worktreeReplicaCommits.list()]).toEqual([]);
      await replica.submitBatch({batchId: "allowed", baseCursor: checkpoint.cursor, files: [
        {checkoutId: tree.id, path: "a.txt", baseHash: await replicaTextHash("aaa"), change: {edit: [3, [0, "!"]]}},
      ]});
      const content = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
      expect(content.get(gadgetId)?.get("a.txt") ?? await impl.readFileAtCommit(commit, "a.txt")).toBe("safe");
      expect(content.get(tree.id)?.get("a.txt")).toBe("aaa!");
    };
    if (mode === "stored") await checkReplica();
    else {
      const faux = createFauxCore({models: [{id: "faux-model"}]});
      faux.setResponses([async () => {
        await checkReplica();
        return fauxAssistantMessage(fauxToolCall("writeFile", {workpiece: "SHARED", filename: "a.txt", content: "hacked"}),
          {stopReason: "toolUse"});
      }, fauxAssistantMessage(fauxText("Done."))]);
      await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
        new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: ""});
      const calls = [...impl.storage.chats.list()].flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
      expect(calls.find(call => call.toolName === "writeFile")?.error).toMatch(/permission to edit/);
    }
  }));

  it("keeps tiny accepted and pending edits as deltas across eviction", async () => {
    const name = crypto.randomUUID(), text = "a".repeat(400_000);
    const id = await inKernel(name, async impl => {
      const tree = await worktree(impl, 1, new Map(["a", "b", "c"].map(path => [path, text])));
      await step(impl, 1, {[tree.id]: ["a", "b", "c"].map(path => [path, {edit: [[1, "z"], 399_999]}])});
      expect(await impl.mergeChanges(1, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
      await step(impl, 1, {[tree.id]: [["a", {edit: [399_999, [1, "x"]]}]]});
      return tree.id;
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      await impl.beginAgentIntegrationTurn(1);
      // Bootstrap must export operations without asking for flattened workspace contents.
      impl.getCurrentChatContent = async () => { throw new Error("Checkpoint flattened file contents"); };
      const replica = await open(impl), checkpoint = await replica.checkpoint();
      const cursor = await replica.readOverlay(checkpoint.checkpointId), overlay = await cursor.next();
      expect(overlay).toHaveLength(3);
      expect(overlay!.every(item => "edit" in item.change)).toBe(true);
      expect(JSON.stringify(overlay).length).toBeLessThan(1000);
      const change: CodeChange = {[id]: overlay!.map(item => [item.path, item.change])};
      const content = applyCodeChange(new Map([[id, new Map(["a", "b", "c"].map(path => [path, text]))]]), change);
      expect(content.get(id)?.get("a")).toBe("z" + text.slice(1, -1) + "x");
      expect(content.get(id)?.get("b")).toBe("z" + text.slice(1));
      expect(await cursor.next()).toBeNull();
      expect(impl.storage.gadgets.get(id)?.type).toBe("worktree");
    });
  });

  it("retains live-lease anchor history past the ordinary TTL, including after eviction", async () => {
    const name = crypto.randomUUID();
    const saved = await inKernel(name, async impl => {
      const tree = await worktree(impl);
      await impl.beginAgentIntegrationTurn(1);
      const replica = await open(impl), checkpoint = await replica.checkpoint();
      await replica.submitBatch({batchId: "first", baseCursor: checkpoint.cursor, files: [
        {checkoutId: tree.id, path: "a.txt", baseHash: await replicaTextHash("aaa"), change: {edit: [1, [0, "X"], 2]}},
      ]});
      const rows = [...impl.storage.chatChanges.list()];
      for (const row of rows) {
        impl.storage.chatChanges.put({...row, timestamp: new Date(Date.now() - 61_000)});
      }
      return {id: tree.id, leaseId: checkpoint.cursor.split(":")[0]};
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const replica = impl.getWorkspaceReplicaSession(saved.leaseId);
      await replica.renew();
      await step(impl, 1, {[saved.id]: [["a.txt", {edit: [4, [0, "D"]]}]]});
      const checkpoint = await replica.checkpoint();
      const page = await replica.changesSince(checkpoint.cursor, 128);
      expect(page.events).toHaveLength(3);
      await replica.submitBatch({batchId: "second", baseCursor: page.cursor, files: [
        {checkoutId: saved.id, path: "a.txt", baseHash: await replicaTextHash("aXaaD"), change: {edit: [5, [0, "!"]]}},
      ]});
      expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(saved.id)?.get("a.txt"))
        .toBe("aXaaD!");
      await replica.release();
      await step(impl, 1, {[saved.id]: [["a.txt", {edit: [6, [0, "end"]]}]]});
      expect([...impl.storage.chatChanges.list()].some(row => row.timestamp.getTime() < Date.now() - 60_000)).toBe(false);
    });
  });

  it("allows disjoint chats and independent replicas, with lease-local echo provenance", () => inKernel(crypto.randomUUID(), async impl => {
    const a = await worktree(impl, 1), b = await worktree(impl, 2);
    await impl.beginAgentIntegrationTurn(1); await impl.beginAgentIntegrationTurn(2);
    const first = await open(impl, 1), second = await open(impl, 1, 32), disjoint = await open(impl, 2);
    const one = await first.checkpoint(), two = await second.checkpoint();
    expect((await disjoint.checkpoint()).worktrees.map(tree => tree.checkoutId)).toEqual([b.id]);
    await step(impl, 1, {[a.id]: [["a.txt", {edit: [[0, "a"], 3]}]]});
    await first.submitBatch({batchId: "collision", baseCursor: one.cursor, files: [
      {checkoutId: a.id, path: "a.txt", baseHash: await replicaTextHash("aaa"), change: {edit: [[0, "X"], 3]}},
    ]});
    const own = await first.changesSince(one.cursor, 128), other = await second.changesSince(two.cursor, 128);
    expect(own.events.map(event => event.sourceBatchId)).toEqual([undefined, "collision", "collision"]);
    expect(own.events[1].changes).toHaveLength(1);
    expect(other.events.every(event => event.sourceBatchId === undefined)).toBe(true);
    await second.submitBatch({batchId: "collision", baseCursor: two.cursor, files: [
      {checkoutId: a.id, path: "a.txt", baseHash: await replicaTextHash("aaa"), change: {edit: [3, [0, "Y"]]}},
    ]});
    expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(a.id)?.get("a.txt")).toBe("aXaaaY");
    expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(2);
  }));

  it("tags only replica writes when one step also flushes ordinary DO edits", () => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    await impl.beginAgentIntegrationTurn(1);
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    const leaseId = checkpoint.cursor.split(":")[0];
    await impl.commitAgentStep(1, AUTHOR, [], {
      changes: [
        {change: {[tree.id]: [["a.txt", {edit: [3, [0, "D"]]}]]}},
        {change: {[tree.id]: [["a.txt", {edit: [4, [0, "R"]]}]]}, replica: true},
      ], createdGadgets: [], createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: [],
      replicaCommit: {id: `${leaseId}:mixed`, leaseId, digest: "fixture",
        receipt: {batchId: "mixed", committedAt: "", accepted: [], corrections: []}},
    });
    const page = await replica.changesSince(checkpoint.cursor, 128);
    expect(page.events.map(event => event.sourceBatchId)).toEqual([undefined, "mixed", "mixed"]);
    expect(page.events.map(event => event.changes.length)).toEqual([1, 1, 0]);
  }));

  it("gives no-op acceptances their own marker without claiming the preceding DO edit", () => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    await impl.beginAgentIntegrationTurn(1);
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    await step(impl, 1, {[tree.id]: [["a.txt", {edit: [3, [0, "D"]]}]]});
    const receipt = await replica.submitBatch({batchId: "noop", baseCursor: checkpoint.cursor, files: []});
    const page = await replica.changesSince(checkpoint.cursor, 128);
    expect(page.events.map(event => event.sourceBatchId)).toEqual([undefined, "noop"]);
    expect(page.events[1].changes).toEqual([]);
    expect(page.cursor).toBe(receipt.committedAt);
  }));

  it("fences a closed code epoch and reacquires a genuinely new checkpoint", () => inKernel(crypto.randomUUID(), async impl => {
    const tree = await worktree(impl);
    await impl.beginAgentIntegrationTurn(1);
    const origin = impl.captureIntegrationOrigin({from: "agent", chatId: 1})!;
    const replica = await open(impl), checkpoint = await replica.checkpoint();
    await step(impl, 1, {[tree.id]: [["a.txt", {edit: [[0, "a"], 3]}]]});
    await impl.closeAgentIntegrationTurn(1, "approval");
    expect(await impl.mergeChanges(1, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
    await expect((async () => { await replica.renew(); })()).rejects.toThrow(/epoch changed/);
    const next = await impl.getIntegrationContext(31, origin, "applyingAction")!.openWorktreeReplica();
    const fresh = await next.checkpoint();
    expect(fresh.checkpointId).not.toBe(checkpoint.checkpointId);
    expect(fresh.worktrees[0].baseCommit).toBe(checkpoint.worktrees[0].baseCommit);
    const cursor = await next.readOverlay(fresh.checkpointId);
    expect(await cursor.next()).toEqual([{checkoutId: tree.id, path: "a.txt", change: {edit: [[0, "a"], 3]}}]);
  }));

  it.each([Uint8Array.of(239, 187, 191, 65), Uint8Array.of(255, 65)])(
    "preserves attachment bytes without lossy UTF-8 projection (%j)", bytes => inKernel(crypto.randomUUID(), async impl => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: bytes, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/csv", name: "input.csv",
      }});
      const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()),
        {profile: USER}, "Read this CSV", undefined, [{id}]);
      expect(await impl.getChatAttachmentData(chatId, id)).toEqual(bytes);
      const attachment = impl.storage.chatAttachmentContent.get(id)!;
      const context = impl.getChatAgentContext(chatId);
      if (bytes[0] === 255) {
        expect(context.attachments).toBeUndefined();
        expect(attachment.data).toEqual(bytes);
      } else {
        expect(context.attachments).toBeDefined();
        expect(attachment.data).toBeUndefined();
        const tree = impl.storage.gadgets.get(context.attachments!.worktreeId)!;
        expect(tree.type === "worktree" && await impl.readFileAtCommit(tree.baseCommit, "input.csv")).toBe("\ufeffA");
      }
    }),
  );
});
