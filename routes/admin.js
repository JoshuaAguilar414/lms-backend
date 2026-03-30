import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';
import unzipper from 'unzipper';
import Course from '../models/Course.js';
import User from '../models/User.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const uploadRoot = path.join(projectRoot, 'uploads');
const tmpRoot = path.join(uploadRoot, 'tmp');
const adminEmailDomain = (process.env.ADMIN_EMAIL_DOMAIN || 'vectra-intl.com').toLowerCase();

function toSafeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getPublicBaseUrl(req) {
  return (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function isAdminUser(req) {
  const userId = req.user?.userId;
  if (!userId) return false;
  const user = await User.findById(userId).select('email');
  const email = user?.email?.toLowerCase() ?? '';
  return email.endsWith(`@${adminEmailDomain}`);
}

async function requireAdmin(req, res) {
  const allowed = await isAdminUser(req);
  if (allowed) return true;
  res.status(403).json({ error: 'Admin access required' });
  return false;
}

function buildVersionDirName() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `v-${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await ensureDir(tmpRoot);
        cb(null, tmpRoot);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1 GB
  },
});

function normalizeZipEntryPath(entryPath) {
  return entryPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

async function extractZipSecure(zipPath, targetDir) {
  const directory = await unzipper.Open.file(zipPath);
  const extractedFiles = [];

  for (const entry of directory.files) {
    const normalized = normalizeZipEntryPath(entry.path);
    if (!normalized || normalized.includes('\0')) continue;

    const relative = path.posix.normalize(normalized);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Unsafe zip entry path: ${entry.path}`);
    }

    const outPath = path.join(targetDir, relative);
    if (!outPath.startsWith(targetDir)) {
      throw new Error(`Unsafe zip extraction target: ${entry.path}`);
    }

    if (entry.type === 'Directory') {
      await ensureDir(outPath);
      continue;
    }

    await ensureDir(path.dirname(outPath));
    await new Promise((resolve, reject) => {
      entry
        .stream()
        .pipe(fs.createWriteStream(outPath))
        .on('finish', resolve)
        .on('error', reject);
    });
    extractedFiles.push(relative);
  }

  return extractedFiles;
}

function inferLaunchPath(extractedFiles) {
  const lowerMap = new Map(extractedFiles.map((f) => [f.toLowerCase(), f]));
  if (lowerMap.has('index.html')) return lowerMap.get('index.html');

  const common = extractedFiles.find((f) => /\/index\.html$/i.test(f));
  if (common) return common;
  return null;
}

router.post('/scorm/upload', authenticate, upload.single('scormFile'), async (req, res, next) => {
  const tmpFilePath = req.file?.path;
  try {
    if (!(await requireAdmin(req, res))) return;

    const productIdRaw = req.body?.productId;
    const productTitleRaw = req.body?.productTitle;
    const uploaded = req.file;

    if (!productIdRaw || !productTitleRaw || !uploaded) {
      return res
        .status(400)
        .json({ error: 'productId, productTitle, and scormFile are required' });
    }

    const isZipByExt = path.extname(uploaded.originalname || '').toLowerCase() === '.zip';
    const isZipMime =
      uploaded.mimetype === 'application/zip' ||
      uploaded.mimetype === 'application/x-zip-compressed' ||
      uploaded.mimetype === 'multipart/x-zip';

    if (!isZipByExt && !isZipMime) {
      return res.status(400).json({ error: 'SCORM file must be a ZIP file' });
    }

    const productId = String(productIdRaw).trim();
    const productTitle = String(productTitleRaw).trim();
    const safeProductId = toSafeSegment(productId);
    if (!safeProductId) {
      return res.status(400).json({ error: 'Invalid productId' });
    }

    const versionDir = buildVersionDirName();
    const extractRoot = path.join(uploadRoot, 'scorm', safeProductId, versionDir);
    await ensureDir(extractRoot);

    const extractedFiles = await extractZipSecure(uploaded.path, extractRoot);
    const manifestRelative = extractedFiles.find(
      (f) => f.toLowerCase() === 'imsmanifest.xml' || f.toLowerCase().endsWith('/imsmanifest.xml')
    );
    if (!manifestRelative) {
      return res
        .status(400)
        .json({ error: 'Invalid SCORM package: imsmanifest.xml is missing' });
    }

    let launchRelative = inferLaunchPath(extractedFiles);
    if (!launchRelative) {
      const manifestDir = path.posix.dirname(manifestRelative);
      const nestedIndex =
        manifestDir === '.'
          ? null
          : extractedFiles.find((f) => f.toLowerCase() === `${manifestDir.toLowerCase()}/index.html`);
      if (nestedIndex) launchRelative = nestedIndex;
    }
    const base = getPublicBaseUrl(req);
    const scormBasePath = `/uploads/scorm/${encodeURIComponent(safeProductId)}/${encodeURIComponent(
      versionDir
    )}`;
    const scormUrl = launchRelative
      ? `${base}${scormBasePath}/${launchRelative.split('/').map(encodeURIComponent).join('/')}`
      : `${base}${scormBasePath}/index.html`;

    let course = await Course.findOne({ shopifyProductId: productId });
    if (course) {
      course.title = productTitle;
      course.scormUrl = scormUrl;
      course.lastSyncedAt = new Date();
      await course.save();
    } else {
      course = await Course.create({
        shopifyProductId: productId,
        title: productTitle,
        scormUrl,
      });
    }

    return res.json({
      message: 'SCORM package uploaded and extracted successfully',
      productId,
      productTitle,
      scormUrl,
      manifestUrl: `${base}${scormBasePath}/${manifestRelative
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
      extractedFileCount: extractedFiles.length,
    });
  } catch (error) {
    return next(error);
  } finally {
    if (tmpFilePath) {
      await fsp.unlink(tmpFilePath).catch(() => {});
    }
  }
});

router.post('/logo/upload', authenticate, upload.single('logo'), async (req, res, next) => {
  const tmpFilePath = req.file?.path;
  try {
    if (!(await requireAdmin(req, res))) return;

    const uploaded = req.file;
    if (!uploaded) {
      return res.status(400).json({ error: 'logo is required' });
    }

    const allowed = new Set([
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/svg+xml',
      'image/webp',
      'image/gif',
    ]);
    if (!allowed.has(uploaded.mimetype)) {
      return res.status(400).json({ error: 'Invalid logo type' });
    }

    const logosDir = path.join(uploadRoot, 'logos');
    await ensureDir(logosDir);
    const ext = path.extname(uploaded.originalname || '').toLowerCase() || '.png';
    const safeExt = ext.replace(/[^a-z0-9.]/gi, '') || '.png';
    const fileName = `logo-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${safeExt}`;
    const finalPath = path.join(logosDir, fileName);
    await fsp.rename(uploaded.path, finalPath);

    const logoUrl = `${getPublicBaseUrl(req)}/uploads/logos/${encodeURIComponent(fileName)}`;
    return res.json({
      message: 'Logo uploaded successfully',
      logoUrl,
    });
  } catch (error) {
    return next(error);
  } finally {
    if (tmpFilePath) {
      await fsp.unlink(tmpFilePath).catch(() => {});
    }
  }
});

export default router;
