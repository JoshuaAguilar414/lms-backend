import jwt from 'jsonwebtoken';
import crypto from 'crypto';

/**
 * Middleware to verify LMS JWT (issued after Shopify session verification).
 */
export const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    if (decoded.userId) req.user.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Middleware to verify Shopify webhook signature (HMAC-SHA256).
 * Uses SHOPIFY_WEBHOOK_SECRET; fallback to SHOPIFY_API_SECRET if webhook secret not set.
 */
export const verifyShopifyWebhook = (req, res, next) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const shop = req.headers['x-shopify-shop-domain'];
  const topic = req.headers['x-shopify-topic'];

  if (!hmac || !shop || !topic) {
    return res.status(401).json({ error: 'Missing Shopify webhook headers' });
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  // Use raw body for HMAC (Shopify signs the exact request body; parsed JSON can differ)
  const body = req.rawBody && Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body), 'utf8');
  const hash = crypto.createHmac('sha256', secret).update(body).digest('base64');

  if (crypto.timingSafeEqual(Buffer.from(hmac, 'base64'), Buffer.from(hash, 'base64')) === false) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  req.shopifyShop = shop;
  req.shopifyTopic = topic;
  next();
};
