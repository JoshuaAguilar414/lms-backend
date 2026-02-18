import express from 'express';
import Course from '../models/Course.js';
import { authenticate } from '../middleware/auth.js';
import {
  verifyLinkSignature,
  findOrCreateUserAndIssueLmsToken,
  redirectToFrontendWithToken,
} from './auth.js';

const router = express.Router();

/**
 * GET /api/courses/user/:customerId/:email
 * Legacy "My Courses" redirect URL: training.vectra-intl.com/lms-backend/api/courses/user/{customerId}/{email}
 * Verifies optional ?signature= (required if SHOPIFY_LINK_SECRET set), then redirects to frontend with LMS token.
 */
router.get('/user/:customerId/:email', async (req, res, next) => {
  try {
    const { customerId, email } = req.params;
    const signature = req.query.signature;
    if (!verifyLinkSignature(customerId, decodeURIComponent(email), signature)) {
      return res.status(401).json({ error: 'Invalid or missing link signature' });
    }
    const { lmsToken } = await findOrCreateUserAndIssueLmsToken(customerId, decodeURIComponent(email));
    redirectToFrontendWithToken(res, lmsToken);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/courses
 * Get all active courses
 */
router.get('/', async (req, res, next) => {
  try {
    const courses = await Course.find({ isActive: true })
      .select('-shopifyData')
      .sort({ createdAt: -1 });

    res.json(courses);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/courses/:id
 * Get course by ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const course = await Course.findById(req.params.id).select('-shopifyData');
    
    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    res.json(course);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/courses/shopify/:productId
 * Get course by Shopify product ID
 */
router.get('/shopify/:productId', async (req, res, next) => {
  try {
    const course = await Course.findOne({
      shopifyProductId: req.params.productId,
      isActive: true,
    }).select('-shopifyData');

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    res.json(course);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/courses
 * Create or update course from Shopify product (admin/webhook)
 */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { shopifyProductId, title, description, thumbnail, scormUrl, admissionId, shopifyData } = req.body;

    if (!shopifyProductId || !title) {
      return res.status(400).json({ error: 'shopifyProductId and title are required' });
    }

    let course = await Course.findOne({ shopifyProductId });

    if (course) {
      // Update existing course
      course.title = title;
      course.description = description;
      course.thumbnail = thumbnail;
      course.scormUrl = scormUrl;
      course.admissionId = admissionId;
      course.shopifyData = shopifyData;
      course.lastSyncedAt = new Date();
      await course.save();
    } else {
      // Create new course
      course = await Course.create({
        shopifyProductId,
        title,
        description,
        thumbnail,
        scormUrl,
        admissionId,
        shopifyData,
      });
    }

    res.json(course);
  } catch (error) {
    next(error);
  }
});

export default router;
