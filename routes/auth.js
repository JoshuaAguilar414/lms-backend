import crypto from 'crypto';
import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/** Secret for signing customer login links. Only SHOPIFY_LINK_SECRET is used (not webhook secret). */
function getLinkSecret() {
  const s = process.env.SHOPIFY_LINK_SECRET;
  return typeof s === 'string' && s.trim() !== '' ? s : null;
}

/**
 * Verify HMAC signature for customerId|email. Signature is required only when SHOPIFY_LINK_SECRET is set.
 */
function verifyLinkSignature(customerId, email, signature) {
  const secret = getLinkSecret();
  if (!secret) return true; // no link secret configured → accept without signature
  if (!signature || typeof signature !== 'string') return false;
  const payload = `${String(customerId)}|${String(email).trim().toLowerCase()}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getShopifyAdminConfig() {
  const shopifyShopDomain = process.env.SHOPIFY_SHOP_DOMAIN; // e.g. marketplace.vectra-intl.com
  // Support both variable names (some setups use SHOPIFY_ADMIN_API_TOKEN).
  const shopifyAdminAccessToken =
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? process.env.SHOPIFY_ADMIN_API_TOKEN;
  const shopifyAdminApiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || '2025-01';
  return { shopifyShopDomain, shopifyAdminAccessToken, shopifyAdminApiVersion };
}

async function fetchShopifyCustomerProfileFromAdminApi(customerId, email) {
  const { shopifyShopDomain, shopifyAdminAccessToken, shopifyAdminApiVersion } = getShopifyAdminConfig();
  if (!shopifyShopDomain || !shopifyAdminAccessToken) return null; // optional feature

  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedId = String(customerId).replace(/^gid:\/\/shopify\/Customer\//i, '');

  const endpoint = `https://${shopifyShopDomain}/admin/api/${shopifyAdminApiVersion}/graphql.json`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': shopifyAdminAccessToken,
  };

  // Try lookup by id first (matches your working curl flow).
  const queryById = `
    query CustomerById($id: ID!) {
      customer(id: $id) {
        id
        firstName
        lastName
        email
        displayName
      }
    }
  `;

  const idVariables = { id: `gid://shopify/Customer/${normalizedId}` };
  try {
    const resp = await axios.post(
      endpoint,
      { query: queryById, variables: idVariables },
      { headers, timeout: 10000 }
    );
    const customer = resp?.data?.data?.customer;
    if (customer) {
      return {
        firstName: customer.firstName ?? null,
        lastName: customer.lastName ?? null,
        email: customer.email ?? null,
        displayName: customer.displayName ?? null,
      };
    }
  } catch (err) {
    // Don't block login if Shopify Admin API lookup fails.
    console.warn(
      'Shopify Admin API lookup failed (by id):',
      err?.response?.data || err?.message || err
    );
  }

  // Fallback: lookup by email (if provided).
  if (normalizedEmail) {
    const queryByEmail = `
      query CustomersByEmail($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              firstName
              lastName
              email
              displayName
            }
          }
        }
      }
    `;

    const variables = { query: `email:${normalizedEmail}` };
    try {
      const resp = await axios.post(
        endpoint,
        { query: queryByEmail, variables },
        { headers, timeout: 10000 }
      );
      const node = resp?.data?.data?.customers?.edges?.[0]?.node;
      if (node) {
        return {
          firstName: node.firstName ?? null,
          lastName: node.lastName ?? null,
          email: node.email ?? null,
          displayName: node.displayName ?? null,
        };
      }
    } catch (err) {
      console.warn(
        'Shopify Admin API lookup failed (by email):',
        err?.response?.data || err?.message || err
      );
    }
  }

  return null;
}

/**
 * Find or create user by Shopify customer ID and email; issue LMS JWT.
 */
async function findOrCreateUserAndIssueLmsToken(customerId, email) {
  const normalizedId = String(customerId).replace(/^gid:\/\/shopify\/Customer\//i, '');
  const normalizedEmail = String(email).trim().toLowerCase();

  // `shopify-customer-login` is a lightweight Liquid login flow (customerId + email).
  // If `SHOPIFY_ADMIN_ACCESS_TOKEN` is configured, we fetch displayName/firstName/lastName
  // from Shopify Admin GraphQL (so we don't need to pass name data through the link).
  const customerProfile = await fetchShopifyCustomerProfileFromAdminApi(normalizedId, normalizedEmail);
  const firstName = customerProfile?.firstName ?? undefined;
  const lastName = customerProfile?.lastName ?? undefined;
  const displayName = customerProfile?.displayName ?? undefined;
  const name =
    (typeof displayName === 'string' && displayName.trim() !== '' ? displayName.trim() : undefined) ||
    [firstName, lastName].filter(Boolean).join(' ').trim() ||
    undefined;

  let user = await User.findOne({ shopifyCustomerId: normalizedId });
  if (!user) {
    const configuredShopId = getConfiguredShopifyShopId();
    user = await User.create({
      shopifyCustomerId: normalizedId,
      email: customerProfile?.email || normalizedEmail || `customer-${normalizedId}@shopify.local`,
      firstName,
      lastName,
      name: name || `Customer ${normalizedId}`,
      shopifyShopId: configuredShopId || undefined,
      // Legacy login (customerId + email) doesn't include the full Shopify customer JSON,
      // but we still persist a minimal snapshot so `/api/auth/me` can expose it.
      shopifyData: {
        id: normalizedId,
        email: (customerProfile?.email ?? normalizedEmail) || undefined,
        ...(firstName ? { first_name: firstName } : {}),
        ...(lastName ? { last_name: lastName } : {}),
        ...(name ? { name } : {}),
      },
    });
  } else {
    const configuredShopId = getConfiguredShopifyShopId();
    if (configuredShopId && !user.shopifyShopId) user.shopifyShopId = configuredShopId;

    const isGenericName = !user.name || user.name === `Customer ${normalizedId}`;
    const shouldUpdateName = Boolean(name && isGenericName);
    const shouldUpdateFirstLast = Boolean(
      firstName && lastName && (!user.firstName || !user.lastName)
    );
    const shouldUpdateEmail = Boolean(
      customerProfile?.email &&
        (!user.email ||
          user.email.toLowerCase() !== customerProfile.email.toLowerCase() ||
          user.email.includes(`customer-${normalizedId}@shopify.local`))
    );

    if (shouldUpdateName || shouldUpdateFirstLast || shouldUpdateEmail) {
      if (shouldUpdateName) user.name = name || user.name;
      if (shouldUpdateFirstLast) {
        if (firstName) user.firstName = firstName;
        if (lastName) user.lastName = lastName;
      }
      if (shouldUpdateEmail) user.email = customerProfile?.email || user.email;

      // Keep shopifyData snapshot somewhat fresh for `/api/auth/me`
      user.shopifyData = {
        ...(user.shopifyData || {}),
        ...(firstName ? { first_name: firstName } : {}),
        ...(lastName ? { last_name: lastName } : {}),
        ...(name ? { name } : {}),
        ...(customerProfile?.email ? { email: customerProfile.email } : {}),
      };
      user.lastSyncedAt = new Date();
      await user.save();
    }
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
 * Redirect to frontend auth login with jwtToken (pattern: training.vectra-intl.com/auth/login?jwtToken=...).
 */
function redirectToFrontendWithToken(res, lmsToken) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const loginUrl = `${frontendUrl}/auth/login?jwtToken=${encodeURIComponent(lmsToken)}`;
  res.redirect(302, loginUrl);
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
 * Optional fixed numeric shop/store id for a single-shop deployment.
 * Useful when session/webhook payloads don't include a shop id we can extract.
 */
function getConfiguredShopifyShopId() {
  const raw = process.env.SHOPIFY_SHOP_ID;
  if (!raw) return null;
  const str = String(raw).trim();
  if (!str) return null;
  // Allow passing either "77453132000" or a GID-like value; extract the numeric part.
  return str.match(/(\d+)/)?.[1] ?? null;
}

/**
 * GET /api/auth/shopify-redirect
 * My Courses redirect from Shopify: verify Shopify session token, then redirect to LMS frontend.
 * Use this as the "My Courses" link target on Shopify (with token appended by your theme/app).
 * Backend verifies the token with Shopify (JWT signed by SHOPIFY_API_SECRET); frontend will
 * verify again via POST /api/auth/shopify-verify when loading /auth/callback.
 * Query: token (required) – Shopify Customer Account session JWT.
 */
router.get('/shopify-redirect', async (req, res, next) => {
  try {
    const token = req.query.token;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        error: 'Missing token',
        usage: 'GET /api/auth/shopify-redirect?token=<shopify-session-jwt>',
      });
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

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const callbackUrl = `${frontendUrl}/auth/callback?token=${encodeURIComponent(token)}`;
    res.redirect(302, callbackUrl);
  } catch (error) {
    next(error);
  }
});

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

    // Best-effort extraction of Shopify shop/store from the session JWT.
    // Many Shopify session tokens include "dest" (shop domain / url).
    const destLike = payload?.dest ?? payload?.aud ?? payload?.iss ?? null;
    let tokenShopDomain = null;
    if (typeof destLike === 'string') {
      tokenShopDomain = destLike.replace(/^https?:\/\//i, '').split('/')[0] || null;
    }
    let tokenShopId =
      payload?.shop_id ?? payload?.shopId ?? null;
    if (!tokenShopId && typeof destLike === 'string') {
      tokenShopId = destLike.match(/(\d+)/)?.[1] ?? null;
    }

    const configuredShopId = getConfiguredShopifyShopId();

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
        shopifyShopDomain: tokenShopDomain || undefined,
        shopifyShopId: tokenShopId ? String(tokenShopId) : configuredShopId || undefined,
      });
    } else {
      // Populate shop/store fields for older users.
      if (tokenShopDomain && !user.shopifyShopDomain) user.shopifyShopDomain = tokenShopDomain;
      if (tokenShopId && !user.shopifyShopId) user.shopifyShopId = String(tokenShopId);
      if (configuredShopId && !user.shopifyShopId) user.shopifyShopId = configuredShopId;
      // Keep latest session payload snapshot.
      user.shopifyData = payload;
      user.lastSyncedAt = new Date();
      await user.save();
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
 * POST /api/auth/external-login
 * Login via external JWT (e.g. ApnaSite / training.vectra-intl.com auth/login?jwtToken=...).
 * Body: { jwtToken: "<external-jwt>" }. Verifies with EXTERNAL_JWT_SECRET, finds/creates user by id/email, returns LMS token.
 */
router.post('/external-login', async (req, res, next) => {
  try {
    const jwtToken = req.body?.jwtToken ?? req.query?.jwtToken;
    if (!jwtToken || typeof jwtToken !== 'string') {
      return res.status(400).json({
        error: 'Missing jwtToken',
        usage: 'POST /api/auth/external-login with body { jwtToken: "..." } or GET ?jwtToken=...',
      });
    }

    const secret = process.env.EXTERNAL_JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'EXTERNAL_JWT_SECRET not configured' });
    }

    let payload;
    try {
      payload = jwt.verify(jwtToken, secret, { algorithms: ['HS256'] });
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired external token' });
    }

    const externalId = String(payload.id ?? payload.sub ?? '').trim();
    const email = String(payload.email ?? '').trim().toLowerCase() || `external-${externalId}@lms.local`;
    const name = String(payload.name ?? '').trim() || `User ${externalId}`;

    const syntheticCustomerId = `external-${externalId}`;
    let user = await User.findOne({ shopifyCustomerId: syntheticCustomerId });
    if (!user) {
      user = await User.findOne({ email });
      if (!user) {
        user = await User.create({
          shopifyCustomerId: syntheticCustomerId,
          email,
          name,
          shopifyData: { source: 'external-login', payload: { id: payload.id, companyId: payload.companyId } },
        });
      }
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(500).json({ error: 'JWT secret not configured' });
    }

    const lmsToken = jwt.sign(
      { userId: user._id.toString(), shopifyCustomerId: user.shopifyCustomerId },
      jwtSecret,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token: lmsToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/shopify-customer-login
 * Legacy/Liquid-friendly login: customerId + email (optional signature).
 * Redirects to frontend /auth/login?jwtToken=... for the same flow as token-based login.
 * Query: customerId, email, signature (optional; required only if SHOPIFY_LINK_SECRET is set).
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
      return res.status(401).json({
        error: 'Invalid or missing link signature',
        hint: 'Link signing is required when SHOPIFY_LINK_SECRET is set in .env. Leave it unset for Liquid "My Courses" links without signature, and ensure the latest backend is deployed.',
      });
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
    const user = await User.findById(req.user.userId).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // We prefer values stored from webhook headers (per store/customer).
    // Fallback: best-effort extraction from shopifyData (older users / other login flows).
    let shopifyShopDomain = user.shopifyShopDomain ?? null;
    let shopifyShopId = user.shopifyShopId ?? null;

    const shopifyData = user.shopifyData || {};
    const destLike = shopifyData?.dest ?? shopifyData?.aud ?? shopifyData?.iss ?? null;

    if (!shopifyShopDomain && typeof destLike === 'string') {
      // Convert something like "https://xxxx.myshopify.com/" -> "xxxx.myshopify.com"
      shopifyShopDomain = destLike.replace(/^https?:\/\//i, '').split('/')[0] || null;
    }

    if (!shopifyShopId) {
      // Best-effort numeric extraction (only if the token actually contains a number)
      shopifyShopId =
        shopifyData?.shop_id ?? shopifyData?.shopId ?? null ??
        (typeof destLike === 'string' ? destLike.match(/(\d+)/)?.[1] ?? null : null);
    }

    // Final fallback: fixed shop id configured per deployment.
    if (!shopifyShopId) {
      shopifyShopId = getConfiguredShopifyShopId();
    }

    res.json({
      id: user._id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      shopifyCustomerId: user.shopifyCustomerId,
      shopifyShopDomain,
      shopifyShopId: shopifyShopId ? String(shopifyShopId) : null,
      // Expose Shopify customer snapshot when available (may be missing for legacy users).
      shopifyData: user.shopifyData ?? null,
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
