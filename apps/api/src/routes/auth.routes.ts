
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { db } from '../prisma/db.js';
import { env } from '../config/env.js';

const router = Router();

const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(128),
  businessName: z.string().trim().min(2).max(150),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(128),
});

function createAccessToken(userId: string) {
  return jwt.sign(
    { sub: userId },
    env.jwtSecret,
    { expiresIn: '15m' },
  );
}

// REGISTER
router.post('/register', async (req, res) => {
  const validation = registerSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: 'Please check your registration details.',
      errors: validation.error.issues,
    });
  }

  const { fullName, password, businessName } = validation.data;
  const email = validation.data.email.toLowerCase();

  try {
    const existingUser = await db.orm.public.User
      .where({ email })
      .first();

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await db.transaction(async (tx) => {
      const user = await tx.orm.public.User.create({
        fullName,
        email,
        passwordHash,
      });

      const business = await tx.orm.public.Business.create({
        name: businessName,
      });

      await tx.orm.public.BusinessMember.create({
        userId: user.id,
        businessId: business.id,
        role: 'OWNER',
      });

      return { user, business };
    });

    const accessToken = createAccessToken(result.user.id);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      data: {
        user: {
          id: result.user.id,
          fullName: result.user.fullName,
          email: result.user.email,
        },
        business: {
          id: result.business.id,
          name: result.business.name,
          currencyCode: result.business.currencyCode,
        },
        accessToken,
        tokenType: 'Bearer',
        expiresIn: 900,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to complete registration.',
    });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  const validation = loginSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: 'Invalid login details.',
      errors: validation.error.issues,
    });
  }

  const email = validation.data.email.toLowerCase();
  const { password } = validation.data;

  try {
    const user = await db.orm.public.User
      .where({ email })
      .first();

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const accessToken = createAccessToken(user.id);

    return res.json({
      success: true,
      message: 'Login successful.',
      data: {
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
        },
        accessToken,
        tokenType: 'Bearer',
        expiresIn: 900,
      },
    });
  } catch (error) {
    console.error('Login error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to complete login.',
    });
  }
});

export default router;
