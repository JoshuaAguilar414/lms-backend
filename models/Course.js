import mongoose from 'mongoose';

/**
 * Course = Shopify Product (synced via webhooks: products/create, products/update).
 * Source of truth: Shopify. This collection is a sync cache for LMS (enrollments, progress).
 */
const courseSchema = new mongoose.Schema(
  {
    shopifyProductId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
    },
    thumbnail: {
      type: String,
    },
    /** Shopify product handle for storefront URL (e.g. /products/{handle}) */
    handle: {
      type: String,
      trim: true,
    },
    scormUrl: {
      type: String,
    },
    admissionId: {
      type: String,
    },
    // Course metadata
    totalLessons: {
      type: Number,
      default: 0,
    },
    estimatedDuration: {
      type: Number, // in minutes
    },
    // Store Shopify product data snapshot
    shopifyData: {
      type: mongoose.Schema.Types.Mixed,
    },
    // Course status
    isActive: {
      type: Boolean,
      default: true,
    },
    // Last sync timestamp
    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
courseSchema.index({ shopifyProductId: 1 });
courseSchema.index({ isActive: 1 });

const Course = mongoose.model('Course', courseSchema);

export default Course;
