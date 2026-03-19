import mongoose from 'mongoose';

const shopifyOrderLineItemSchema = new mongoose.Schema(
  {
    title: { type: String },
    quantity: { type: Number },
    shopifyProductId: { type: String, index: true },
    shopifyVariantId: { type: String },
    sku: { type: String },
  },
  { _id: false }
);

/**
 * ShopifyOrder = cached Shopify order history for a customer.
 * Source of truth: Shopify webhooks.
 *
 * Note: LMS UI can still derive SCORM progress via Enrollment/Progress.
 */
const shopifyOrderSchema = new mongoose.Schema(
  {
    shopifyOrderId: { type: String, required: true, unique: true, index: true },
    shopifyOrderNumber: { type: String, index: true },
    shopifyCustomerId: { type: String, required: true, index: true },

    financialStatus: { type: String },
    fulfillmentStatus: { type: String },
    cancelledAt: { type: Date },

    orderCreatedAt: { type: Date },
    orderUpdatedAt: { type: Date },

    // Store the full Shopify payload for troubleshooting/admin needs.
    rawOrderData: { type: mongoose.Schema.Types.Mixed },

    // Reduced line-item data for fast UI/analytics without parsing the raw payload.
    lineItems: [shopifyOrderLineItemSchema],
  },
  { timestamps: true }
);

const ShopifyOrder = mongoose.model('ShopifyOrder', shopifyOrderSchema);
export default ShopifyOrder;

