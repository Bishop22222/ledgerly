
import 'dotenv/config';

import app from './app.js';
import { db } from './prisma/db.js';
import { env } from './config/env.js';

const server = app.listen(env.port, () => {
  console.log(`Ledgerly API running on http://localhost:${env.port}`);
});

const shutdown = () => {
  console.log('Shutting down Ledgerly API...');

  server.close(async () => {
    try {
      await db.close();
      console.log('Database connection closed.');
      process.exit(0);
    } catch (error) {
      console.error('Shutdown error:', error);
      process.exit(1);
    }
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
