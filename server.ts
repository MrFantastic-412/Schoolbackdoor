import 'tsx/esm';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const [
    { createServerApp, ensureServerInitialized, jsonErrorMiddleware },
    { checkpointDatabase, closeReadPool },
    { presenceService },
    { adminSecurityService },
    { deletionService },
    { sseManager },
    { logger },
  ] = await Promise.all([
    import('./server/app.js'),
    import('./server/db/database.js'),
    import('./server/services/presenceService.js'),
    import('./server/services/adminSecurityService.js'),
    import('./server/services/deletionService.js'),
    import('./server/realtime/sseManager.js'),
    import('./server/utils/logger.js'),
  ]);

  const PORT = Number(process.env.PORT) || 3000;
  const isProduction = process.env.NODE_ENV === 'production';

  await ensureServerInitialized();

  // Run initial lifecycle sweep on persistent server startup
  const initialPurge = adminSecurityService.run72HourPurgeJob('u-system-job');
  const initialStorage = deletionService.getDetailedStorageMetrics();
  logger.info('ExpiryWorker', 'Initialized lifecycle sweep', {
    postsPurged: initialPurge.postsPurged,
    messagesPurged: initialPurge.messagesPurged,
    filesDeleted: initialPurge.filesDeleted,
    storageUsagePercent: initialStorage.usagePercent,
    alertLevel: initialStorage.alertLevel,
  });

  const expiryInterval = setInterval(() => {
    try {
      const outcome = adminSecurityService.run72HourPurgeJob('u-system-job');
      const storage = deletionService.getDetailedStorageMetrics();
      if (outcome.postsPurged > 0 || outcome.messagesPurged > 0 || outcome.filesDeleted > 0 || storage.alertLevel !== 'ok') {
        logger.info('ExpiryStorageWorker', 'Completed scheduled sweep', {
          postsPurged: outcome.postsPurged,
          messagesPurged: outcome.messagesPurged,
          filesDeleted: outcome.filesDeleted,
          freedBytes: outcome.freedBytes,
          storageUsagePercent: storage.usagePercent,
          alertLevel: storage.alertLevel,
        });
      }
    } catch (e: any) {
      logger.warn('ExpiryWorker', 'Scheduled sweep failed', { message: e?.message });
    }
  }, 10 * 60 * 1000);
  expiryInterval.unref();

  // Schedule 30-second inactive presence expiration sweep
  const presenceSweepInterval = setInterval(() => {
    try {
      const purged = presenceService.expireInactivePresence();
      if (purged.purgedUsers > 0) {
        sseManager.broadcastPresenceUpdate(presenceService.getOnlineSummary());
      }
    } catch (e: any) {
      logger.warn('PresenceWorker', 'Error expiring inactive presence', { message: e?.message });
    }
  }, 30 * 1000);
  presenceSweepInterval.unref();

  const app = createServerApp();

  // Mount Vite middleware in development or static dist/ SPA in production
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

  app.use(jsonErrorMiddleware);

  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('Server', `Schoolbackdoor Server running on http://0.0.0.0:${PORT}`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  const gracefulShutdown = (signal: string) => {
    logger.info('Server', `Received ${signal}. Closing active connections...`);
    clearInterval(expiryInterval);
    clearInterval(presenceSweepInterval);
    sseManager.closeAllClients();
    server.close(() => {
      closeReadPool();
      checkpointDatabase();
      process.exit(0);
    });
    setTimeout(() => {
      closeReadPool();
      checkpointDatabase();
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
