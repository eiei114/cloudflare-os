import { PktLineParser } from "./git-transport";

/** Only the granted immutable commit can be requested, never ref discovery or another object. */
export function validateBootstrapFetch(commit: string, request: Uint8Array): void {
  if (!/^[a-f0-9]{40}$/.test(commit) || request.byteLength > 64 * 1024) {
    throw new Error("Invalid bootstrap fetch.");
  }
  const parser = new PktLineParser();
  const packets = parser.push(request);
  parser.finish();
  let command = false,
    want = false,
    shallow = false,
    argumentsStarted = false,
    done = false;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const packet of packets) {
    if (done) throw new Error("Invalid fetch framing.");
    if (packet.kind === "delim") {
      if (argumentsStarted || !command) throw new Error("Invalid fetch framing.");
      argumentsStarted = true;
      continue;
    }
    if (packet.kind === "flush") {
      done = true;
      continue;
    }
    if (packet.kind !== "data" || done) throw new Error("Invalid fetch framing.");
    const line = decoder.decode(packet.data).replace(/\n$/, "");
    if (!argumentsStarted) {
      if (line === "command=fetch" && !command) command = true;
      else if (!/^(agent=[A-Za-z0-9./_-]+|object-format=sha1)$/.test(line))
        throw new Error("Unsupported Git bootstrap command.");
    } else if (line === `want ${commit}` && !want) want = true;
    else if (line === "deepen 1" && !shallow) shallow = true;
    else if (
      !/^(done|thin-pack|ofs-delta|no-progress|include-tag|sideband-all|have [a-f0-9]{40})$/.test(
        line,
      )
    ) {
      throw new Error("Git bootstrap may fetch only its granted commit.");
    }
  }
  if (!command || !argumentsStarted || !want || !shallow || !done)
    throw new Error("Incomplete bootstrap fetch.");
}
