import crypto from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/** Secret for signing customer login links (Liquid-friendly flow). Use SHOPIFY_LINK_SECRET or SHOPIFY_WEBHOOK_SECRET. */
function getLinkSecret() {
  return process.env.SHOPIFY_LINK_SECRET || process.env.SHOPIFY_WEBHOOK_SECRET;
}

/**
 * Verify HMAC signature for customerId|email. If no secret is configured, returns true (insecure, backward compat).
 */
function verifyLinkSignature(customerId, email, signature) {
  const secret = getLinkSecret();
  if (!secret) return true;
  if (!signature || typeof signature !== 'string') return false;
  const payload = `${String(customerId)}|${String(email).trim().toLowerCase()}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Find or create user by Shopify customer ID and email; issue LMS JWT.
 */
async function findOrCreateUserAndIssueLmsToken(customerId, email) {
  const normalizedId = String(customerId).replace(/^gid:\/\/shopify\/Customer\//i, '');
  const normalizedEmail = String(email).trim().toLowerCase();
  let user = await User.findOne({ shopifyCustomerId: normalizedId });
  if (!user) {
    user = await User.create({
      shopifyCustomerId: normalizedId,
      email: normalizedEmail || `customer-${normalizedId}@shopify.local`,
      name: `Customer ${normalizedId}`,
    });
  }
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT secret not configured');
  const lmsToken = jwt.sign(
    { userId: user._id.toString(), shopifyCustomerId: normalizedId },
    jwtSecret,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  return { user, lmsToken };
}

/**
 * Redirect to frontend auth callback with lmsToken.
 */
function redirectToFrontendWithToken(res, lmsToken) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const callbackUrl = `${frontendUrl}/auth/callback?lmsToken=${encodeURIComponent(lmsToken)}`;
  res.redirect(302, callbackUrl);
}

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
 * GET /api/auth/shopify-customer-login
 * Legacy/Liquid-friendly login: customerId + email (optional signature).
 * Redirects to frontend /auth/callback?lmsToken=... for the same flow as token-based login.
 * Query: customerId, email, signature (optional; required if SHOPIFY_LINK_SECRET or SHOPIFY_WEBHOOK_SECRET is set).
 */
router.get('/shopify-customer-login', async (req, res, next) => {
  try {
    const customerId = req.query.customerId;
    const email = req.query.email;
    const signature = req.query.signature;

    if (!customerId || !email) {
      return res.status(400).json({
        error: 'Missing customerId or email',
        usage: 'GET /api/auth/shopify-customer-login?customerId=...&email=...&signature=... (signature optional if no SHOPIFY_LINK_SECRET)',
      });
    }

    if (!verifyLinkSignature(customerId, email, signature)) {
      return res.status(401).json({ error: 'Invalid or missing link signature' });
    }

    const { lmsToken } = await findOrCreateUserAndIssueLmsToken(customerId, email);
    redirectToFrontendWithToken(res, lmsToken);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/me
 * Return current user (from LMS JWT). User data comes from Shopify (synced via webhooks).
 */
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId)
      .select('-shopifyData')
      .lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      id: user._id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      shopifyCustomerId: user.shopifyCustomerId,
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
export { verifyLinkSignature, findOrCreateUserAndIssueLmsToken, redirectToFrontendWithToken };
