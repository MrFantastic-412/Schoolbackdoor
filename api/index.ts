import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServerApp, ensureServerInitialized } from '../server/app.js';

let cachedApp: ReturnType<typeof createServerApp> | null = null;

async function getServerlessApp() {
  await ensureServerInitialized();
  if (!cachedApp) {
    cachedApp = createServerApp();
  }
  return cachedApp;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await getServerlessApp();
    return app(req as any, res as any);
  } catch (err: any) {
    console.error('[Serverless] Request initialization failure:', err?.message || err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
    }
    res.end(
      JSON.stringify({
        error: 'Service temporarily unavailable. Please try again shortly.',
        code: 'SERVER_INIT_ERROR',
      })
    );
  }
}
