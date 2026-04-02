const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const { mkdirSync } = require('fs');
const { MEDIA_DIR } = require('../config');

const LUTS_DIR = path.join(MEDIA_DIR, 'luts');
mkdirSync(LUTS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: LUTS_DIR,
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.cube')) cb(null, true);
    else cb(new Error('Only .cube files accepted'));
  }
});

const router = Router();
const lutStore = []; // in-memory: [{id, name, serverPath}]

router.get('/', (req, res) => res.json(lutStore));

router.post('/', upload.single('cube'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No .cube file uploaded' });
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: path.basename(req.file.originalname, '.cube'),
    serverPath: req.file.path
  };
  lutStore.push(entry);
  console.log(`[lut] loaded: ${entry.name}`);
  res.json(entry);
});

module.exports = router;
