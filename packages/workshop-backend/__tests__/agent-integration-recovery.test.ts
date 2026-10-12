import {env, RpcStub} from "cloudflare:workers";
import {evictDurableObject, runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {OverseerDurableObject} from "../src/overseer";
import {UserDurableObject} from "../src/user";
import type {IntegrationTestParticipant} from "./test-worker";
import {openFakeOverseer} from "./fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}
type Impl = OverseerDurableObject["impl"];
type TestExports = Cloudflare.Exports & {
  IntegrationTestParticipant(options: {props: {name: string}}): Fetcher<IntegrationTestParticipant>;
};
const GRANT = '{"container":{"lifecycle":true}}';
const USER = {type: "user" as const, id: "test-user", name: "Test"};
const MODEL = {profile: {type: "agent" as const, id: "recovery-model", name: "Recovery"},
  config: {provider: "anthropic" as const, model: "recovery-model", apiToken: "test-key", apiUrl: "https://recovery.test"}};

async function prepare(impl: Impl, name: string) {
  impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
  const timestamp = impl.getChatTimestamp();
  impl.storage.chatMeta.put({id: 1, title: "Recovery", started: timestamp, lastActive: timestamp});
  impl.addChatMessages(1, USER, [{type: "message", message: "First prompt."}]);
  impl.storage.gatekeepers.put({id: 31, class: impl.ctx.exports.AgentSpawnerGatekeeper({props: {
    overseerId: impl.ctx.id.toString(), config: {displayName: "Integration fixture", modelId: null, env: {}},
  }}), creationSpec: {type: "ambient", vendorId: "container"}});
  impl.storage.chatContext.put({chatId: 1, bindings: {}, alwaysAvailableCapsuleIds: []});
  await impl.beginAgentIntegrationTurn(1);
  const participant = (impl.ctx.exports as TestExports).IntegrationTestParticipant({props: {name}});
  await impl.registerIntegrationParticipant(31, impl.captureIntegrationOrigin({from: "agent", chatId: 1})!, "running", participant);
  return participant;
}

function providerReply(): Response {
  const events = [
    {type: "message_start", message: {id: "msg_recovery", type: "message", role: "assistant",
      model: "recovery-model", content: [], stop_reason: null, stop_sequence: null,
      usage: {input_tokens: 1, output_tokens: 1}}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "Recovered new prompt."}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn", stop_sequence: null}, usage: {output_tokens: 1}},
    {type: "message_stop"},
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {headers: {"content-type": "text/event-stream"}});
}

describe("integration cleanup at agent recovery boundaries", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each(["before suspension", "during cleanup", "after teardown"] as const)("recovers an accepted connection wake-up %s across eviction", async boundary => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(user, instance => {
      instance["storage"].profile.put(USER);
      instance["storage"].aiModels.put(MODEL);
    });
    let requests = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== MODEL.config.apiUrl) return realFetch(input, init);
      ++requests;
      return Promise.resolve(providerReply());
    });
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      const turn = impl.storage.agentIntegrationTurns.get(1)!;
      const continuationId = crypto.randomUUID();
      const record = {chatId: 1, initiatorUserId: user.id.toString(), modelId: MODEL.profile.id,
        initiator: USER, callbackInitiated: false, continuationId, requestKey: turn.requestKey};
      impl.storage.activeAgents.put(record);
      if (boundary !== "before suspension") impl.storage.pausedAgents.put(record);
      impl.storage.agentIntegrationTurns.put({...turn, continuationId});
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: MODEL.profile});
      impl.addChatMessages(1, MODEL.profile, [{type: "connectionRequest", requestId: "1:connection",
        vendorId: "github", vendorName: "GitHub", reason: "Read repo", state: "pending"}]);
      await participant.setFailure(true);
      if (boundary !== "before suspension") {
        await expect(impl.closeAgentIntegrationTurn(1, "connection")).rejects.toThrow(/unavailable/);
      }
      using client = new RpcStub(await openFakeOverseer({chats: impl.storage.chats, chatMeta: impl.storage.chatMeta,
        pausedAgents: impl.storage.pausedAgents, activeAgents: impl.storage.activeAgents}, {impl: {resumePausedAgent: impl.resumePausedAgent.bind(impl),
          getChatTimestamp: impl.getChatTimestamp.bind(impl)}}));
      await client.acceptConnectionRequest("1:connection", {gatekeeperId: 31});
      expect([...impl.storage.chats.list()].find(message => message.type === "connectionRequest"))
        .toMatchObject({state: "accepted"});
      expect(impl.storage.pausedAgents.get(1) ?? impl.storage.activeAgents.get(1))
        .toMatchObject({continuationId, resumeRequested: true});
      expect(requests).toBe(0);
      if (boundary === "before suspension") {
        // The ordinary turn finally copies its active record into the pause before callback I/O.
        impl.storage.pausedAgents.put(impl.storage.activeAgents.get(1)!);
        await expect(impl.closeAgentIntegrationTurn(1, "connection")).rejects.toThrow(/unavailable/);
      }
      await participant.setFailure(false);
      if (boundary === "after teardown") {
        await impl.closeAgentIntegrationTurn(1, "connection");
        // Fault between clearing the busy record and dispatching the queued wake-up.
        impl.storage.activeAgents.delete(1);
        const meta = impl.storage.chatMeta.get(1)!;
        delete meta.activeAgent;
        impl.storage.chatMeta.put(meta);
      }
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        // Constructor wake-up may still be waiting for message-preparation's microtask.
        await vi.waitFor(() => expect(requests).toBe(1));
        await impl.waitForAllAgentsToComplete();
        expect(requests).toBe(1);
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        expect(impl.storage.pausedAgents.get(1)).toBeUndefined();
        expect(impl.storage.chatMeta.get(1)?.activeAgent).toBeUndefined();
        expect(impl.storage.agentIntegrationTurns.get(1)?.closing?.kind).toBe("finished");
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it.each(["approval", "connection"] as const)("recovers interrupted %s teardown without inferring until an authorized wake-up", async reason => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(user, instance => {
      instance["storage"].profile.put(USER);
      instance["storage"].aiModels.put(MODEL);
    });
    let requests = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== MODEL.config.apiUrl) return realFetch(input, init);
      ++requests;
      return Promise.resolve(providerReply());
    });
    let continuationId: string, closingId: string;
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      const turn = impl.storage.agentIntegrationTurns.get(1)!;
      continuationId = crypto.randomUUID();
      const record = {chatId: 1, initiatorUserId: user.id.toString(), modelId: MODEL.profile.id,
        initiator: USER, callbackInitiated: false, continuationId, requestKey: turn.requestKey};
      impl.storage.activeAgents.put(record);
      impl.storage.pausedAgents.put(record);
      impl.storage.agentIntegrationTurns.put({...turn, continuationId});
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: MODEL.profile});
      await participant.setFailure(true);
      await expect(impl.closeAgentIntegrationTurn(1, reason)).rejects.toThrow(/unavailable/);
      closingId = impl.storage.agentIntegrationTurns.get(1)!.closing!.eventId;
      await participant.setFailure(false);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        await impl.waitForAllAgentsToComplete();
        expect(requests).toBe(0);
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        expect(impl.storage.chatMeta.get(1)?.activeAgent).toBeUndefined();
        expect(impl.storage.pausedAgents.get(1)?.continuationId).toBe(continuationId);
        expect(impl.storage.agentIntegrationTurns.get(1)).toMatchObject({state: "suspended",
          closing: {kind: "suspended", reason, eventId: closingId}});
        expect([...impl.storage.agentIntegrationParticipants.list()][0].pending).toEqual([]);
        // The decision handler's wake-up removes the paused marker before recovery.
        await impl.resumePausedAgent(1);
        await impl.waitForAllAgentsToComplete();
        expect(requests).toBe(1);
        expect(impl.storage.pausedAgents.get(1)).toBeUndefined();
        expect(impl.storage.agentIntegrationTurns.get(1)?.closing?.kind).toBe("finished");
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("clears busy bookkeeping when canceled during recovery's model lookup", async () => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    let entered = false, canceled = false, release: () => void;
    const getContext = UserDurableObject.prototype.getChatContext;
    vi.spyOn(UserDurableObject.prototype, "getChatContext").mockImplementation(async function(modelId) {
      entered = true;
      await new Promise<void>(resolve => { release = resolve; });
      return getContext.call(this, modelId);
    });
    await runInDurableObject(user, instance => {
      instance["storage"].profile.put(USER);
      instance["storage"].aiModels.put(MODEL);
    });
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      await prepare(impl, name);
      const turn = impl.storage.agentIntegrationTurns.get(1)!;
      impl.storage.activeAgents.put({chatId: 1, initiatorUserId: user.id.toString(), modelId: MODEL.profile.id,
        initiator: USER, callbackInitiated: false, continuationId: crypto.randomUUID(), requestKey: turn.requestKey});
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: MODEL.profile});
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    const completed = runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        impl.cancelAgent(1);
        canceled = true;
        await impl.waitForAllAgentsToComplete();
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        expect(impl.storage.pausedAgents.get(1)).toBeUndefined();
        expect(impl.storage.chatMeta.get(1)?.activeAgent).toBeUndefined();
        expect(impl.storage.agentIntegrationTurns.get(1)).toMatchObject({state: "finished", closing: {reason: "canceled"}});
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
    await vi.waitFor(() => expect(canceled).toBe(true));
    await runInDurableObject(user, () => release());
    await completed;
  });

  it.each(["new request", "same request"])("does not discard a newer execution of a %s during previous cleanup", async request => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(user, instance => {
      instance["storage"].profile.put(USER);
      instance["storage"].aiModels.put(MODEL);
    });
    let requests = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== MODEL.config.apiUrl) return realFetch(input, init);
      ++requests;
      return Promise.resolve(providerReply());
    });
    let firstTurnId: string;
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      const first = impl.storage.agentIntegrationTurns.get(1)!;
      firstTurnId = first.turnId;
      impl.storage.agentIntegrationTurns.put({...first, continuationId: crypto.randomUUID()});
      await participant.setFailure(true);
      await expect(impl.closeAgentIntegrationTurn(1, "completed")).rejects.toThrow(/unavailable/);
      if (request === "new request") impl.addChatMessages(1, USER, [{type: "message", message: "Second prompt."}]);
      const requestKey = String([...impl.storage.chats.list()].at(-1)!.sequence);
      const meta = impl.storage.chatMeta.get(1)!;
      meta.activeAgent = MODEL.profile;
      impl.storage.chatMeta.put(meta);
      const begin = impl.beginAgentIntegrationTurn.bind(impl);
      impl.beginAgentIntegrationTurn = async (chatId, key) => {
        try { await begin(chatId, key); }
        catch {
          // Lose the invocation at the actual old-cleanup await, then evict the real DO.
          throw Object.assign(new Error("Injected reset during prior cleanup"), {durableObjectReset: true});
        }
      };
      impl.startAgent(1, MODEL, USER, user.id.toString());
      await vi.waitFor(async () => expect((await participant.calls()).length).toBeGreaterThanOrEqual(3));
      expect(impl.storage.activeAgents.get(1)?.requestKey).toBe(requestKey);
      expect(impl.storage.agentIntegrationTurns.get(1)?.turnId).toBe(firstTurnId);
      expect(requests).toBe(0);
      await participant.setFailure(false);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        await impl.waitForAllAgentsToComplete();
        expect(requests).toBe(1);
        expect([...impl.storage.chats.list()].some(message => message.type === "message" &&
          message.author.type === "agent" && message.message === "Recovered new prompt.")).toBe(true);
        expect(impl.storage.agentIntegrationTurns.get(1)).toMatchObject({state: "finished", closing: {reason: "completed"}});
        expect(impl.storage.agentIntegrationTurns.get(1)?.turnId).not.toBe(firstTurnId);
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("journals failed cleanup before discarding an interrupted turn whose model was removed", async () => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      await participant.setFailure(true);
      const turn = impl.storage.agentIntegrationTurns.get(1)!;
      impl.storage.activeAgents.put({chatId: 1, initiatorUserId: user.id.toString(), modelId: "removed-model",
        initiator: USER, callbackInitiated: false, continuationId: crypto.randomUUID(), requestKey: turn.requestKey});
      const meta = impl.storage.chatMeta.get(1)!;
      meta.activeAgent = MODEL.profile;
      impl.storage.chatMeta.put(meta);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        await impl.waitForAllAgentsToComplete();
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        expect(impl.storage.chatMeta.get(1)?.activeAgent).toBeUndefined();
        expect(impl.storage.agentIntegrationTurns.get(1)).toMatchObject({state: "finished", closing: {kind: "finished", reason: "failed"}});
        const pending = [...impl.storage.agentIntegrationParticipants.list()][0];
        expect(pending.pending).toHaveLength(1);
        expect(pending.retryAt).toBeTypeOf("number");
        const participant = (impl.ctx.exports as TestExports).IntegrationTestParticipant({props: {name}});
        await participant.setFailure(false);
        impl.storage.agentIntegrationParticipants.put({...pending, retryAt: Date.now()});
        await impl.retryAgentIntegrationEvents();
        const calls = (await participant.calls()).filter(call => call.event.kind === "finished");
        expect(calls).toHaveLength(2);
        expect(calls[0].event.eventId).toBe(calls[1].event.eventId);
        expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });
});
