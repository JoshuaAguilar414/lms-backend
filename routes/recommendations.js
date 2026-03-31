import express from 'express';
import Course from '../models/Course.js';

const router = express.Router();

function extractNumericProductId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const gidMatch = s.match(/gid:\/\/shopify\/Product\/(\d+)/i);
  if (gidMatch?.[1]) return gidMatch[1];
  const anyDigits = s.match(/(\d{6,})/);
  return anyDigits?.[1] ?? null;
}

router.get('/', async (req, res, next) => {
  try {
    const productId = extractNumericProductId(req.query.product_id);
    const limit = Math.max(1, Math.min(12, Number(req.query.limit) || 4));

    if (!productId) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    const adminToken =
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? process.env.SHOPIFY_ADMIN_API_TOKEN;
    const shopDomain =
      process.env.SHOPIFY_SHOP_DOMAIN ?? process.env.SHOPIFY_SHOP ?? 'marketplace.vectra-intl.com';
    const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || '2025-01';

    if (!adminToken || !shopDomain) {
      return res.json([]);
    }

    const adminQuery = `
      query ProductRecommendations($productId: ID!) {
        productRecommendations(productId: $productId) {
          id
          title
          handle
          featuredImage {
            url
            altText
          }
          productType
          description
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
        }
      }
    `;

    const endpoint = `https://${String(shopDomain).replace(/^https?:\/\//i, '').replace(
      /\/$/,
      ''
    )}/admin/api/${apiVersion}/graphql.json`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': adminToken,
      },
      body: JSON.stringify({
        query: adminQuery,
        variables: { productId: `gid://shopify/Product/${productId}` },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: 'Failed to fetch recommendations from Shopify',
        details: text,
      });
    }

    const data = await response.json();
    const products = Array.isArray(data?.data?.productRecommendations)
      ? data.data.productRecommendations
      : [];

    const recommendedIds = products
      .map((p) => extractNumericProductId(p?.id))
      .filter(Boolean);

    if (recommendedIds.length === 0) return res.json([]);

    const matchedCourses = await Course.find({
      shopifyProductId: { $in: recommendedIds },
      isActive: true,
    }).select(
      '_id shopifyProductId title description thumbnail image handle productType'
    );

    const courseByShopifyId = new Map(
      matchedCourses.map((c) => [String(c.shopifyProductId), c])
    );

    const payload = products
      .map((product) => {
        const numericId = extractNumericProductId(product?.id);
        if (!numericId) return null;
        const course = courseByShopifyId.get(numericId);
        if (!course) return null;
        return {
          id: String(course._id),
          shopifyProductId: numericId,
          title: course.title || product.title || 'Course',
          description: course.description || product.description || '',
          thumbnail: course.thumbnail || course.image || product?.featuredImage?.url || '',
          tag: course.productType || product.productType || 'Course',
          price: product?.priceRange?.minVariantPrice
            ? `${product.priceRange.minVariantPrice.amount} ${product.priceRange.minVariantPrice.currencyCode}`
            : '',
          href: course.handle
            ? `https://marketplace.vectra-intl.com/products/${course.handle}`
            : `/courses/${encodeURIComponent(course.shopifyProductId || course._id)}`,
        };
      })
      .filter(Boolean)
      .slice(0, limit);

    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

export default router;
