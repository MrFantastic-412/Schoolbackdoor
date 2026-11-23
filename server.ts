import 'tsx';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const { createExpressApp, attachJsonErrorHandler } = await import('./server/app');
  const { logger } = await import('./server/utils/logger');

  const PORT = Number(process.env.PORT) || 3000;
  const isProduction = process.env.NODE_ENV === 'production';

  const { app, shutdown } = createExpressApp({
    isProduction,
    startBackgroundWorkers: true,
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        port: PORT,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('[Vite] Development middleware mounted.');
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use('/assets', express.static(path.join(distPath, 'assets'), { maxAge: '365d', immutable: true }));
    app.use(express.static(distPath, { maxAge: '1h', index: false }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
    console.log(`[Static] Serving production build from ${distPath}`);
  }

  attachJsonErrorHandler(app);

  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('Server', `Schoolbackdoor Server running on http://0.0.0.0:${PORT}`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  const gracefulShutdown = (signal: string) => {
    logger.info('Server', `Received ${signal}. Closing active connections...`);
    server.close(() => {
      shutdown();
      process.exit(0);
    });
    setTimeout(() => {
      shutdown();
      process.exit(0);
    }, 3000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
  }
}

startServer().catch((err: any) => {
  console.error('Failed to start server:', err?.message || 'Startup error');
  process.exit(1);
});
