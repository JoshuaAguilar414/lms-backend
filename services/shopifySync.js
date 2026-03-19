import Course from '../models/Course.js';
import Enrollment from '../models/Enrollment.js';
import Progress from '../models/Progress.js';
import ShopifyOrder from '../models/ShopifyOrder.js';

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

function parseNumericFromGid(gid) {
  const s = String(gid ?? '');
  const m = s.match(/gid:\/\/shopify\/\w+\/(\d+)/i);
  if (m?.[1]) return m[1];
  const digits = s.match(/^(\d+)$/);
  return digits?.[1] ?? null;
}

function getShopifyCustomerGid(shopifyCustomerId) {
  if (!shopifyCustomerId) return null;
  const s = String(shopifyCustomerId);
  if (/^gid:\/\/shopify\/Customer\//i.test(s)) return s;
  const numeric = parseNumericFromGid(s);
  if (!numeric) return null;
  return `gid://shopify/Customer/${numeric}`;
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

const CUSTOMER_ORDERS_QUERY = `
  query CustomerOrders($id: ID!, $cursor: String) {
    customer(id: $id) {
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
                    id
                    product {
                      id
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

function parseShopifyOrderNumber(orderName) {
  const s = String(orderName ?? '');
  return s.startsWith('#') ? s.slice(1) : s;
}

/**
 * Sync Shopify orders -> Mongo enrollments/progress (SCORM tracking).
 * - Only creates/enriches Enrollment + Progress for courses that exist in Mongo.
 * - Safe to run multiple times (finds existing enrollment by shopify ids).
 */
export async function syncOrdersForShopifyCustomer({ userId, shopifyCustomerId }) {
  const { shopifyShopDomain, shopifyAdminAccessToken, shopifyAdminApiVersion } =
    getShopifyAdminConfig();

  if (!shopifyShopDomain || !shopifyAdminAccessToken) {
    throw new Error('Shopify Admin API not configured');
  }

  const shopifyCustomerGid = getShopifyCustomerGid(shopifyCustomerId);
  if (!shopifyCustomerGid) {
    throw new Error('Missing/invalid shopifyCustomerId');
  }

  const endpoint = `https://${shopifyShopDomain}/admin/api/${shopifyAdminApiVersion}/graphql.json`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': shopifyAdminAccessToken,
  };

  let hasNextPage = true;
  let cursor = null;
  let processedOrders = 0;
  let matchedCourses = 0;
  let enrollmentsCreated = 0;
  let progressCreated = 0;
  let ordersCached = 0;

  while (hasNextPage) {
    const respJson = await shopifyPostGraphql(endpoint, headers, {
      query: CUSTOMER_ORDERS_QUERY,
      variables: { id: shopifyCustomerGid, cursor },
    });

    const ordersConn = respJson?.data?.data?.customer?.orders;
    const edges = ordersConn?.edges ?? [];
    const pageInfo = ordersConn?.pageInfo ?? { hasNextPage: false, endCursor: null };

    for (const orderEdge of edges) {
      const order = orderEdge?.node;
      if (!order) continue;
      processedOrders += 1;

      const shopifyOrderId = parseNumericFromGid(order.id);
      if (!shopifyOrderId) continue;

      const shopifyOrderNumber = parseShopifyOrderNumber(order.name);
      const enrolledAt = order.createdAt ? new Date(order.createdAt).toISOString() : undefined;

      // Cache order snapshot in Mongo (for order history later/debug).
      await ShopifyOrder.findOneAndUpdate(
        { shopifyOrderId: String(shopifyOrderId) },
        {
          $set: {
            shopifyOrderNumber: shopifyOrderNumber || undefined,
            financialStatus: order.financialStatus ?? undefined,
            fulfillmentStatus: order.fulfillmentStatus ?? undefined,
            orderCreatedAt: order.createdAt ? new Date(order.createdAt) : undefined,
            rawOrderData: order,
          },
        },
        { upsert: true, new: true }
      );
      ordersCached += 1;

      const lineItemEdges = order?.lineItems?.edges ?? [];
      for (const lineEdge of lineItemEdges) {
        const line = lineEdge?.node;
        const productGid = line?.variant?.product?.id;
        const shopifyProductId = parseNumericFromGid(productGid);
        if (!shopifyProductId) continue;

        const course = await Course.findOne({ shopifyProductId: String(shopifyProductId), isActive: true }).select(
          '_id title scormUrl admissionId totalLessons thumbnail handle shopifyProductId'
        );
        if (!course) continue;

        matchedCourses += 1;

        const existingEnrollment = await Enrollment.findOne({
          userId,
          shopifyOrderId: String(shopifyOrderId),
          shopifyProductId: String(shopifyProductId),
        });

        const enrollment = existingEnrollment
          ? await Enrollment.findByIdAndUpdate(
              existingEnrollment._id,
              {
                $set: {
                  enrolledAt: enrolledAt ? new Date(enrolledAt) : existingEnrollment.enrolledAt,
                  shopifyOrderNumber: shopifyOrderNumber || existingEnrollment.shopifyOrderNumber,
                  orderData: order,
                  status: existingEnrollment.status || 'active',
                },
              },
              { new: true }
            )
          : await Enrollment.create({
              userId,
              courseId: course._id,
              shopifyOrderId: String(shopifyOrderId),
              shopifyOrderNumber: shopifyOrderNumber || undefined,
              shopifyProductId: String(shopifyProductId),
              orderData: order,
              enrolledAt: enrolledAt ? new Date(enrolledAt) : undefined,
              status: 'active',
            });

        if (enrollment && !existingEnrollment) enrollmentsCreated += 1;
        // If enrollment existed, enrollmentsCreated is intentionally not incremented.

        const existingProgress = await Progress.findOne({ enrollmentId: enrollment?._id });
        if (!existingProgress && enrollment?._id) {
          await Progress.create({
            enrollmentId: enrollment._id,
            courseId: course._id,
            userId,
            progress: 0,
            completed: false,
          });
          progressCreated += 1;
        }
      }
    }

    hasNextPage = Boolean(pageInfo?.hasNextPage);
    cursor = pageInfo?.endCursor ?? null;
  }

  console.log('[shopify sync] summary', {
    userId,
    shopifyCustomerId,
    processedOrders,
    matchedCourses,
    enrollmentsCreated,
    progressCreated,
    ordersCached,
  });
}

