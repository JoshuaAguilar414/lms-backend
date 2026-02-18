import express from 'express';
import { verifyShopifyWebhook } from '../middleware/auth.js';
import Enrollment from '../models/Enrollment.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import Progress from '../models/Progress.js';

const router = express.Router();

/** Sync customer payload to User (from order.customer or customer webhook). */
async function syncCustomerToUser(customer) {
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

    const user = await syncCustomerToUser(customer);
    if (!user._id) {
      return res.status(500).json({ error: 'Failed to sync user from order' });
    }

    // Process each line item (course product)
    for (const lineItem of order.line_items || []) {
      // Find course by Shopify product ID
      const course = await Course.findOne({ shopifyProductId: String(lineItem.product_id) });

      if (!course) {
        console.log(`⚠️ Course not found for product ID: ${lineItem.product_id}`);
        continue;
      }

      // Check if enrollment already exists
      const existingEnrollment = await Enrollment.findOne({
        userId: user._id,
        shopifyOrderId: String(order.id),
        shopifyProductId: String(lineItem.product_id),
      });

      if (existingEnrollment) {
        console.log(`ℹ️ Enrollment already exists for order ${order.order_number}`);
        continue;
      }

      // Create enrollment
      const enrollment = await Enrollment.create({
        userId: user._id,
        courseId: course._id,
        shopifyOrderId: String(order.id),
        shopifyOrderNumber: order.order_number,
        shopifyProductId: String(lineItem.product_id),
        orderData: order,
        status: 'active',
      });

      // Create initial progress record
      await Progress.create({
        enrollmentId: enrollment._id,
        courseId: course._id,
        userId: user._id,
        progress: 0,
        completed: false,
      });

      console.log(`✅ Created enrollment for course: ${course.title}`);
    }

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

    // Update enrollment status based on order status
    if (order.financial_status === 'refunded' || order.cancelled_at) {
      await Enrollment.updateMany(
        { shopifyOrderId: String(order.id) },
        { status: 'cancelled' }
      );
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
    if (course) {
      // Update existing course
      course.title = product.title;
      course.description = product.body_html;
      course.thumbnail = product.images?.[0]?.src;
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
        thumbnail: product.images?.[0]?.src,
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
      course.thumbnail = product.images?.[0]?.src;
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

    await syncCustomerToUser(customer);
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

    await syncCustomerToUser(customer);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error syncing customer update:', error);
    next(error);
  }
});

export default router;
