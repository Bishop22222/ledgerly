
import { Router, type Request, type Response } from 'express';
import { db } from '../prisma/db.js';

const router = Router();

function toCents(value: unknown): number {
  return Math.round(Number(value) * 100);
}

function fromCents(value: number): string {
  return (value / 100).toFixed(2);
}

function localDateKey(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);

    const values: Record<string, string> = {};

    for (const part of parts) {
      values[part.type] = part.value;
    }

    return `${values['year']}-${values['month']}-${values['day']}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// GET /api/dashboard
router.get('/', async (req: Request, res: Response) => {
  const businessId = req.auth?.businessId;

  if (!businessId) {
    return res.status(403).json({
      success: false,
      message: 'Business context is required.',
    });
  }

  try {
    const business = await db.orm.public.Business
      .where({ id: businessId })
      .first();

    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found.',
      });
    }

    const timezone = business.timezone || 'Africa/Nairobi';
    const now = new Date();
    const todayKey = localDateKey(now, timezone);
    const monthKey = todayKey.slice(0, 7);

    // Retrieve only records belonging to this business.
    const [sales, products, invoices, payments] = await Promise.all([
      db.orm.public.Sale.where({ businessId }).all(),
      db.orm.public.Product.where({ businessId }).all(),
      db.orm.public.Invoice.where({ businessId }).all(),
      db.orm.public.Payment.where({ businessId }).all(),
    ]);

    // Only completed sales count towards revenue.
    const completedSales = sales.filter(
      (sale) => sale.status === 'COMPLETED',
    );

    const todaySales = completedSales.filter(
      (sale) => localDateKey(new Date(sale.createdAt), timezone) === todayKey,
    );

    const monthlySales = completedSales.filter(
      (sale) => localDateKey(new Date(sale.createdAt), timezone).startsWith(monthKey),
    );

    const totalRevenueCents = completedSales.reduce(
      (sum, sale) => sum + toCents(sale.totalAmount),
      0,
    );

    const todayRevenueCents = todaySales.reduce(
      (sum, sale) => sum + toCents(sale.totalAmount),
      0,
    );

    const monthlyRevenueCents = monthlySales.reduce(
      (sum, sale) => sum + toCents(sale.totalAmount),
      0,
    );

    const totalSalesCount = completedSales.length;

    const averageSaleCents = totalSalesCount > 0
      ? Math.round(totalRevenueCents / totalSalesCount)
      : 0;

    // Inventory alerts.
    const activeProducts = products.filter(
      (product) => product.isActive,
    );

    const lowStockProducts = activeProducts
      .filter(
        (product) =>
          Number(product.stockQuantity) > 0 &&
          Number(product.stockQuantity) <= Number(product.reorderLevel),
      )
      .sort(
        (a, b) =>
          Number(a.stockQuantity) - Number(b.stockQuantity),
      );

    const outOfStockProducts = activeProducts.filter(
      (product) => Number(product.stockQuantity) <= 0,
    );

    // Calculate outstanding invoice balances using recorded payments.
    const paymentsByInvoice = new Map<string, number>();

    for (const payment of payments) {
      if (!payment.invoiceId) continue;

      const current = paymentsByInvoice.get(payment.invoiceId) ?? 0;

      paymentsByInvoice.set(
        payment.invoiceId,
        current + toCents(payment.amount),
      );
    }

    const outstandingInvoices = invoices
      .filter(
        (invoice) =>
          invoice.status === 'ISSUED' ||
          invoice.status === 'PARTIALLY_PAID',
      )
      .map((invoice) => {
        const totalCents = toCents(invoice.totalAmount);
        const paidCents = paymentsByInvoice.get(invoice.id) ?? 0;
        const balanceCents = Math.max(0, totalCents - paidCents);

        return {
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          currencyCode: invoice.currencyCode,
          totalAmount: fromCents(totalCents),
          amountPaid: fromCents(paidCents),
          remainingBalance: fromCents(balanceCents),
        };
      })
      .filter((invoice) => Number(invoice.remainingBalance) > 0);

    const outstandingBalanceCents = outstandingInvoices.reduce(
      (sum, invoice) => sum + toCents(invoice.remainingBalance),
      0,
    );

    // Five most recent sales.
    const recentSales = [...sales]
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() -
          new Date(a.createdAt).getTime(),
      )
      .slice(0, 5)
      .map((sale) => ({
        id: sale.id,
        customerId: sale.customerId,
        status: sale.status,
        currencyCode: sale.currencyCode,
        subtotal: sale.subtotal,
        taxAmount: sale.taxAmount,
        totalAmount: sale.totalAmount,
        createdAt: sale.createdAt,
      }));

    return res.status(200).json({
      success: true,
      data: {
        business: {
          id: business.id,
          name: business.name,
          currencyCode: business.currencyCode,
          timezone,
        },
        period: {
          today: todayKey,
          month: monthKey,
        },
        sales: {
          todayCount: todaySales.length,
          todayRevenue: fromCents(todayRevenueCents),
          monthCount: monthlySales.length,
          monthRevenue: fromCents(monthlyRevenueCents),
          totalCount: totalSalesCount,
          totalRevenue: fromCents(totalRevenueCents),
          averageSaleValue: fromCents(averageSaleCents),
        },
        inventory: {
          activeProducts: activeProducts.length,
          lowStockCount: lowStockProducts.length,
          outOfStockCount: outOfStockProducts.length,
          lowStockProducts: lowStockProducts.slice(0, 10).map((product) => ({
            id: product.id,
            name: product.name,
            sku: product.sku,
            stockQuantity: product.stockQuantity,
            reorderLevel: product.reorderLevel,
          })),
          outOfStockProducts: outOfStockProducts.slice(0, 10).map((product) => ({
            id: product.id,
            name: product.name,
            sku: product.sku,
          })),
        },
        invoices: {
          outstandingCount: outstandingInvoices.length,
          outstandingBalance: fromCents(outstandingBalanceCents),
          outstandingInvoices: outstandingInvoices.slice(0, 10),
        },
        recentSales,
      },
    });
  } catch (error) {
    console.error('Dashboard error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve dashboard data.',
    });
  }
});

export default router;
