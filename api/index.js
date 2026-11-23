import { createExpressApp, attachJsonErrorHandler } from './_server/app.mjs';

/** @type {import('./_server/app.mjs').ExpressAppBundle | null} */
let cachedBundle = null;

function getServerlessApp() {
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

/**
 * Restores the rewritten API/compliance route from Vercel's `__sb_path` query parameter
 * while preserving all caller query parameters (such as SSE `ticket`, `clientId`, pagination, etc.).
 * @param {import('express').Request} req
 */
function normalizeRewrittenUrl(req) {
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

/**
 * Vercel Node 22 native ESM serverless entrypoint.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export default function handler(req, res) {
  try {
    normalizeRewrittenUrl(req);

    // Vercel @vercel/node may pre-parse req.body without setting Express body-parser's _body flag
    if (req.body !== undefined && !req._body) {
      req._body = true;
    }

    const { app, runServerlessMaintenanceTick } = getServerlessApp();
    runServerlessMaintenanceTick();
    return app(req, res);
  } catch (err) {
    if (!res.headersSent && !res.writableEnded) {
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
