const express = require('express');
const multer  = require('multer');
const { execFile } = require('child_process');
const { unlink }   = require('fs');
const path = require('path');
const os   = require('os');

const app    = express();
const upload = multer({ dest: os.tmpdir() });

app.use(express.json());
app.use(express.static(__dirname));

// Save uploaded video to tmp dir, return its server-side path
app.post('/upload', upload.single('video'), (req, res) => {
  res.json({ serverPath: req.file.path });
});

// Trim with ffmpeg (stream copy = fast, no re-encode) and send back
app.post('/render', (req, res) => {
  const { serverPath, start, end } = req.body;
  const output = path.join(os.tmpdir(), `render_${Date.now()}.mp4`);

  execFile('ffmpeg', [
    '-y',
    '-i', serverPath,
    '-ss', String(start),
    '-to', String(end),
    '-c', 'copy',
    output
  ], (err, _stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr });
    res.download(output, 'render.mp4', () => unlink(output, () => {}));
  });
});

app.listen(3000, () => console.log('VideoEditor → http://localhost:3000'));
