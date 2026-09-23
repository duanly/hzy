/**
 * 极简 WebSocket 服务端实现（RFC 6455），无第三方依赖。
 * 支持文本/二进制帧、分片、ping/pong、close。
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WebSocketConn extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private frags: Buffer[] = [];
  private fragOp = 0;
  closed = false;
  data: Record<string, unknown> = {};

  socket: Duplex;
  req: IncomingMessage;
  constructor(socket: Duplex, req: IncomingMessage) {
    super();
    this.socket = socket; this.req = req;
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    socket.on('end', () => this.finish());
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    try { this.socket.destroy(); } catch { /* ignore */ }
  }

  private onData(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 16 * 1024 * 1024) { this.close(1009); return; }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this.buf = this.buf.subarray(off + maskLen + len);
      this.handleFrame(fin, op, payload);
      if (this.closed) return;
    }
  }

  private handleFrame(fin: boolean, op: number, payload: Buffer) {
    switch (op) {
      case 0x0: // continuation
        this.frags.push(payload);
        if (fin) { const all = Buffer.concat(this.frags); const o = this.fragOp; this.frags = []; this.deliver(o, all); }
        return;
      case 0x1: case 0x2:
        if (fin) this.deliver(op, payload); else { this.fragOp = op; this.frags = [payload]; }
        return;
      case 0x8: this.close(1000); return;
      case 0x9: this.sendFrame(0xA, payload); return;
      case 0xA: return;
      default: this.close(1002);
    }
  }

  private deliver(op: number, payload: Buffer) {
    if (op === 0x1) this.emit('message', payload.toString('utf8'), false);
    else this.emit('message', payload, true);
  }

  private sendFrame(op: number, payload: Buffer) {
    if (this.closed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) { header = Buffer.from([0x80 | op, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { this.finish(); }
  }

  send(data: string | Buffer) {
    if (typeof data === 'string') this.sendFrame(0x1, Buffer.from(data, 'utf8'));
    else this.sendFrame(0x2, data);
  }
  sendJSON(obj: unknown) { this.send(JSON.stringify(obj)); }
  ping() { this.sendFrame(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.closed) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code, 0);
    this.sendFrame(0x8, b);
    this.finish();
  }
}

export function acceptUpgrade(req: IncomingMessage, socket: Duplex): WebSocketConn | null {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WebSocketConn(socket, req);
}
