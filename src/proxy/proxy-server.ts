import * as http from 'http';
import * as https from 'https';
import type { CaptureStore } from './capture-store';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { v4: uuidv4 } = require('uuid') as { v4: () => string };

/**
 * Local HTTP reverse-proxy.
 *
 * Claude Code → http://127.0.0.1:PORT (this server) → real Anthropic API
 *
 * Only /v1/messages requests are captured; all others are forwarded transparently.
 * The response is tee-d: piped back to Claude Code immediately (zero added latency)
 * while simultaneously buffered for SSE reassembly and storage in CaptureStore.
 */
export class ProxyServer {
  private server: http.Server | null = null;
  private port: number | null = null;

  constructor(
    private readonly captureStore: CaptureStore,
    /** Called at request time to get the real API base URL for this request. */
    private readonly getUpstreamBaseUrl: () => string,
  ) {}

  /** Start listening on a random loopback port. Resolves with the port number. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.server) { resolve(this.port!); return; }

      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err: Error) => {
          if (!res.headersSent) {
            res.writeHead(502);
            res.end(JSON.stringify({ error: 'proxy_internal', message: err.message }));
          }
        });
      });

      server.on('error', reject);
      // Port 0 → OS assigns a free port.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number } | null;
        if (!addr) { reject(new Error('proxy: no address')); return; }
        this.port = addr.port;
        this.server = server;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const s = this.server;
      this.server = null;
      this.port = null;
      if (!s) { resolve(); return; }
      s.close(() => resolve());
    });
  }

  getPort(): number | null { return this.port; }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestId = uuidv4();
    const captureTs = Date.now();
    const isMessages = (req.url ?? '').includes('/v1/messages');

    // ── Read full request body ───────────────────────────────────────────────
    const bodyBuf = await readBody(req);

    // ── Parse + store request (capture only for /v1/messages) ───────────────
    if (isMessages) {
      let parsedReq: Record<string, unknown> = {};
      try {
        parsedReq = JSON.parse(bodyBuf.toString('utf-8')) as Record<string, unknown>;
      } catch {
        parsedReq = { _raw_truncated: bodyBuf.toString('utf-8').slice(0, 2000) };
      }

      this.captureStore.add({
        requestId,
        captureTs,
        request: parsedReq,
        upstreamUrl: this.getUpstreamBaseUrl(),
        responseMessageId: null,
        rawResponseSse: null,
        responseTs: null,
      });
    }

    // ── Build upstream request ───────────────────────────────────────────────
    const upstreamBase = this.getUpstreamBaseUrl().replace(/\/$/, '');
    const targetUrlStr = `${upstreamBase}${req.url ?? '/'}`;
    let targetUrl: URL;
    try {
      targetUrl = new URL(targetUrlStr);
    } catch {
      res.writeHead(400);
      res.end('proxy: invalid target URL');
      return;
    }

    const isHttps = targetUrl.protocol === 'https:';
    const defaultPort = isHttps ? 443 : 80;
    const forwardPort = targetUrl.port ? Number(targetUrl.port) : defaultPort;

    // Forward headers but override Host to match the upstream.
    const forwardHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    forwardHeaders['host'] = targetUrl.host;

    const options: https.RequestOptions = {
      hostname: targetUrl.hostname,
      port: forwardPort,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method ?? 'GET',
      headers: forwardHeaders,
    };

    const transport: typeof http | typeof https = isHttps ? https : http;

    await new Promise<void>((resolve, reject) => {
      const upstreamReq = transport.request(options, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);

        if (!isMessages) {
          // Transparent passthrough — no capture.
          upstreamRes.pipe(res);
          upstreamRes.on('end', resolve);
          upstreamRes.on('error', reject);
          return;
        }

        // Tee: write each chunk to client immediately + buffer for capture.
        const responseChunks: Buffer[] = [];
        upstreamRes.on('data', (chunk: Buffer) => {
          responseChunks.push(chunk);
          res.write(chunk);
        });
        upstreamRes.on('end', () => {
          res.end();
          const rawSse = Buffer.concat(responseChunks).toString('utf-8');
          const msgId = extractMessageId(rawSse);
          this.captureStore.updateResponse(requestId, {
            rawResponseSse: rawSse,
            responseMessageId: msgId,
            responseTs: Date.now(),
          });
          resolve();
        });
        upstreamRes.on('error', reject);
      });

      upstreamReq.on('error', reject);
      upstreamReq.write(bodyBuf);
      upstreamReq.end();
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readBody(readable: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readable.on('data', (c: Buffer) => chunks.push(c));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

/** Extract the `msg_xxx` message id from an SSE stream (from the message_start event). */
function extractMessageId(body: string): string | null {
  for (const block of body.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const d = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (d.type === 'message_start') {
          const msg = d.message as Record<string, unknown> | undefined;
          if (typeof msg?.id === 'string') return msg.id;
        }
      } catch { /* skip */ }
    }
  }
  return null;
}
