import express from 'express';
import Course from '../models/Course.js';
import User from '../models/User.js';

const router = express.Router();

function requireDebugSecret(req, res, next) {
  const expected = process.env.DEBUG_SHOPIFY_SECRET;
  if (!expected) {
    return res.status(500).json({ error: 'DEBUG_SHOPIFY_SECRET is not configured' });
  }

  // Support either:
  // - header: x-debug-secret
  // - query: ?debugSecret=...
  const provided =
    req.headers['x-debug-secret'] ?? req.query?.debugSecret ?? req.query?.debugsecret;

  if (typeof provided !== 'string' || provided !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

function normalizeShopDomain(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  return raw.replace(/^https?:\/\//i, '').split('/')[0] || null;
}

function getShopifyAdminConfig() {
  const shopifyShopDomain = normalizeShopDomain(
    process.env.SHOPIFY_SHOP_DOMAIN ?? process.env.SHOPIFY_SHOP
  );
  const shopifyAdminAccessToken =
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? process.env.SHOPIFY_ADMIN_API_TOKEN;
  const shopifyAdminApiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || '2025-01';
  return { shopifyShopDomain, shopifyAdminAccessToken, shopifyAdminApiVersion };
}

async function shopifyPostGraphql(endpoint, headers, payload) {
  const body = JSON.stringify(payload);
  let response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual', // avoid method switching on redirects (can become GET)
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

router.get('/customer/:customerId', requireDebugSecret, async (req, res, next) => {
  try {
    const customerId = req.params.customerId;
    const shopifyCustomerGid =
      customerId.startsWith('gid://shopify/Customer/')
        ? customerId
        : `gid://shopify/Customer/${customerId}`;

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

    const query = `
      query CustomerById($id: ID!) {
        customer(id: $id) {
          id
          firstName
          lastName
          email
          displayName
          phone
          state
          createdAt
          updatedAt
          numberOfOrders
        }
      }
    `;

    const data = await shopifyPostGraphql(endpoint, headers, {
      query,
      variables: { id: shopifyCustomerGid },
    });

    res.json({
      shopifyCustomer: data?.data?.customer ?? null,
      errors: data?.errors ?? null,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/orders/:customerId', requireDebugSecret, async (req, res, next) => {
  try {
    const customerId = req.params.customerId;
    const limitOrders = Number(req.query.limitOrders ?? 50);
    const safeLimitOrders = Number.isFinite(limitOrders) ? Math.max(1, limitOrders) : 50;

    const shopifyCustomerGid =
      customerId.startsWith('gid://shopify/Customer/')
        ? customerId
        : `gid://shopify/Customer/${customerId}`;

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

    const query = `
      query CustomerOrders($id: ID!, $cursor: String) {
        customer(id: $id) {
          orders(first: 10, after: $cursor, sortKey: CREATED_AT, reverse: true) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                name
                createdAt
                lineItems(first: 50) {
                  edges {
                    node {
                      title
                      quantity
                      variant {
                        id
                        sku
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

    // Collect all Shopify product IDs we see to show mapping result too.
    const orders = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage && orders.length < safeLimitOrders) {
      const data = await shopifyPostGraphql(endpoint, headers, {
        query,
        variables: { id: shopifyCustomerGid, cursor },
      });

      const conn = data?.data?.customer?.orders;
      const edges = conn?.edges ?? [];
      const pageInfo = conn?.pageInfo ?? { hasNextPage: false, endCursor: null };

      for (const edge of edges) {
        if (orders.length >= safeLimitOrders) break;
        orders.push(edge.node);
      }

      hasNextPage = Boolean(pageInfo?.hasNextPage);
      cursor = pageInfo?.endCursor ?? null;
    }

    // Map to internal courses by shopify product id (numeric part)
    // This is best-effort and only meant for debugging.
    const productIds = new Set();
    for (const o of orders) {
      for (const li of o?.lineItems?.edges ?? []) {
        const productId = li?.node?.variant?.product?.id;
        if (typeof productId === 'string') {
          const m = productId.match(/gid:\/\/shopify\/\w+\/(\d+)/i);
          if (m?.[1]) productIds.add(m[1]);
        }
      }
    }

    const courses = productIds.size
      ? await Course.find({ shopifyProductId: { $in: [...productIds] }, isActive: true }).select('shopifyProductId title')
      : [];

    const courseByShopifyProductId = new Map(
      courses.map((c) => [String(c.shopifyProductId), c])
    );

    const mapped = orders.map((o) => {
      const lineItems = (o?.lineItems?.edges ?? []).map((li) => {
        const product = li?.node?.variant?.product;
        const productGid = product?.id;
        const m = typeof productGid === 'string' ? productGid.match(/gid:\/\/shopify\/\w+\/(\d+)/i) : null;
        const shopifyProductId = m?.[1] ?? null;
        const mappedCourse = shopifyProductId ? courseByShopifyProductId.get(String(shopifyProductId)) : null;

        return {
          title: li?.node?.title ?? null,
          quantity: li?.node?.quantity ?? null,
          product: product
            ? {
                id: product?.id ?? null,
                title: product?.title ?? null,
                productType: product?.productType ?? null,
                featuredImage: product?.featuredImage ?? null,
              }
            : null,
          mappedCourse: mappedCourse
            ? { _id: mappedCourse._id.toString(), title: mappedCourse.title }
            : null,
        };
      });

      return {
        id: o?.id ?? null,
        name: o?.name ?? null,
        createdAt: o?.createdAt ?? null,
        lineItems,
      };
    });

    res.json({
      shopifyOrders: orders,
      mappedLineItems: mapped,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

