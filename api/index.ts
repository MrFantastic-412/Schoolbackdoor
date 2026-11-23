import type { Request, Response } from 'express';
import { createExpressApp, attachJsonErrorHandler, type ExpressAppBundle } from '../server/app';

let cachedBundle: ExpressAppBundle | null = null;

function getServerlessApp(): ExpressAppBundle {
  if (!cachedBundle) {
    const bundle = createExpressApp({
      isProduction: process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL),
      startBackgroundWorkers: false,
    });
    attachJsonErrorHandler(bundle.app);
    cachedBundle = bundle;
  }
  return cachedBundle;
}

function normalizeRewrittenUrl(req: Request) {
  const rawUrl = req.url || '/';
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    const rewrittenPath = parsed.searchParams.get('__sb_path');
    if (rewrittenPath) {
      parsed.searchParams.delete('__sb_path');
      const normalizedPath = rewrittenPath.startsWith('/') ? rewrittenPath : `/${rewrittenPath}`;
      const qs = parsed.searchParams.toString();
      req.url = qs ? `${normalizedPath}?${qs}` : normalizedPath;
    }
  } catch {
    // Preserve raw req.url if URL parsing fails
  }
}

export default function handler(req: Request, res: Response) {
  try {
    normalizeRewrittenUrl(req);

    // Vercel @vercel/node may pre-parse req.body without setting Express body-parser's _body flag
    if (req.body !== undefined && !(req as any)._body) {
      (req as any)._body = true;
    }

    const { app, runServerlessMaintenanceTick } = getServerlessApp();
    runServerlessMaintenanceTick();
    return app(req, res);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          success: false,
          message: 'Server initialization error.',
          error: err?.message || 'Server initialization error.',
          code: 'SERVER_INIT_ERROR',
        })
      );
    }
  }
}
