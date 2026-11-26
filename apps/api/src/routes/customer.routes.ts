
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../prisma/db.js';

const router = Router();

const customerSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().email().max(255).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
});

const updateCustomerSchema = customerSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: 'Provide at least one field to update.' },
);

// Create customer
router.post('/', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const parsed = customerSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid customer data.',
        errors: parsed.error.flatten(),
      });
    }

    const customer = await db.orm.public.Customer.create({
      businessId,
      ...parsed.data,
    });

    return res.status(201).json({
      success: true,
      message: 'Customer created successfully.',
      data: { customer },
    });
  } catch (error) {
    console.error('Customer creation error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create customer.',
    });
  }
});

// List customers
router.get('/', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const customers = await db.orm.public.Customer
      .where({ businessId })
      .all();

    return res.json({
      success: true,
      data: { customers },
    });
  } catch (error) {
    console.error('Customer listing error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve customers.',
    });
  }
});

// Get one customer
router.get('/:id', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const customer = await db.orm.public.Customer
      .where({ id: req.params.id, businessId })
      .first();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found.',
      });
    }

    return res.json({
      success: true,
      data: { customer },
    });
  } catch (error) {
    console.error('Customer retrieval error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve customer.',
    });
  }
});

// Update customer
router.patch('/:id', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const parsed = updateCustomerSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid customer update data.',
        errors: parsed.error.flatten(),
      });
    }

    const customer = await db.orm.public.Customer
      .where({ id: req.params.id, businessId })
      .first();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found.',
      });
    }

    const updatedCustomer = await db.orm.public.Customer
      .where({ id: req.params.id, businessId })
      .update(parsed.data);

    return res.json({
      success: true,
      message: 'Customer updated successfully.',
      data: { customer: updatedCustomer },
    });
  } catch (error) {
    console.error('Customer update error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update customer.',
    });
  }
});

export default router;
