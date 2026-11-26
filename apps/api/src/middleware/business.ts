import type { Request, Response, NextFunction } from 'express';
import { db } from '../prisma/db.js';

export async function requireBusiness(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!req.auth?.userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    const membership = await db.orm.public.BusinessMember
      .where({ userId: req.auth.userId })
      .select('businessId', 'role')
      .first();

    if (!membership) {
      return res.status(403).json({
        success: false,
        message: 'No business membership found.',
      });
    }

    req.auth.businessId = membership.businessId;
    req.auth.role = membership.role;

    next();
  } catch (error) {
    console.error('Business context error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load business context.',
    });
  }
}
