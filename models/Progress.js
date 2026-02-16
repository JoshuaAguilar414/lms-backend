import mongoose from 'mongoose';

const progressSchema = new mongoose.Schema(
  {
    enrollmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Enrollment',
      required: true,
      index: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Progress percentage (0-100)
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    // Completion status
    completed: {
      type: Boolean,
      default: false,
    },
    // Last accessed timestamp
    lastAccessedAt: {
      type: Date,
      default: Date.now,
    },
    // Time spent in minutes
    timeSpent: {
      type: Number,
      default: 0,
    },
    // SCORM-specific data
    scormData: {
      score: {
        type: Number,
        min: 0,
        max: 100,
      },
      maxScore: {
        type: Number,
      },
      minScore: {
        type: Number,
      },
      completionStatus: {
        type: String,
        enum: ['completed', 'incomplete', 'not attempted', 'unknown'],
      },
      successStatus: {
        type: String,
        enum: ['passed', 'failed', 'unknown'],
      },
      bookmarks: [
        {
          lessonId: String,
          timestamp: Number,
        },
      ],
      interactions: [
        {
          id: String,
          type: String,
          timestamp: Date,
          result: String,
          latency: Number,
        },
      ],
      // Store full SCORM data as JSON
      rawData: {
        type: mongoose.Schema.Types.Mixed,
      },
    },
    // Certificate data (if completed)
    certificate: {
      issuedAt: Date,
      certificateId: String,
      certificateUrl: String,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
progressSchema.index({ enrollmentId: 1 });
progressSchema.index({ userId: 1, courseId: 1 });
progressSchema.index({ completed: 1 });

const Progress = mongoose.model('Progress', progressSchema);

export default Progress;
