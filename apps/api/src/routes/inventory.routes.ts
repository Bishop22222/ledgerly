
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../prisma/db.js';

const router = Router();

const categorySchema = z.object({
  name: z.string().trim().min(2).max(100),
});

// GET /api/inventory/categories
router.get('/categories', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const categories = await db.orm.public.Category
      .where({ businessId })
      .select('id', 'name', 'createdAt')
      .all();

    return res.json({
      success: true,
      data: { categories },
    });
  } catch (error) {
    console.error('Fetch categories error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve categories.',
    });
  }
});

// POST /api/inventory/categories
router.post('/categories', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const parsed = categorySchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid category details.',
        errors: parsed.error.issues,
      });
    }

    const { name } = parsed.data;

    const existing = await db.orm.public.Category
      .where({ businessId, name })
      .first();

    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'This category already exists.',
      });
    }

    const category = await db.orm.public.Category.create({
      businessId,
      name,
    });

    return res.status(201).json({
      success: true,
      message: 'Category created successfully.',
      data: { category },
    });
  } catch (error) {
    console.error('Create category error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create category.',
    });
  }
});

const productSchema = z.object({
  name: z.string().trim().min(2).max(150),
  sku: z.string().trim().max(80).optional(),
  description: z.string().trim().max(1000).optional(),
  categoryId: z.string().uuid().optional(),
  costPrice: z.number().min(0),
  sellingPrice: z.number().min(0),
  reorderLevel: z.number().min(0).default(0),
});

// GET /api/inventory/products
router.get('/products', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const products = await db.orm.public.Product
      .where({ businessId })
      .select(
        'id',
        'name',
        'sku',
        'description',
        'categoryId',
        'costPrice',
        'sellingPrice',
        'stockQuantity',
        'reorderLevel',
        'isActive',
        'createdAt',
        'updatedAt',
      )
      .all();

    return res.json({
      success: true,
      data: { products },
    });
  } catch (error) {
    console.error('Fetch products error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve products.',
    });
  }
});

// POST /api/inventory/products
router.post('/products', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const parsed = productSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product details.',
        errors: parsed.error.issues,
      });
    }

    const {
      name,
      sku,
      description,
      categoryId,
      costPrice,
      sellingPrice,
      reorderLevel,
    } = parsed.data;

    if (categoryId) {
      const category = await db.orm.public.Category
        .where({ id: categoryId, businessId })
        .first();

      if (!category) {
        return res.status(400).json({
          success: false,
          message: 'Category not found in your business.',
        });
      }
    }

    if (sku) {
      const existing = await db.orm.public.Product
        .where({ businessId, sku })
        .first();

      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'This SKU already exists in your business.',
        });
      }
    }

    const product = await db.orm.public.Product.create({
  businessId,
  name,
  sku,
  description,
  categoryId,
  costPrice: String(costPrice),
  sellingPrice: String(sellingPrice),
  stockQuantity: '0',
  reorderLevel: String(reorderLevel),
});

    return res.status(201).json({
      success: true,
      message: 'Product created successfully.',
      data: { product },
    });
  } catch (error) {
    console.error('Create product error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create product.',
    });
  }
});


const stockAdjustmentSchema = z.object({
  type: z.enum(['PURCHASE', 'ADJUSTMENT', 'RETURN']),
  quantity: z.number().finite().min(0),
  note: z.string().trim().max(500).optional(),
}).refine(
  (data) => data.type === 'ADJUSTMENT' || data.quantity > 0,
  {
    message: 'Purchase and return quantities must be greater than zero.',
    path: ['quantity'],
  },
);

router.post('/products/:id/adjust-stock', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;
    const productId = req.params.id;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const parsed = stockAdjustmentSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid stock adjustment data.',
        errors: parsed.error.flatten(),
      });
    }

    const { type, quantity, note } = parsed.data;

    const result = await db.transaction(async (tx) => {
      const product = await tx.orm.public.Product
        .where({ id: productId, businessId })
        .forUpdate()
        .first();

      if (!product) {
        return null;
      }

      const currentStock = Number(product.stockQuantity);

      // ADJUSTMENT sets the desired final stock quantity.
      // PURCHASE and RETURN add to existing stock.
      const newStock =
        type === 'ADJUSTMENT'
          ? quantity
          : currentStock + quantity;

      // Record the actual change, including negative adjustments.
      const movementQuantity =
        type === 'ADJUSTMENT'
          ? quantity - currentStock
          : quantity;

      if (movementQuantity === 0) {
        return {
          product,
          movement: null,
          unchanged: true,
        };
      }

      const updatedProduct = await tx.orm.public.Product
        .where({ id: productId, businessId })
        .update({
          stockQuantity: String(newStock),
        });

      if (!updatedProduct) {
        throw new Error('Product update failed.');
      }

      const movement = await tx.orm.public.StockMovement.create({
        businessId,
        productId,
        type,
        quantity: String(movementQuantity),
        note,
      });

      return {
        product: updatedProduct,
        movement,
        unchanged: false,
      };
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Product not found.',
      });
    }

    return res.json({
      success: true,
      message: result.unchanged
        ? 'Stock is already at the requested quantity.'
        : 'Stock adjusted successfully.',
      data: result,
    });
  } catch (error) {
    console.error('Stock adjustment error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to adjust stock.',
    });
  }
});

router.get('/products/:id/movements', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;
    const productId = req.params.id;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    // Confirm that the product belongs to this business.
    const product = await db.orm.public.Product
      .where({ id: productId, businessId })
      .select('id', 'name', 'sku', 'stockQuantity')
      .first();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found.',
      });
    }

    // Retrieve only this product's movements in this business.
    const movements = await db.orm.public.StockMovement
      .where({ businessId, productId })
      .select('id', 'type', 'quantity', 'note', 'createdAt')
      .all();

    return res.json({
      success: true,
      data: {
        product,
        movements,
      },
    });
  } catch (error) {
    console.error('Stock movement history error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve stock movement history.',
    });
  }
});


const updateProductSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  sku: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  costPrice: z.number().min(0).optional(),
  sellingPrice: z.number().min(0).optional(),
  reorderLevel: z.number().min(0).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'Provide at least one field to update.' },
);

router.patch('/products/:id', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;
    const productId = req.params.id;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const parsed = updateProductSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product update data.',
        errors: parsed.error.flatten(),
      });
    }

    const existingProduct = await db.orm.public.Product
      .where({ id: productId, businessId })
      .first();

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found.',
      });
    }

    const data = parsed.data;

    if (data.categoryId) {
      const category = await db.orm.public.Category
        .where({
          id: data.categoryId,
          businessId,
        })
        .first();

      if (!category) {
        return res.status(400).json({
          success: false,
          message: 'Category does not belong to your business.',
        });
      }
    }

    if (data.sku) {
      const duplicateSku = await db.orm.public.Product
        .where({ businessId, sku: data.sku })
        .first();

      if (duplicateSku && duplicateSku.id !== productId) {
        return res.status(409).json({
          success: false,
          message: 'This SKU already exists in your business.',
        });
      }
    }

    const updateData = {
      ...data,
      costPrice:
        data.costPrice !== undefined
          ? String(data.costPrice)
          : undefined,
      sellingPrice:
        data.sellingPrice !== undefined
          ? String(data.sellingPrice)
          : undefined,
      reorderLevel:
        data.reorderLevel !== undefined
          ? String(data.reorderLevel)
          : undefined,
    };

    const updatedProduct = await db.orm.public.Product
      .where({ id: productId, businessId })
      .update(updateData);

    return res.json({
      success: true,
      message: 'Product updated successfully.',
      data: { product: updatedProduct },
    });
  } catch (error) {
    console.error('Product update error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update product.',
    });
  }
});


router.patch('/products/:id/deactivate', async (req, res) => {
  try {
    const businessId = req.auth?.businessId;
    const productId = req.params.id;

    if (!businessId) {
      return res.status(403).json({
        success: false,
        message: 'Business context required.',
      });
    }

    const product = await db.orm.public.Product
      .where({ id: productId, businessId })
      .first();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found.',
      });
    }

    const updatedProduct = await db.orm.public.Product
      .where({ id: productId, businessId })
      .update({ isActive: false });

    return res.json({
      success: true,
      message: 'Product deactivated successfully.',
      data: { product: updatedProduct },
    });
  } catch (error) {
    console.error('Product deactivation error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to deactivate product.',
    });
  }
});

export default router;
