import express from 'express';
import Course from '../models/Course.js';
import User from '../models/User.js';
import Enrollment from '../models/Enrollment.js';
import Progress from '../models/Progress.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

function normalizeShopDomain(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  // Accept values like:
  // - "vectra-shop.myshopify.com"
  // - "https://vectra-shop.myshopify.com/"
  // - "https://vectra-shop.myshopify.com/admin"
  return raw.replace(/^https?:\/\//i, '').split('/')[0] || null;
}

async function shopifyPostGraphql(endpoint, headers, payload) {
  const body = JSON.stringify(payload);
  let response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual', // keep method; Shopify may respond with 301 to the myshopify host
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location) {
      const redirectUrl = new URL(location, endpoint).toString();
      response = await fetch(redirectUrl, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
      });
    }
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Shopify Admin API error ${response.status}: ${responseText}`);
  }

  return responseText ? JSON.parse(responseText) : {};
}

function getShopifyAdminConfig() {
  // Support multiple env var names used across setups.
  // Prefer SHOPIFY_SHOP_DOMAIN, fallback to SHOPIFY_SHOP (common myshopify.com domain).
  const shopifyShopDomain = normalizeShopDomain(
    process.env.SHOPIFY_SHOP_DOMAIN ?? process.env.SHOPIFY_SHOP
  ); // e.g. marketplace.vectra-intl.com or xxxx.myshopify.com
  const shopifyAdminAccessToken =
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? process.env.SHOPIFY_ADMIN_API_TOKEN;
  const shopifyAdminApiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || '2025-01';
  return { shopifyShopDomain, shopifyAdminAccessToken, shopifyAdminApiVersion };
}

function parseNumericFromGid(gid) {
  const s = String(gid ?? '');
  const m = s.match(/gid:\/\/shopify\/\w+\/(\d+)/i);
  if (m?.[1]) return m[1];
  const digits = s.match(/^(\d+)$/);
  return digits?.[1] ?? null;
}

function parseShopifyOrderNumber(orderName) {
  const s = String(orderName ?? '');
  // Shopify GraphQL "name" is usually like "#1001".
  return s.startsWith('#') ? s.slice(1) : s;
}

function getShopifyCustomerGid(shopifyCustomerId) {
  if (!shopifyCustomerId) return null;
  const s = String(shopifyCustomerId);
  if (/^gid:\/\/shopify\/Customer\//i.test(s)) return s;
  const numeric = parseNumericFromGid(s);
  if (!numeric) return null;
  return `gid://shopify/Customer/${numeric}`;
}

const CUSTOMER_ORDERS_QUERY = `
  query CustomerOrders($id: ID!, $cursor: String) {
    customer(id: $id) {
      id
      orders(first: 10, after: $cursor, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            financialStatus
            fulfillmentStatus
            lineItems(first: 50) {
              edges {
                node {
                  title
                  quantity
                  variant {
                    sku
                    id
                    product {
                      id
                      title
                      productType
                      featuredImage {
                        url
                        altText
                      }
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

router.get('/', authenticate, async (req, res, next) => {
  try {
    const enrollments = await Enrollment.find({ userId: req.user.userId })
      .populate('courseId', 'title thumbnail handle scormUrl admissionId totalLessons')
      .populate('userId', 'name email')
      .sort({ enrolledAt: -1 });

    const enrollmentIds = enrollments.map((e) => e._id);
    const progressDocs = enrollmentIds.length
      ? await Progress.find({ enrollmentId: { $in: enrollmentIds } })
      : [];

    const progressByEnrollmentId = new Map(
      progressDocs.map((p) => [String(p.enrollmentId), { progress: p.progress, completed: p.completed }])
    );

    res.json(
      enrollments.map((enrollment) => ({
        ...enrollment.toObject(),
        progress: progressByEnrollmentId.get(String(enrollment._id)) ?? null,
      }))
    );
  } catch (error) {
    next(error);
  }
});

export default router;

