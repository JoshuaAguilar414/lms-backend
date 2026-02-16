import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const router = express.Router();

/**
 * Extract numeric Shopify customer ID from token "sub" claim.
 * Shopify may send "sub" as numeric string or GID: gid://shopify/Customer/123
 */
function parseShopifyCustomerId(sub) {
  if (sub == null || sub === '') return null;
  const str = String(sub);
  const gidMatch = str.match(/gid:\/\/shopify\/Customer\/(\d+)/);
  if (gidMatch) return gidMatch[1];
  if (/^\d+$/.test(str)) return str;
  return str;
}

/**
 * POST /api/auth/shopify-verify
 * Verify Shopify session token and return LMS JWT.
 * Body: { token: "<shopify-session-jwt>" } or send token in Authorization: Bearer <token>
 * Shopify session tokens are JWTs signed with SHOPIFY_API_SECRET (HS256).
 */
router.post('/shopify-verify', async (req, res, next) => {
  try {
    const token =
      req.body?.token ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return res.status(401).json({ error: 'Missing Shopify session token' });
    }

    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'Shopify API secret not configured' });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired Shopify token' });
    }

    const customerId = parseShopifyCustomerId(payload.sub);
    if (!customerId) {
      return res.status(401).json({ error: 'Token missing customer id (sub)' });
    }

    let user = await User.findOne({ shopifyCustomerId: customerId });
    if (!user) {
      user = await User.create({
        shopifyCustomerId: customerId,
        email: payload.email ?? `customer-${customerId}@shopify.local`,
        firstName: payload.first_name ?? payload.given_name,
        lastName: payload.last_name ?? payload.family_name,
        name: [payload.first_name ?? payload.given_name, payload.last_name ?? payload.family_name]
          .filter(Boolean)
          .join(' ')
          .trim() || `Customer ${customerId}`,
        shopifyData: payload,
      });
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(500).json({ error: 'JWT secret not configured' });
    }

    const lmsToken = jwt.sign(
      { userId: user._id.toString(), shopifyCustomerId: customerId },
      jwtSecret,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token: lmsToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        shopifyCustomerId: user.shopifyCustomerId,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/sync-user
 * Sync current user from Shopify customer data (e.g. after checkout).
 * Requires authenticate middleware - call after shopify-verify.
 * Body: { email?, firstName?, lastName?, phone? }
 */
router.post('/sync-user', async (req, res, next) => {
  try {
    const token =
      req.body?.shopifyToken ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) {
      return res.status(401).json({ error: 'Missing token' });
    }

    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'Shopify API secret not configured' });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'Invalid Shopify token' });
    }

    const customerId = parseShopifyCustomerId(payload.sub);
    if (!customerId) {
      return res.status(401).json({ error: 'Token missing customer id' });
    }

    const user = await User.findOneAndUpdate(
      { shopifyCustomerId: customerId },
      {
        $set: {
          ...(payload.email && { email: payload.email }),
          ...(payload.first_name && { firstName: payload.first_name }),
          ...(payload.last_name && { lastName: payload.last_name }),
          ...(payload.phone && { phone: payload.phone }),
          name: [payload.first_name ?? payload.given_name, payload.last_name ?? payload.family_name]
            .filter(Boolean)
            .join(' ')
            .trim() || undefined,
          shopifyData: payload,
          lastSyncedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        shopifyCustomerId: user.shopifyCustomerId,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
