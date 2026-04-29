import { Router } from 'express';
import { db } from '../../config/database';

export const healthRoutes = Router();

healthRoutes.get('/', async (_req, res) => {
  const dbOk = await db.healthCheck();
  const status = dbOk ? 'ok' : 'degraded';

  res.status(dbOk ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: dbOk ? 'ok' : 'error',
    },
    version: process.env.npm_package_version ?? '1.0.0',
  });
});
