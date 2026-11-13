// A tiny STOMP 1.1 frame codec for NIS1's WebSocket API (/w/messages). The official wallet speaks STOMP over SockJS
// (nem-library / nem-sdk); this talks STOMP straight over a plain WebSocket (/w/messages/websocket), so no library is needed.
// Pure functions only (no browser APIs), so they can be tested in Node.

export interface StompFrame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

const NUL = '\u0000';
const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** A frame as the text to send. `content-length` is added for a body (like stomp.js does). */
export function encodeFrame(command: string, headers: Record<string, string> = {}, body = ''): string {
  let out = `${command}\n`;
  for (const [key, value] of Object.entries(headers)) out += `${key}:${value}\n`;
  if (body) out += `content-length:${utf8Length(body)}\n`;
  return `${out}\n${body}${NUL}`;
}

// STOMP 1.1 escapes these in header values of every frame except CONNECT / CONNECTED.
const unescapeHeader = (value: string): string => value.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 'c' ? ':' : c === 'r' ? '\r' : c === '\\' ? '\\' : `\\${c}`));

/**
 * The frames in one WebSocket message. Heartbeats (a lone line feed) and empty chunks give no frame, so a message
 * with only a heartbeat returns []. Frames are separated by a NUL byte.
 */
export function decodeFrames(data: string): StompFrame[] {
  const frames: StompFrame[] = [];
  for (const chunk of data.split(NUL)) {
    const text = chunk.replace(/^[\r\n]+/, '');
    if (text === '') continue;
    const split = text.search(/\r?\n\r?\n/);
    const head = split === -1 ? text : text.slice(0, split);
    const body = split === -1 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
    const lines = head.split(/\r?\n/);
    const command = lines[0].trim();
    if (!command) continue;
    const headers: Record<string, string> = {};
    const plain = command === 'CONNECT' || command === 'CONNECTED';
    for (const line of lines.slice(1)) {
      const at = line.indexOf(':');
      if (at <= 0) continue;
      const key = line.slice(0, at);
      if (key in headers) continue; // the first one wins
      const value = line.slice(at + 1);
      headers[key] = plain ? value : unescapeHeader(value);
    }
    frames.push({ command, headers, body });
  }
  return frames;
}

/** The two numbers of a `heart-beat:x,y` header (0 when missing or not a number). */
export function parseHeartBeat(value: string | undefined): { x: number; y: number } {
  const [x, y] = (value ?? '').split(',').map((v) => Number.parseInt(v, 10));
  return { x: Number.isFinite(x) && x > 0 ? x : 0, y: Number.isFinite(y) && y > 0 ? y : 0 };
}
