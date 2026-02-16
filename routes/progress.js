import express from 'express';
import Progress from '../models/Progress.js';
import Enrollment from '../models/Enrollment.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/progress/:enrollmentId
 * Get progress for an enrollment
 */
router.get('/:enrollmentId', authenticate, async (req, res, next) => {
  try {
    const enrollment = await Enrollment.findById(req.params.enrollmentId);

    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    // Check if user owns this enrollment
    if (enrollment.userId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const progress = await Progress.findOne({ enrollmentId: req.params.enrollmentId });

    if (!progress) {
      return res.status(404).json({ error: 'Progress not found' });
    }

    res.json(progress);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/progress
 * Update course progress (called from SCORM player)
 */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const {
      enrollmentId,
      progress: progressValue,
      completed,
      timeSpent,
      scormData,
    } = req.body;

    if (!enrollmentId) {
      return res.status(400).json({ error: 'enrollmentId is required' });
    }

    // Verify enrollment ownership
    const enrollment = await Enrollment.findById(enrollmentId);
    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    if (enrollment.userId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Find or create progress
    let progress = await Progress.findOne({ enrollmentId });

    if (progress) {
      // Update existing progress
      if (progressValue !== undefined) progress.progress = progressValue;
      if (completed !== undefined) progress.completed = completed;
      if (timeSpent !== undefined) progress.timeSpent = (progress.timeSpent || 0) + timeSpent;
      if (scormData) progress.scormData = { ...progress.scormData, ...scormData };
      progress.lastAccessedAt = new Date();

      // Update completion date if completed
      if (completed && !progress.completed) {
        progress.completed = true;
        // Update enrollment status
        enrollment.status = 'completed';
        enrollment.completedAt = new Date();
        await enrollment.save();
      }

      await progress.save();
    } else {
      // Create new progress
      progress = await Progress.create({
        enrollmentId,
        courseId: enrollment.courseId,
        userId: enrollment.userId,
        progress: progressValue || 0,
        completed: completed || false,
        timeSpent: timeSpent || 0,
        scormData: scormData || {},
        lastAccessedAt: new Date(),
      });
    }

    res.json(progress);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/progress/:enrollmentId
 * Update progress (alternative endpoint)
 */
router.put('/:enrollmentId', authenticate, async (req, res, next) => {
  try {
    const enrollment = await Enrollment.findById(req.params.enrollmentId);

    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    if (enrollment.userId.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const progress = await Progress.findOneAndUpdate(
      { enrollmentId: req.params.enrollmentId },
      {
        ...req.body,
        lastAccessedAt: new Date(),
      },
      { new: true, upsert: true }
    );

    res.json(progress);
  } catch (error) {
    next(error);
  }
});

export default router;
