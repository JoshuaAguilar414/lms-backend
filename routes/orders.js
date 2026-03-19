import express from 'express';
import axios from 'axios';
import Course from '../models/Course.js';
import User from '../models/User.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

function getShopifyAdminConfig() {
  const shopifyShopDomain = process.env.SHOPIFY_SHOP_DOMAIN; // e.g. marketplace.vectra-intl.com
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
  query CustomerOrders($id: ID!) {
    customer(id: $id) {
      id
      orders(first: 50, sortKey: CREATED_AT, reverse: true) {
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
      }
    }
  }
`;

router.get('/', authenticate, async (req, res, next) => {
  try {
    const shopifyCustomerGid = getShopifyCustomerGid(req.user?.shopifyCustomerId);
    if (!shopifyCustomerGid) {
      return res.status(400).json({ error: 'Missing/invalid shopifyCustomerId in token' });
    }

    const user = await User.findById(req.user.userId).select('name email');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { shopifyShopDomain, shopifyAdminAccessToken, shopifyAdminApiVersion } =
      getShopifyAdminConfig();
    if (!shopifyShopDomain || !shopifyAdminAccessToken) {
      return res.status(500).json({ error: 'Shopify Admin API not configured' });
    }

    const endpoint = `https://${shopifyShopDomain}/admin/api/${shopifyAdminApiVersion}/graphql.json`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': shopifyAdminAccessToken,
    };

    const resp = await axios.post(
      endpoint,
      {
        query: CUSTOMER_ORDERS_QUERY,
        variables: { id: shopifyCustomerGid },
      },
      { headers, timeout: 20000 }
    );

    const edges = resp?.data?.data?.customer?.orders?.edges ?? [];

    const candidates = [];
    const productIdsSet = new Set();

    for (const orderEdge of edges) {
      const order = orderEdge?.node;
      if (!order) continue;

      const shopifyOrderId = parseNumericFromGid(order.id);
      if (!shopifyOrderId) continue;

      const shopifyOrderNumber = parseShopifyOrderNumber(order.name);
      const enrolledAt = order.createdAt
        ? new Date(order.createdAt).toISOString()
        : new Date().toISOString();

      // Map fulfillment to "completed" UX.
      const isCompleted =
        order.fulfillmentStatus === 'fulfilled' || order.fulfillmentStatus === 'delivered';

      const lineItemEdges = order?.lineItems?.edges ?? [];
      let lineIndex = 0;
      for (const lineEdge of lineItemEdges) {
        const line = lineEdge?.node;
        lineIndex += 1;

        const productGid = line?.variant?.product?.id;
        const shopifyProductId = parseNumericFromGid(productGid);
        if (!shopifyProductId) continue;

        candidates.push({
          lineIndex,
          shopifyOrderId,
          shopifyOrderNumber,
          shopifyProductId,
          enrolledAt,
          isCompleted,
        });
        productIdsSet.add(shopifyProductId);
      }
    }

    const productIds = [...productIdsSet];
    const courses = productIds.length
      ? await Course.find({
          shopifyProductId: { $in: productIds },
          isActive: true,
        }).select('shopifyProductId title thumbnail handle scormUrl admissionId totalLessons')
      : [];

    const courseByShopifyProductId = new Map(
      courses.map((c) => [String(c.shopifyProductId), c])
    );

    const items = [];
    for (const c of candidates) {
      const course = courseByShopifyProductId.get(String(c.shopifyProductId));
      if (!course) continue;

      items.push({
        _id: `${c.shopifyOrderId}:${c.shopifyProductId}:${c.lineIndex}`,
        userId: { _id: user._id.toString(), name: user.name, email: user.email },
        courseId: {
          _id: course._id.toString(),
          title: course.title,
          thumbnail: course.thumbnail,
          handle: course.handle,
          scormUrl: course.scormUrl,
          admissionId: course.admissionId,
          totalLessons: course.totalLessons,
        },
        shopifyOrderId: String(c.shopifyOrderId),
        shopifyOrderNumber: c.shopifyOrderNumber || undefined,
        status: c.isCompleted ? 'completed' : 'active',
        enrolledAt: c.enrolledAt,
        progress: c.isCompleted ? { progress: 100, completed: true } : null,
      });
    }

    res.json(items);
  } catch (error) {
    next(error);
  }
});

export default router;

