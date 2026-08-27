import { createHash, randomBytes } from "node:crypto";
import { PassThrough, Writable } from "node:stream";

import type { CodexControlTransport } from "./codex-process-runtime.js";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const maximumHandshakeBytes = 16 * 1024;

export interface CodexWebSocketControlTransportOptions {
  transport: CodexControlTransport;
  timeoutMs: number;
  createKey?: () => Buffer;
}

export async function upgradeCodexWebSocketControlTransport(
  options: CodexWebSocketControlTransportOptions,
): Promise<CodexControlTransport> {
  const { readable: rawReadable, writable: rawWritable } = options.transport;
  const key = (options.createKey ?? (() => randomBytes(16)))().toString(
    "base64",
  );
  const expectedAccept = createHash("sha1")
    .update(`${key}${websocketGuid}`)
    .digest("base64");
  const readable = new PassThrough();
  let upgraded = false;
  let closed = false;
  let incoming = Buffer.alloc(0);
  let fragmentedText: Buffer[] | undefined;

  const fail = (error: Error): void => {
    if (closed) return;
    closed = true;
    readable.destroy(error);
    writable.destroy(error);
  };

  const writeFrame = (
    opcode: number,
    payload: Buffer,
    callback?: (error?: Error | null) => void,
  ): void => {
    if (rawWritable.destroyed || rawWritable.writableEnded) {
      callback?.(new Error("Codex WebSocket control output is closed."));
      return;
    }
    rawWritable.write(encodeClientFrame(opcode, payload), callback);
  };

  const writable = new Writable({
    write(chunk, _encoding, callback) {
      if (!upgraded) {
        callback(
          new Error("Codex WebSocket control transport is not initialized."),
        );
        return;
      }
      writeFrame(0x1, Buffer.from(chunk as Uint8Array), (error) =>
        callback(error ?? undefined),
      );
    },
    final(callback) {
      if (closed || !upgraded) {
        rawWritable.end(callback);
        return;
      }
      writeFrame(0x8, Buffer.alloc(0), (error) => {
        if (error) {
          callback(error);
          return;
        }
        closed = true;
        readable.end();
        rawWritable.end(callback);
      });
    },
    destroy(error, callback) {
      rawReadable.destroy();
      rawWritable.destroy();
      callback(error);
    },
  });

  const deliverText = (payload: Buffer): void => {
    const text = payload.toString("utf8");
    readable.write(text.endsWith("\n") ? text : `${text}\n`);
  };

  const processFrame = (frame: WebSocketFrame): void => {
    if (frame.masked) {
      fail(new Error("Codex WebSocket server sent a masked frame."));
      return;
    }
    if (frame.rsv !== 0) {
      fail(new Error("Codex WebSocket server used unsupported extensions."));
      return;
    }
    if (frame.opcode >= 0x8 && (!frame.fin || frame.payload.length > 125)) {
      fail(new Error("Codex WebSocket server sent an invalid control frame."));
      return;
    }

    if (frame.opcode === 0x8) {
      if (!closed) writeFrame(0x8, frame.payload);
      closed = true;
      readable.end();
      if (!rawWritable.writableEnded) rawWritable.end();
      return;
    }
    if (frame.opcode === 0x9) {
      writeFrame(0xa, frame.payload, (error) => {
        if (error) fail(error);
      });
      return;
    }
    if (frame.opcode === 0xa) return;
    if (frame.opcode === 0x2) {
      fail(
        new Error("Codex WebSocket server sent an unsupported binary frame."),
      );
      return;
    }
    if (frame.opcode === 0x1) {
      if (fragmentedText !== undefined) {
        fail(
          new Error("Codex WebSocket server interleaved fragmented messages."),
        );
        return;
      }
      if (frame.fin) deliverText(frame.payload);
      else fragmentedText = [frame.payload];
      return;
    }
    if (frame.opcode === 0x0) {
      if (fragmentedText === undefined) {
        fail(
          new Error("Codex WebSocket server sent an unexpected continuation."),
        );
        return;
      }
      fragmentedText.push(frame.payload);
      if (frame.fin) {
        const payload = Buffer.concat(fragmentedText);
        fragmentedText = undefined;
        deliverText(payload);
      }
      return;
    }
    fail(new Error("Codex WebSocket server sent an unsupported frame."));
  };

  const processFrames = (): void => {
    try {
      while (!closed) {
        const parsed = parseServerFrame(incoming);
        if (parsed === undefined) return;
        incoming = incoming.subarray(parsed.consumedBytes);
        processFrame(parsed.frame);
      }
    } catch (error) {
      fail(normalizeError(error));
    }
  };

  let resolveUpgrade!: () => void;
  let rejectUpgrade!: (error: Error) => void;
  const upgrade = new Promise<void>((resolve, reject) => {
    resolveUpgrade = resolve;
    rejectUpgrade = reject;
  });

  const onData = (chunk: Buffer | string): void => {
    incoming = Buffer.concat([
      incoming,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    if (!upgraded) {
      if (incoming.length > maximumHandshakeBytes) {
        rejectUpgrade(
          new Error("Codex WebSocket handshake exceeded the header limit."),
        );
        return;
      }
      const headerEnd = incoming.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      try {
        validateHandshake(
          incoming.subarray(0, headerEnd).toString(),
          expectedAccept,
        );
      } catch (error) {
        rejectUpgrade(normalizeError(error));
        return;
      }
      incoming = incoming.subarray(headerEnd + 4);
      upgraded = true;
      resolveUpgrade();
      processFrames();
      return;
    }
    processFrames();
  };

  rawReadable.on("data", onData);
  rawReadable.once("end", () => {
    if (!upgraded) {
      rejectUpgrade(
        new Error("Codex WebSocket control transport ended during startup."),
      );
      return;
    }
    if (!closed) {
      closed = true;
      readable.end();
    }
  });
  rawReadable.once("error", (error) => {
    if (!upgraded) rejectUpgrade(error);
    else fail(error);
  });
  rawWritable.once("error", (error) => {
    if (!upgraded) rejectUpgrade(error);
    else fail(error);
  });

  const request = [
    "GET /rpc HTTP/1.1",
    "Host: localhost",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
  rawWritable.write(request);

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      upgrade,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Codex WebSocket control handshake did not complete within ${String(options.timeoutMs)}ms.`,
              ),
            ),
          options.timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    closed = true;
    rawReadable.destroy();
    rawWritable.destroy();
    readable.destroy();
    writable.destroy();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  return { readable, writable };
}

interface WebSocketFrame {
  fin: boolean;
  rsv: number;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

function parseServerFrame(
  buffer: Buffer,
): { frame: WebSocketFrame; consumedBytes: number } | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0];
  const second = buffer[1];
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return undefined;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return undefined;
    const length = buffer.readBigUInt64BE(2);
    if (length > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Codex WebSocket frame is too large.");
    payloadLength = Number(length);
    offset = 10;
  }
  const maskBytes = masked ? 4 : 0;
  const frameLength = offset + maskBytes + payloadLength;
  if (buffer.length < frameLength) return undefined;
  let payload = buffer.subarray(offset + maskBytes, frameLength);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = applyMask(payload, mask);
  }
  return {
    frame: {
      fin: (first & 0x80) !== 0,
      rsv: first & 0x70,
      opcode: first & 0x0f,
      masked,
      payload,
    },
    consumedBytes: frameLength,
  };
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, applyMask(payload, mask)]);
}

function applyMask(payload: Buffer, mask: Buffer): Buffer {
  const output = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1)
    output[index] = payload[index] ^ mask[index % 4];
  return output;
}

function validateHandshake(headers: string, expectedAccept: string): void {
  const lines = headers.split("\r\n");
  if (!/^HTTP\/1\.[01] 101(?: |$)/.test(lines[0] ?? ""))
    throw new Error("Codex WebSocket control handshake was rejected.");
  const values = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    values.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }
  if (values.get("upgrade")?.toLowerCase() !== "websocket")
    throw new Error("Codex WebSocket control handshake omitted Upgrade.");
  if (
    !values
      .get("connection")
      ?.split(",")
      .some((value) => value.trim().toLowerCase() === "upgrade")
  )
    throw new Error("Codex WebSocket control handshake omitted Connection.");
  if (values.get("sec-websocket-accept") !== expectedAccept)
    throw new Error(
      "Codex WebSocket control handshake returned an invalid key.",
    );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
