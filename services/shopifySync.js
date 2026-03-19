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
            lineItems(first: 50) {
              edges {
                node {
                  title
                  quantity
                  variant {
                    id
                    product {
                      id
                      title
                      productType
                      description
                      tags
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
  const productAggregates = new Map();

  while (hasNextPage) {
    const respJson = await shopifyPostGraphql(endpoint, headers, {
      query: CUSTOMER_ORDERS_QUERY,
      variables: { id: shopifyCustomerGid, cursor },
    });
    if (respJson?.errors?.length) {
      console.warn('[shopify sync] graphql errors', respJson.errors);
      break;
    }

    const ordersConn = respJson?.data?.customer?.orders;
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
            shopifyCustomerId: String(shopifyCustomerId),
            orderCreatedAt: order.createdAt ? new Date(order.createdAt) : undefined,
            rawOrderData: order,
            lineItems: (order?.lineItems?.edges ?? []).map((edge) => {
              const li = edge?.node;
              const productId = parseNumericFromGid(li?.variant?.product?.id);
              const variantId = parseNumericFromGid(li?.variant?.id);
              return {
                title: li?.title ?? undefined,
                quantity: li?.quantity ?? undefined,
                shopifyProductId: productId ?? undefined,
                shopifyVariantId: variantId ?? undefined,
              };
            }),
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
        const lineQuantity = Math.max(1, Number(line?.quantity) || 1);

        let course = await Course.findOne({ shopifyProductId: String(shopifyProductId), isActive: true }).select(
          '_id title scormUrl admissionId totalLessons thumbnail image handle shopifyProductId description productType tags'
        );
        if (!course) {
          // Auto-backfill minimal course when product exists in orders but not in LMS cache.
          const fallbackTitle =
            line?.variant?.product?.title ??
            line?.title ??
            `Course ${String(shopifyProductId)}`;
          course = await Course.create({
            shopifyProductId: String(shopifyProductId),
            title: fallbackTitle,
            description: line?.variant?.product?.description ?? '',
            productType: line?.variant?.product?.productType ?? undefined,
            tags: Array.isArray(line?.variant?.product?.tags) ? line.variant.product.tags : [],
            thumbnail: line?.variant?.product?.featuredImage?.url ?? undefined,
            image: line?.variant?.product?.featuredImage?.url ?? undefined,
            shopifyData: {
              source: 'order-sync-backfill',
              productId: String(shopifyProductId),
              orderId: String(shopifyOrderId),
            },
          });
          console.log('[shopify sync] backfilled missing course', {
            userId,
            shopifyCustomerId,
            shopifyOrderId: String(shopifyOrderId),
            shopifyProductId: String(shopifyProductId),
            courseId: course._id.toString(),
            title: fallbackTitle,
          });
        }

        matchedCourses += 1;

        const key = String(shopifyProductId);
        const prev = productAggregates.get(key);
        if (!prev) {
          productAggregates.set(key, {
            shopifyProductId: key,
            quantity: lineQuantity,
            latestOrderId: String(shopifyOrderId),
            latestOrderNumber: shopifyOrderNumber || undefined,
            latestOrderData: order,
            latestEnrolledAt: enrolledAt ? new Date(enrolledAt) : undefined,
            course,
          });
        } else {
          prev.quantity += lineQuantity;
          const prevTs = prev.latestEnrolledAt ? prev.latestEnrolledAt.getTime() : 0;
          const nextTs = enrolledAt ? new Date(enrolledAt).getTime() : 0;
          if (nextTs >= prevTs) {
            prev.latestOrderId = String(shopifyOrderId);
            prev.latestOrderNumber = shopifyOrderNumber || prev.latestOrderNumber;
            prev.latestOrderData = order;
            prev.latestEnrolledAt = enrolledAt ? new Date(enrolledAt) : prev.latestEnrolledAt;
          }
          prev.course = course;
        }
      }
    }

    hasNextPage = Boolean(pageInfo?.hasNextPage);
    cursor = pageInfo?.endCursor ?? null;
  }

  for (const aggregate of productAggregates.values()) {
    const existingEnrollment = await Enrollment.findOne({
      userId,
      shopifyProductId: aggregate.shopifyProductId,
    }).sort({ enrolledAt: -1 });

    const enrollment = existingEnrollment
      ? await Enrollment.findByIdAndUpdate(
          existingEnrollment._id,
          {
            // Keep one enrollment per user+product and set aggregated quantity
            // from Shopify orders (idempotent across repeated syncs).
            $set: {
              courseId: aggregate.course._id,
              shopifyOrderId: aggregate.latestOrderId,
              shopifyOrderNumber: aggregate.latestOrderNumber || existingEnrollment.shopifyOrderNumber,
              shopifyProductType: aggregate.course.productType,
              shopifyProductDescription: aggregate.course.description,
              shopifyProductTags: Array.isArray(aggregate.course.tags) ? aggregate.course.tags : [],
              shopifyProductImage: aggregate.course.image || aggregate.course.thumbnail,
              orderData: aggregate.latestOrderData,
              quantity: Math.max(1, aggregate.quantity),
              status: existingEnrollment.status === 'cancelled' ? existingEnrollment.status : 'active',
            },
          },
          { new: true }
        )
      : await Enrollment.create({
          userId,
          courseId: aggregate.course._id,
          shopifyOrderId: aggregate.latestOrderId,
          shopifyOrderNumber: aggregate.latestOrderNumber || undefined,
          shopifyProductId: aggregate.shopifyProductId,
          shopifyProductType: aggregate.course.productType,
          shopifyProductDescription: aggregate.course.description,
          shopifyProductTags: Array.isArray(aggregate.course.tags) ? aggregate.course.tags : [],
          shopifyProductImage: aggregate.course.image || aggregate.course.thumbnail,
          orderData: aggregate.latestOrderData,
          quantity: Math.max(1, aggregate.quantity),
          enrolledAt: aggregate.latestEnrolledAt,
          status: 'active',
        });

    if (enrollment && !existingEnrollment) {
      enrollmentsCreated += 1;
    }

    const existingProgress = await Progress.findOne({ enrollmentId: enrollment?._id });
    if (!existingProgress && enrollment?._id) {
      await Progress.create({
        enrollmentId: enrollment._id,
        courseId: aggregate.course._id,
        userId,
        progress: 0,
        completed: false,
      });
      progressCreated += 1;
    }
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

