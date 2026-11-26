
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../prisma/db.js';

const router = Router();

const createSaleSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  taxAmount: z.number().finite().min(0).default(0),
  notes: z.string().trim().max(1000).nullable().optional(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number()
        .finite()
        .positive()
        .refine(
          (value) => Number.isInteger(value * 1000),
          'Quantity can have at most 3 decimal places.',
        ),
    }),
  ).min(1).max(100),
}).refine(
  (data) =>
    new Set(data.items.map((item) => item.productId)).size ===
    data.items.length,
  {
    message: 'A product can only appear once in a sale. Combine its quantities.',
    path: ['items'],
  },
);

function toCents(value: string | number): number {
  return Math.round(Number(value) * 100);
}

function fromCents(value: number): string {
  return (value / 100).toFixed(2);
}

function toThousandths(value: number): number {
  return Math.round(value * 1000);
}

// Create a sale and deduct stock atomically.
router.post('/', async (req, res) => {
  const parsed = createSaleSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: 'Invalid sale details.',
      errors: parsed.error.flatten(),
    });
  }

  const businessId = req.auth?.businessId;

  if (!businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business context is required.',
    });
  }

  const { customerId, taxAmount, notes, items } = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const business = await tx.orm.public.Business
        .where({ id: businessId })
        .select('currencyCode')
        .first();

      if (!business) {
        return { error: 'Business not found.', status: 404 as const };
      }

      if (customerId) {
        const customer = await tx.orm.public.Customer
          .where({ id: customerId, businessId })
          .select('id')
          .first();

        if (!customer) {
          return {
            error: 'Customer not found in this business.',
            status: 404 as const,
          };
        }
      }

      // Lock and validate every product before writing anything.
      const validatedItems = [];

      for (const item of items) {
        const product = await tx.orm.public.Product
          .where({
            id: item.productId,
            businessId,
          })
          .forUpdate()
          .first();

        if (!product) {
          return {
            error: `Product ${item.productId} was not found.`,
            status: 404 as const,
          };
        }

        if (!product.isActive) {
          return {
            error: `${product.name} is inactive and cannot be sold.`,
            status: 400 as const,
          };
        }

        const requestedMilli = toThousandths(item.quantity);
        const availableMilli = toThousandths(Number(product.stockQuantity));

        if (requestedMilli > availableMilli) {
          return {
            error: `Insufficient stock for ${product.name}. Available: ${Number(product.stockQuantity)}.`,
            status: 400 as const,
          };
        }

        const unitPriceCents = toCents(product.sellingPrice);
        const unitCostCents = toCents(product.costPrice);
        const lineTotalCents = Math.round(
          (unitPriceCents * requestedMilli) / 1000,
        );

        validatedItems.push({
          product,
          quantityMilli: requestedMilli,
          unitPriceCents,
          unitCostCents,
          lineTotalCents,
        });
      }

      const subtotalCents = validatedItems.reduce(
        (total, item) => total + item.lineTotalCents,
        0,
      );

      const taxCents = Math.round(taxAmount * 100);
      const totalCents = subtotalCents + taxCents;

      const sale = await tx.orm.public.Sale.create({
        businessId,
        customerId: customerId ?? null,
        status: 'COMPLETED',
        currencyCode: business.currencyCode,
        subtotal: fromCents(subtotalCents),
        taxAmount: fromCents(taxCents),
        totalAmount: fromCents(totalCents),
        notes: notes ?? null,
      });

      const saleItems = [];

      for (const item of validatedItems) {
        const newStockMilli =
          toThousandths(Number(item.product.stockQuantity)) -
          item.quantityMilli;

        const updatedProduct = await tx.orm.public.Product
          .where({
            id: item.product.id,
            businessId,
          })
          .update({
            stockQuantity: (newStockMilli / 1000).toFixed(3),
          });

        if (!updatedProduct) {
          throw new Error(`Could not update stock for ${item.product.name}.`);
        }

        const saleItem = await tx.orm.public.SaleItem.create({
          saleId: sale.id,
          productId: item.product.id,
          productName: item.product.name,
          quantity: (item.quantityMilli / 1000).toFixed(3),
          unitPrice: fromCents(item.unitPriceCents),
          unitCost: fromCents(item.unitCostCents),
          lineTotal: fromCents(item.lineTotalCents),
        });

        await tx.orm.public.StockMovement.create({
          businessId,
          productId: item.product.id,
          type: 'SALE',
          quantity: (-item.quantityMilli / 1000).toFixed(3),
          note: `Sale ${sale.id}`,
        });

        saleItems.push(saleItem);
      }

      return { sale, items: saleItems };
    });

    if ('error' in result) {
  return res.status(result.status ?? 500).json({
    success: false,
    message: result.error,
  });
}

    return res.status(201).json({
      success: true,
      message: 'Sale created successfully.',
      data: result,
    });
  } catch (error) {
    console.error('Create sale error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create sale.',
    });
  }
});

// List sales for the authenticated business.
router.get('/', async (req, res) => {
  const businessId = req.auth?.businessId;

  if (!businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business context is required.',
    });
  }

  try {
    const sales = await db.orm.public.Sale
      .where({ businessId })
      .select(
        'id',
        'customerId',
        'status',
        'currencyCode',
        'subtotal',
        'taxAmount',
        'totalAmount',
        'notes',
        'createdAt',
      )
      .all();

    return res.json({
      success: true,
      data: sales,
    });
  } catch (error) {
    console.error('List sales error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve sales.',
    });
  }
});

// Retrieve one sale with its items.
router.get('/:id', async (req, res) => {
  const businessId = req.auth?.businessId;
  const saleId = req.params.id;

  if (!businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business context is required.',
    });
  }

  if (!saleId) {
    return res.status(400).json({
      success: false,
      message: 'Sale ID is required.',
    });
  }

  try {
    const sale = await db.orm.public.Sale
      .where({ id: saleId, businessId })
      .first();

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found.',
      });
    }

    const items = await db.orm.public.SaleItem
      .where({ saleId: sale.id })
      .all();

    return res.json({
      success: true,
      data: { sale, items },
    });
  } catch (error) {
    console.error('Get sale error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve sale.',
    });
  }
});

export default router;
