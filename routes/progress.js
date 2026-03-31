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

    const normalizedProgress =
      progressValue === undefined || progressValue === null
        ? undefined
        : Math.max(0, Math.min(100, Number(progressValue) || 0));
    const completionRequested = Boolean(completed) || normalizedProgress === 100;

    // Find or create progress
    let progress = await Progress.findOne({ enrollmentId });

    if (progress) {
      const wasCompleted = Boolean(progress.completed);
      // Update existing progress
      if (normalizedProgress !== undefined) {
        // Keep the highest progress to avoid regressions from out-of-order SCORM events.
        progress.progress = Math.max(progress.progress || 0, normalizedProgress);
      }
      if (completed !== undefined || normalizedProgress !== undefined) {
        progress.completed = progress.completed || completionRequested || (progress.progress || 0) >= 100;
      }
      if (timeSpent !== undefined) progress.timeSpent = (progress.timeSpent || 0) + timeSpent;
      if (scormData) progress.scormData = { ...progress.scormData, ...scormData };
      progress.lastAccessedAt = new Date();

      // Update completion date if completed
      if (progress.completed && !wasCompleted) {
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
        progress: normalizedProgress || 0,
        completed: completionRequested,
        timeSpent: timeSpent || 0,
        scormData: scormData || {},
        lastAccessedAt: new Date(),
      });

      if (progress.completed) {
        enrollment.status = 'completed';
        enrollment.completedAt = new Date();
        await enrollment.save();
      }
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
