
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db } from '../prisma/db.js';

const router = Router();

const uuidSchema = z.string().uuid();

// Generate a readable invoice number with a random suffix.
// The database's businessId + invoiceNumber unique constraint
// protects against duplicate invoice numbers.
function generateInvoiceNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = randomUUID().slice(0, 8).toUpperCase();

  return `INV-${date}-${suffix}`;
}

// POST /api/invoices/from-sale/:saleId
// Generate an invoice from a completed sale.
router.post('/from-sale/:saleId', async (req: Request, res: Response) => {
  const businessId = req.auth?.businessId;

  if (!businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business context is required.',
    });
  }

  const parsedSaleId = uuidSchema.safeParse(req.params.saleId);

  if (!parsedSaleId.success) {
    return res.status(400).json({
      success: false,
      message: 'Invalid sale ID.',
    });
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Check whether this sale already has an invoice.
      const existingInvoice = await tx.orm.public.Invoice
        .where({
          businessId,
          saleId: parsedSaleId.data,
        })
        .first();

      if (existingInvoice) {
        const existingItems = await tx.orm.public.InvoiceItem
          .where({ invoiceId: existingInvoice.id })
          .all();

        return {
          status: 200,
          invoice: existingInvoice,
          items: existingItems,
          alreadyExists: true,
        };
      }

      // Find the sale within the authenticated business.
      const sale = await tx.orm.public.Sale
        .where({
          id: parsedSaleId.data,
          businessId,
        })
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
          message: 'An invoice can only be generated from a completed sale.',
        };
      }

      const saleItems = await tx.orm.public.SaleItem
        .where({ saleId: sale.id })
        .all();

      if (saleItems.length === 0) {
        return {
          status: 400,
          message: 'This sale has no items to invoice.',
        };
      }

      // Create the invoice.
      const invoice = await tx.orm.public.Invoice.create({
        businessId,
        saleId: sale.id,
        invoiceNumber: generateInvoiceNumber(),
        status: 'ISSUED',
        currencyCode: sale.currencyCode,
        totalAmount: sale.totalAmount,
      });

      // Copy the sale items into invoice items.
      for (const item of saleItems) {
        await tx.orm.public.InvoiceItem.create({
          invoiceId: invoice.id,
          description: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
        });
      }

      const invoiceItems = await tx.orm.public.InvoiceItem
        .where({ invoiceId: invoice.id })
        .all();

      return {
        status: 201,
        invoice,
        items: invoiceItems,
        alreadyExists: false,
      };
    });

    if ('message' in result) {
      return res.status(result.status).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(result.status).json({
      success: true,
      message: result.alreadyExists
        ? 'An invoice already exists for this sale.'
        : 'Invoice generated successfully.',
      data: {
        invoice: result.invoice,
        items: result.items,
      },
    });
  } catch (error) {
    console.error('Generate invoice error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to generate invoice.',
    });
  }
});

// GET /api/invoices
// List invoices belonging to the authenticated business.
router.get('/', async (req: Request, res: Response) => {
  const businessId = req.auth?.businessId;

  if (!businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business context is required.',
    });
  }

  try {
    const invoices = await db.orm.public.Invoice
      .where({ businessId })
      .all();

    return res.status(200).json({
      success: true,
      data: invoices,
    });
  } catch (error) {
    console.error('List invoices error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve invoices.',
    });
  }
});

// GET /api/invoices/:id
// Get one invoice and its items.
router.get('/:id', async (req: Request, res: Response) => {
  const businessId = req.auth?.businessId;

  if (!businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business context is required.',
    });
  }

  const parsedInvoiceId = uuidSchema.safeParse(req.params.id);

  if (!parsedInvoiceId.success) {
    return res.status(400).json({
      success: false,
      message: 'Invalid invoice ID.',
    });
  }

  try {
    const invoice = await db.orm.public.Invoice
      .where({
        id: parsedInvoiceId.data,
        businessId,
      })
      .first();

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found.',
      });
    }

    const items = await db.orm.public.InvoiceItem
      .where({ invoiceId: invoice.id })
      .all();

    return res.status(200).json({
      success: true,
      data: {
        invoice,
        items,
      },
    });
  } catch (error) {
    console.error('Get invoice error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve invoice.',
    });
  }
});

export default router;
