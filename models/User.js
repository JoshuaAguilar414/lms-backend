import mongoose from 'mongoose';

/**
 * User = Shopify Customer (synced via webhooks: orders, customers/create, customers/update).
 * Source of truth: Shopify. This collection is a sync cache for LMS use.
 */
const userSchema = new mongoose.Schema(
  {
    shopifyCustomerId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    firstName: {
      type: String,
      trim: true,
    },
    lastName: {
      type: String,
      trim: true,
    },
    name: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    // Store Shopify customer data snapshot
    shopifyData: {
      type: mongoose.Schema.Types.Mixed,
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

// Index for faster lookups
userSchema.index({ email: 1 });
userSchema.index({ shopifyCustomerId: 1 });

const User = mongoose.model('User', userSchema);

export default User;
