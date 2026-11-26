
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../prisma/db.js';

const router = Router();

const paymentSchema = z.object({
  saleId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
  amount: z.number().finite().positive()
    .refine(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001,
      'Payment amount can have at most two decimal places.',
    ),
  method: z.enum([
    'CASH',
    'BANK_TRANSFER',
    'CARD',
    'MOBILE_MONEY',
    'OTHER',
  ]),
  reference: z.string().trim().max(150).nullable().optional(),
});

const uuidSchema = z.string().uuid();

function toCents(value: unknown): number {
  return Math.round(Number(value) * 100);
}

function fromCents(value: number): string {
  return (value / 100).toFixed(2);
}

// POST /api/payments
// Record a payment against a completed sale.
router.post('/', async (req: Request, res: Response) => {
  const businessId = req.auth?.businessId;

  if (!businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business context is required.',
    });
  }

  const parsed = paymentSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: 'Invalid payment details.',
      errors: parsed.error.flatten(),
    });
  }

  const input = parsed.data;
  const amountCents = toCents(input.amount);

  try {
    const result = await db.transaction(async (tx) => {
      // Lock the sale to prevent simultaneous payments exceeding its total.
      const sale = await tx.orm.public.Sale
        .where({
          id: input.saleId,
          businessId,
        })
        .forUpdate()
        .first();

      if (!sale) {
        return {
          status: 404,
          message: 'Sale not found.',
        };
      }

      if (sale.status !== 'COMPLETED') {
        return {
          status: 400,
          message: 'Payments can only be recorded for completed sales.',
        };
      }

      // Find the invoice belonging to this sale, if one exists.
      const invoice = await tx.orm.public.Invoice
        .where({
          businessId,
          saleId: sale.id,
        })
        .first();

      if (input.invoiceId && (!invoice || invoice.id !== input.invoiceId)) {
        return {
          status: 404,
          message: 'Invoice not found for this sale.',
        };
      }

      if (invoice && ['DRAFT', 'VOIDED'].includes(invoice.status)) {
        return {
          status: 400,
          message: 'This invoice cannot receive payments.',
        };
      }

      // Retrieve previous payments for this sale.
      const previousPayments = await tx.orm.public.Payment
        .where({
          businessId,
          saleId: sale.id,
        })
        .all();

      const alreadyPaidCents = previousPayments.reduce(
        (total, payment) => total + toCents(payment.amount),
        0,
      );

      const saleTotalCents = toCents(sale.totalAmount);
      const remainingCents = saleTotalCents - alreadyPaidCents;

      if (amountCents > remainingCents) {
        return {
          status: 400,
          message: `Payment exceeds the remaining balance of ${sale.currencyCode} ${fromCents(Math.max(remainingCents, 0))}.`,
        };
      }

      const newPaidTotal = alreadyPaidCents + amountCents;

      const payment = await tx.orm.public.Payment.create({
        businessId,
        saleId: sale.id,
        invoiceId: invoice?.id ?? null,
        amount: fromCents(amountCents),
        currencyCode: sale.currencyCode,
        method: input.method,
        reference: input.reference ?? null,
      });

      let invoiceStatus: string | null = null;

      if (invoice) {
        invoiceStatus =
          newPaidTotal >= saleTotalCents
            ? 'PAID'
            : 'PARTIALLY_PAID';

        await tx.orm.public.Invoice
          .where({
            id: invoice.id,
            businessId,
          })
          .update({
            status: invoiceStatus as
              | 'PAID'
              | 'PARTIALLY_PAID',
          });
      }

      return {
        status: 201,
        payment,
        invoiceStatus,
        totalPaid: fromCents(newPaidTotal),
        remainingBalance: fromCents(saleTotalCents - newPaidTotal),
      };
    });

    if ('message' in result) {
      return res.status(result.status).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Payment recorded successfully.',
      data: {
        payment: result.payment,
        invoiceStatus: result.invoiceStatus,
        totalPaid: result.totalPaid,
        remainingBalance: result.remainingBalance,
      },
    });
  } catch (error) {
    console.error('Record payment error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to record payment.',
    });
  }
});

// GET /api/payments
// List payments belonging to the authenticated business.
router.get('/', async (req: Request, res: Response) => {
  const businessId = req.auth?.businessId;

  if (!businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business context is required.',
    });
  }

  try {
    const payments = await db.orm.public.Payment
      .where({ businessId })
      .all();

    return res.status(200).json({
      success: true,
      data: payments,
    });
  } catch (error) {
    console.error('List payments error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve payments.',
    });
  }
});

// GET /api/payments/:id
// Retrieve one payment belonging to the authenticated business.
router.get('/:id', async (req: Request, res: Response) => {
  const businessId = req.auth?.businessId;

  if (!businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business context is required.',
    });
  }

  const parsedId = uuidSchema.safeParse(req.params.id);

  if (!parsedId.success) {
    return res.status(400).json({
      success: false,
      message: 'Invalid payment ID.',
    });
  }

  try {
    const payment = await db.orm.public.Payment
      .where({
        id: parsedId.data,
        businessId,
      })
      .first();

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found.',
      });
    }

    return res.status(200).json({
      success: true,
      data: payment,
    });
  } catch (error) {
    console.error('Get payment error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve payment.',
    });
  }
});

export default router;
