import mongoose from 'mongoose';

/**
 * Enrollment = derived from Shopify Orders (order-created webhook creates these).
 * Links User (Shopify customer) to Course (Shopify product) via shopifyOrderId/shopifyProductId.
 */
const enrollmentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    shopifyOrderId: {
      type: String,
      required: true,
      index: true,
    },
    shopifyOrderNumber: {
      type: String,
    },
    shopifyProductId: {
      type: String,
      required: true,
    },
    // Enrollment status
    status: {
      type: String,
      enum: ['active', 'completed', 'expired', 'cancelled'],
      default: 'active',
    },
    // Enrollment dates
    enrolledAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
    },
    expiresAt: {
      type: Date, // Optional expiration date
    },
    // Store order data snapshot
    orderData: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common queries
enrollmentSchema.index({ userId: 1, status: 1 });
enrollmentSchema.index({ courseId: 1, status: 1 });
enrollmentSchema.index({ shopifyOrderId: 1 });

const Enrollment = mongoose.model('Enrollment', enrollmentSchema);

export default Enrollment;
