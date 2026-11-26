import { Router } from 'express';

const router = Router();

router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Inventory routes working.',
    businessId: req.auth?.businessId,
    role: req.auth?.role,
  });
});

export default router;
