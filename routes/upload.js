const { Router } = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { copyFileSync, unlink } = require('fs');
const os = require('os');
const db = require('../db');
const { MEDIA_DIR } = require('../config');

const router = Router();
const upload = multer({ dest: os.tmpdir() });

router.post('/', upload.single('video'), (req, res) => {
  const file = req.file;
  const clipId = req.body.clipId || crypto.randomUUID();
  const ext = path.extname(file.originalname) || '.mp4';
  const dest = path.join(MEDIA_DIR, clipId + ext);

  copyFileSync(file.path, dest);
  unlink(file.path, () => {});

  db.prepare('INSERT OR REPLACE INTO clips (id, name, file_path) VALUES (?, ?, ?)')
    .run(clipId, file.originalname, dest);

  res.json({ serverPath: dest, mediaUrl: `/media/${clipId}${ext}`, clipId });
});

module.exports = router;
