import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { upgradeCodexWebSocketControlTransport } from "../src/infrastructure/outbound/agent-sessions/codex-app-server/codex-websocket-control-transport.js";

const fixedKey = Buffer.from("0123456789abcdef");
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

describe("Codex WebSocket control transport", () => {
  it("upgrades the proxy byte stream and exchanges JSON as WebSocket text frames", async () => {
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    let incoming = Buffer.alloc(0);
    let handshakeComplete = false;
    let receivedText: string | undefined;

    clientToServer.on("data", (chunk: Buffer) => {
      incoming = Buffer.concat([incoming, chunk]);
      if (!handshakeComplete) {
        const headerEnd = incoming.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const request = incoming.subarray(0, headerEnd).toString();
        expect(request).toContain("GET /rpc HTTP/1.1");
        expect(request).toContain("Upgrade: websocket");
        const key = /Sec-WebSocket-Key: ([^\r\n]+)/.exec(request)?.[1];
        expect(key).toBe(fixedKey.toString("base64"));
        incoming = incoming.subarray(headerEnd + 4);
        handshakeComplete = true;
        const accept = createHash("sha1")
          .update(`${key ?? ""}${websocketGuid}`)
          .digest("base64");
        serverToClient.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            "",
          ].join("\r\n"),
        );
      }
      if (incoming.length > 0) {
        const parsed = parseClientFrame(incoming);
        if (parsed !== undefined) {
          incoming = incoming.subarray(parsed.consumedBytes);
          if (parsed.opcode === 0x1)
            receivedText = parsed.payload.toString("utf8");
        }
      }
    });

    const transport = await upgradeCodexWebSocketControlTransport({
      transport: { readable: serverToClient, writable: clientToServer },
      timeoutMs: 1_000,
      createKey: () => fixedKey,
    });
    const response = nextChunk(transport.readable);
    transport.writable.write('{"id":1,"method":"initialize"}\n');
    await waitUntil(() => receivedText !== undefined);
    expect(receivedText).toBe('{"id":1,"method":"initialize"}\n');

    serverToClient.write(
      encodeServerFrame('{"id":1,"result":{"userAgent":"fixture"}}'),
    );
    await expect(response).resolves.toBe(
      '{"id":1,"result":{"userAgent":"fixture"}}\n',
    );
    transport.readable.destroy();
    transport.writable.destroy();
  });

  it("rejects a handshake whose server acceptance key is invalid", async () => {
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    clientToServer.once("data", () => {
      serverToClient.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Accept: invalid",
          "",
          "",
        ].join("\r\n"),
      );
    });

    await expect(
      upgradeCodexWebSocketControlTransport({
        transport: { readable: serverToClient, writable: clientToServer },
        timeoutMs: 1_000,
        createKey: () => fixedKey,
      }),
    ).rejects.toThrow("invalid key");
  });

  it("ends its local readable side after sending the client close frame", async () => {
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    let closeOpcode: number | undefined;
    clientToServer.on("data", (chunk: Buffer) => {
      const request = chunk.toString();
      if (request.startsWith("GET ")) {
        const key = /Sec-WebSocket-Key: ([^\r\n]+)/.exec(request)?.[1];
        const accept = createHash("sha1")
          .update(`${key ?? ""}${websocketGuid}`)
          .digest("base64");
        serverToClient.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            "",
          ].join("\r\n"),
        );
        return;
      }
      closeOpcode = parseClientFrame(chunk)?.opcode;
    });

    const transport = await upgradeCodexWebSocketControlTransport({
      transport: { readable: serverToClient, writable: clientToServer },
      timeoutMs: 1_000,
      createKey: () => fixedKey,
    });
    const ended = new Promise<void>((resolve) =>
      transport.readable.once("end", resolve),
    );
    transport.readable.resume();
    transport.writable.end();

    await expect(ended).resolves.toBeUndefined();
    expect(closeOpcode).toBe(0x8);
  });
});

function encodeServerFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error("Test payload is too large");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function parseClientFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; consumedBytes: number } | undefined {
  if (buffer.length < 6) return undefined;
  const length = buffer[1] & 0x7f;
  if ((buffer[1] & 0x80) === 0 || length >= 126)
    throw new Error("Expected a short masked client frame");
  if (buffer.length < 6 + length) return undefined;
  const mask = buffer.subarray(2, 6);
  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1)
    payload[index] = buffer[6 + index] ^ mask[index % 4];
  return {
    opcode: buffer[0] & 0x0f,
    payload,
    consumedBytes: 6 + length,
  };
}

async function nextChunk(stream: NodeJS.ReadableStream): Promise<string> {
  return await new Promise((resolve, reject) => {
    stream.once("data", (chunk) => resolve(String(chunk)));
    stream.once("error", reject);
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for frame");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
