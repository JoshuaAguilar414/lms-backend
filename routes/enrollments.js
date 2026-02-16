import express from 'express';
import Enrollment from '../models/Enrollment.js';
import Course from '../models/Course.js';
import Progress from '../models/Progress.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/enrollments
 * Get current user's enrollments
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const enrollments = await Enrollment.find({ userId: req.user.userId })
      .populate('courseId', 'title thumbnail scormUrl admissionId')
      .populate('userId', 'name email')
      .sort({ enrolledAt: -1 });

    // Get progress for each enrollment
    const enrollmentsWithProgress = await Promise.all(
      enrollments.map(async (enrollment) => {
        const progress = await Progress.findOne({ enrollmentId: enrollment._id });
        return {
          ...enrollment.toObject(),
          progress: progress || null,
        };
      })
    );

    res.json(enrollmentsWithProgress);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/enrollments/:id
 * Get enrollment details
 */
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const enrollment = await Enrollment.findById(req.params.id)
      .populate('courseId')
      .populate('userId');

    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    // Check if user owns this enrollment
    if (enrollment.userId._id.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get progress
    const progress = await Progress.findOne({ enrollmentId: enrollment._id });

    res.json({
      ...enrollment.toObject(),
      progress: progress || null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/enrollments
 * Create enrollment (typically called from webhook)
 */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const {
      userId,
      shopifyOrderId,
      shopifyOrderNumber,
      shopifyProductId,
      orderData,
      expiresAt,
    } = req.body;

    if (!userId || !shopifyOrderId || !shopifyProductId) {
      return res.status(400).json({
        error: 'userId, shopifyOrderId, and shopifyProductId are required',
      });
    }

    // Find course by Shopify product ID
    const course = await Course.findOne({ shopifyProductId });
    if (!course) {
      return res.status(404).json({ error: 'Course not found for this product' });
    }

    // Check if enrollment already exists
    const existingEnrollment = await Enrollment.findOne({
      userId,
      shopifyOrderId,
      shopifyProductId,
    });

    if (existingEnrollment) {
      return res.json(existingEnrollment);
    }

    // Create enrollment
    const enrollment = await Enrollment.create({
      userId,
      courseId: course._id,
      shopifyOrderId,
      shopifyOrderNumber,
      shopifyProductId,
      orderData,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      status: 'active',
    });

    // Create initial progress record
    await Progress.create({
      enrollmentId: enrollment._id,
      courseId: course._id,
      userId,
      progress: 0,
      completed: false,
    });

    res.status(201).json(enrollment);
  } catch (error) {
    next(error);
  }
});

export default router;
