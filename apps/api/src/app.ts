
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { db } from './prisma/db.js';
import authRoutes from './routes/auth.routes.js';
import { requireAuth } from './middleware/auth.js';
import { requireBusiness } from './middleware/business.js';
import inventoryRoutes from './routes/inventory.routes.js';
import customerRoutes from './routes/customer.routes.js';
import salesRoutes from './routes/sales.routes.js';
import invoiceRoutes from './routes/invoice.routes.js';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'Welcome to the Ledgerly API',
    version: '1.0.0',
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    service: 'Ledgerly API',
    status: 'healthy',
  });
});

app.get('/api/health/database', async (_req, res) => {
  try {
    await db.orm.public.User.limit(1).all();

    res.json({
      success: true,
      service: 'Ledgerly Database',
      status: 'connected',
    });
  } catch (error) {
    console.error('Database health check failed:', error);

    res.status(503).json({
      success: false,
      service: 'Ledgerly Database',
      status: 'disconnected',
    });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/inventory', requireAuth, requireBusiness);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/customers', requireAuth, requireBusiness);
app.use('/api/customers', customerRoutes);
app.use('/api/sales', requireAuth, requireBusiness);
app.use('/api/sales', salesRoutes);
app.use('/api/invoices', requireAuth, requireBusiness);
app.use('/api/invoices', invoiceRoutes);

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await db.orm.public.User
      .where({ id: req.auth!.userId })
      .select('id', 'fullName', 'email', 'createdAt')
      .first();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    return res.json({
      success: true,
      data: { user },
    });
  } catch (error) {
    console.error('Profile error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve profile.',
    });
  }
});

export default app;
