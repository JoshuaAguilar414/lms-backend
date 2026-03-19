import express from 'express';
import { verifyShopifyWebhook } from '../middleware/auth.js';
import Enrollment from '../models/Enrollment.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import Progress from '../models/Progress.js';
import ShopifyOrder from '../models/ShopifyOrder.js';
import { syncOrdersForShopifyCustomer } from '../services/shopifySync.js';

const router = express.Router();

/** Sync customer payload to User (from order.customer or customer webhook). */
async function syncCustomerToUser(customer, shopifyShopDomain, shopifyShopId) {
  const id = String(customer.id);
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  const existing = await User.findOne({ shopifyCustomerId: id });
  if (existing) {
    existing.email = customer.email ?? existing.email;
    existing.firstName = customer.first_name ?? existing.firstName;
    existing.lastName = customer.last_name ?? existing.lastName;
    existing.name = name || existing.name;
    existing.phone = customer.phone ?? existing.phone;
    existing.shopifyData = customer;
    if (shopifyShopDomain) existing.shopifyShopDomain = shopifyShopDomain;
    if (shopifyShopId) existing.shopifyShopId = shopifyShopId;
    existing.lastSyncedAt = new Date();
    await existing.save();
    return existing;
  }
  return await User.create({
    shopifyCustomerId: id,
    email: customer.email || `customer-${id}@shopify.local`,
    firstName: customer.first_name,
    lastName: customer.last_name,
    name: name || `Customer ${id}`,
    phone: customer.phone,
    shopifyData: customer,
    shopifyShopDomain: shopifyShopDomain || undefined,
    shopifyShopId: shopifyShopId || undefined,
  });
}

/**
 * POST /api/webhooks/shopify/order-created
 * Orders come from Shopify. Sync customer and create enrollments from line items.
 */
router.post('/shopify/order-created', verifyShopifyWebhook, async (req, res, next) => {
  try {
    const order = req.body;

    console.log('📦 New order received:', order.order_number);

    const customer = order.customer;
    if (!customer) {
      return res.status(400).json({ error: 'No customer data in order' });
    }

    const user = await syncCustomerToUser(customer, req.shopifyShop, req.shopifyShopId);
    if (!user._id) {
      return res.status(500).json({ error: 'Failed to sync user from order' });
    }

    const shopifyOrderId = String(order.id);
    const shopifyOrderNumber = order.order_number ? String(order.order_number) : undefined;
    console.log('[webhook order-created] synced customer', {
      shopifyCustomerId: customer?.id != null ? String(customer.id) : null,
      userId: user._id.toString(),
      shopifyOrderId,
      shopifyOrderNumber,
    });

    const shopifyCustomerId = String(customer.id);
    const orderCreatedAt = order.created_at ? new Date(order.created_at) : null;
    const orderUpdatedAt = order.updated_at ? new Date(order.updated_at) : null;

    // Cache the order in Mongo for order history/reconciliation.
    // We store full raw payload + reduced line items.
    await ShopifyOrder.findOneAndUpdate(
      { shopifyOrderId },
      {
        $set: {
          shopifyOrderNumber: order.order_number ? String(order.order_number) : undefined,
          shopifyCustomerId,
          financialStatus: order.financial_status,
          fulfillmentStatus: order.fulfillment_status,
          cancelledAt: order.cancelled_at ? new Date(order.cancelled_at) : undefined,
          orderCreatedAt: orderCreatedAt ?? undefined,
          orderUpdatedAt: orderUpdatedAt ?? undefined,
          rawOrderData: order,
          lineItems: (order.line_items || []).map((li) => ({
            title: li.title ?? li.name ?? undefined,
            quantity: li.quantity ?? undefined,
            shopifyProductId: li.product_id != null ? String(li.product_id) : undefined,
            shopifyVariantId: li.variant_id != null ? String(li.variant_id) : undefined,
            sku: li.sku ?? undefined,
          })),
        },
      },
      { upsert: true, new: true }
    );

    // Process each line item (course product)
    let processedLineItems = 0;
    let matchedCourses = 0;
    let enrollmentsCreated = 0;
    let progressCreated = 0;
    for (const lineItem of order.line_items || []) {
      processedLineItems += 1;
      // Find course by Shopify product ID
      const course = await Course.findOne({ shopifyProductId: String(lineItem.product_id) });

      if (!course) {
        console.log(`⚠️ Course not found for product ID: ${lineItem.product_id}`);
        continue;
      }
      matchedCourses += 1;

      // Keep one enrollment per user+product (avoid duplicates across multiple orders
      // for the same course). Order history still stays in ShopifyOrder cache.
      const existingEnrollment = await Enrollment.findOne({
        userId: user._id,
        shopifyProductId: String(lineItem.product_id),
      }).sort({ enrolledAt: -1 });

      if (existingEnrollment) {
        console.log(
          `ℹ️ Enrollment already exists for product ${lineItem.product_id}; reusing existing enrollment`
        );
        existingEnrollment.shopifyOrderNumber =
          order.order_number != null ? String(order.order_number) : existingEnrollment.shopifyOrderNumber;
        existingEnrollment.orderData = order;
        if (existingEnrollment.status !== 'cancelled') existingEnrollment.status = 'active';
        await existingEnrollment.save();
        continue;
      }

      // Create enrollment
      const enrollment = await Enrollment.create({
        userId: user._id,
        courseId: course._id,
        shopifyOrderId: shopifyOrderId,
        shopifyOrderNumber: order.order_number ? String(order.order_number) : undefined,
        shopifyProductId: String(lineItem.product_id),
        shopifyProductType: course.productType,
        shopifyProductDescription: course.description,
        shopifyProductTags: Array.isArray(course.tags) ? course.tags : [],
        shopifyProductImage: course.image || course.thumbnail,
        orderData: order,
        // Make enrolledAt align with Shopify order time (important for order history UI).
        enrolledAt: orderCreatedAt ?? undefined,
        status: 'active',
      });
      enrollmentsCreated += 1;

      // Create initial progress record
      await Progress.create({
        enrollmentId: enrollment._id,
        courseId: course._id,
        userId: user._id,
        progress: 0,
        completed: false,
      });
      progressCreated += 1;

      console.log(`✅ Created enrollment for course: ${course.title}`);
    }

    console.log('[webhook order-created] summary', {
      shopifyOrderId,
      processedLineItems,
      matchedCourses,
      enrollmentsCreated,
      progressCreated,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error processing order webhook:', error);
    next(error);
  }
});

/**
 * POST /api/webhooks/shopify/order-updated
 * Orders come from Shopify. Update enrollment status on refund/cancel.
 */
router.post('/shopify/order-updated', verifyShopifyWebhook, async (req, res, next) => {
  try {
    const order = req.body;
    console.log('📝 Order updated:', order.order_number);

    const shopifyOrderId = String(order.id);
    console.log('[webhook order-updated] received', {
      shopifyOrderId,
      shopifyOrderNumber: order.order_number ? String(order.order_number) : undefined,
      financialStatus: order.financial_status,
      cancelledAt: order.cancelled_at ? 'present' : null,
    });

    const shopifyCustomerId = order.customer?.id != null ? String(order.customer.id) : null;

    // Update cached order snapshot
    await ShopifyOrder.findOneAndUpdate(
      { shopifyOrderId },
      {
        $set: {
          shopifyOrderNumber: order.order_number ? String(order.order_number) : undefined,
          shopifyCustomerId: shopifyCustomerId ?? undefined,
          financialStatus: order.financial_status,
          fulfillmentStatus: order.fulfillment_status,
          cancelledAt: order.cancelled_at ? new Date(order.cancelled_at) : undefined,
          orderUpdatedAt: order.updated_at ? new Date(order.updated_at) : undefined,
          rawOrderData: order,
          lineItems: (order.line_items || []).map((li) => ({
            title: li.title ?? li.name ?? undefined,
            quantity: li.quantity ?? undefined,
            shopifyProductId: li.product_id != null ? String(li.product_id) : undefined,
            shopifyVariantId: li.variant_id != null ? String(li.variant_id) : undefined,
            sku: li.sku ?? undefined,
          })),
        },
      },
      { upsert: true, new: true }
    );

    // Update enrollment status based on order status
    if (order.financial_status === 'refunded' || order.cancelled_at) {
      const updateResult = await Enrollment.updateMany(
        { shopifyOrderId },
        { status: 'cancelled' }
      );
      console.log('[webhook order-updated] cancelled enrollments', {
        shopifyOrderId,
        matchedCount: updateResult?.matchedCount,
        modifiedCount: updateResult?.modifiedCount,
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/webhooks/shopify/product-created
 * Products/courses come from Shopify. Create or update course from product.
 */
router.post('/shopify/product-created', verifyShopifyWebhook, async (req, res, next) => {
  try {
    const product = req.body;
    console.log('🆕 Product created:', product.title);

    const course = await Course.findOne({ shopifyProductId: String(product.id) });

    const handle = product.handle || undefined;
    const tags = Array.isArray(product.tags)
      ? product.tags
      : typeof product.tags === 'string'
        ? product.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [];
    const image = product.image?.src || product.images?.[0]?.src;
    if (course) {
      // Update existing course
      course.title = product.title;
      course.description = product.body_html;
      course.productType = product.product_type || undefined;
      course.tags = tags;
      course.thumbnail = image;
      course.image = image;
      course.handle = handle;
      course.shopifyData = product;
      course.lastSyncedAt = new Date();
      await course.save();
      console.log('✅ Updated course:', course.title);
    } else {
      // Create new course
      await Course.create({
        shopifyProductId: String(product.id),
        title: product.title,
        description: product.body_html,
        productType: product.product_type || undefined,
        tags,
        thumbnail: image,
        image,
        handle,
        shopifyData: product,
      });
      console.log('✅ Created course:', product.title);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/webhooks/shopify/product-updated
 * Products/courses come from Shopify. Update course from product.
 */
router.post('/shopify/product-updated', verifyShopifyWebhook, async (req, res, next) => {
  try {
    const product = req.body;
    console.log('📝 Product updated:', product.title);

    const course = await Course.findOne({ shopifyProductId: String(product.id) });

    if (course) {
      course.title = product.title;
      course.description = product.body_html;
      course.productType = product.product_type || course.productType;
      course.tags = Array.isArray(product.tags)
        ? product.tags
        : typeof product.tags === 'string'
          ? product.tags.split(',').map((t) => t.trim()).filter(Boolean)
          : course.tags;
      course.thumbnail = product.image?.src || product.images?.[0]?.src || course.thumbnail;
      course.image = product.image?.src || product.images?.[0]?.src || course.image;
      course.handle = product.handle || course.handle;
      course.shopifyData = product;
      course.lastSyncedAt = new Date();
      await course.save();
      console.log('✅ Updated course:', course.title);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/webhooks/shopify/customers-create
 * Users come from Shopify. Sync customer to User when they register.
 */
router.post('/shopify/customers-create', verifyShopifyWebhook, async (req, res, next) => {
  try {
    const customer = req.body;
    console.log('👤 Customer created:', customer.email);

    const user = await syncCustomerToUser(customer, req.shopifyShop, req.shopifyShopId);

    // Also backfill/sync order-derived enrollments for this customer.
    // This keeps SCORM dashboards ready even if order webhooks were delayed/missed.
    if (user?._id && customer?.id != null) {
      try {
        await syncOrdersForShopifyCustomer({
          userId: user._id.toString(),
          shopifyCustomerId: String(customer.id),
        });
        console.log('[webhook customers-create] synced orders for customer', {
          userId: user._id.toString(),
          shopifyCustomerId: String(customer.id),
        });
      } catch (syncErr) {
        console.warn(
          '[webhook customers-create] order sync failed:',
          syncErr?.message || syncErr
        );
      }
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error syncing customer create:', error);
    next(error);
  }
});

/**
 * POST /api/webhooks/shopify/customers-update
 * Users come from Shopify. Sync customer updates to User.
 */
router.post('/shopify/customers-update', verifyShopifyWebhook, async (req, res, next) => {
  try {
    const customer = req.body;
    console.log('👤 Customer updated:', customer.email);

    const user = await syncCustomerToUser(customer, req.shopifyShop, req.shopifyShopId);

    // Keep enrollments/order cache aligned whenever customer profile updates arrive.
    if (user?._id && customer?.id != null) {
      try {
        await syncOrdersForShopifyCustomer({
          userId: user._id.toString(),
          shopifyCustomerId: String(customer.id),
        });
        console.log('[webhook customers-update] synced orders for customer', {
          userId: user._id.toString(),
          shopifyCustomerId: String(customer.id),
        });
      } catch (syncErr) {
        console.warn(
          '[webhook customers-update] order sync failed:',
          syncErr?.message || syncErr
        );
      }
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error syncing customer update:', error);
    next(error);
  }
});

export default router;
