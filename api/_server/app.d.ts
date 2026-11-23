import type { Express } from 'express';

export interface CreateExpressAppOptions {
  isProduction?: boolean;
  startBackgroundWorkers?: boolean;
}

export interface ExpressAppBundle {
  app: Express;
  runServerlessMaintenanceTick: () => void;
  shutdown: () => void;
}

export function createExpressApp(options?: CreateExpressAppOptions): ExpressAppBundle;
export function attachJsonErrorHandler(app: Express): void;
