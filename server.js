const express = require('express');
const multer  = require('multer');
const { execFile } = require('child_process');
const { writeFileSync, unlink } = require('fs');
const path = require('path');
const os   = require('os');

const app    = express();
const upload = multer({ dest: os.tmpdir() });

app.use(express.json());
app.use(express.static(__dirname));

app.post('/upload', upload.single('video'), (req, res) => {
  res.json({ serverPath: req.file.path });
});

app.post('/render', (req, res) => {
  const { items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'No items' });

  const output = path.join(os.tmpdir(), `render_${Date.now()}.mp4`);

  if (items.length === 1) {
    // Single clip — fast stream copy
    const { serverPath, start, end } = items[0];
    execFile('ffmpeg', ['-y', '-i', serverPath, '-ss', String(start), '-to', String(end), '-c', 'copy', output],
      (err, _, stderr) => {
        if (err) return res.status(500).json({ error: stderr });
        res.download(output, 'render.mp4', () => unlink(output, () => {}));
      });
  } else {
    // Multiple clips — concat demuxer (stream copy, fast)
    const lines = ['ffconcat version 1.0'];
    items.forEach(({ serverPath, start, end }) => {
      lines.push(`file '${serverPath}'`, `inpoint ${start}`, `outpoint ${end}`);
    });
    const concatFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    writeFileSync(concatFile, lines.join('\n'));

    execFile('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', output],
      (err, _, stderr) => {
        unlink(concatFile, () => {});
        if (err) return res.status(500).json({ error: stderr });
        res.download(output, 'render.mp4', () => unlink(output, () => {}));
      });
  }
});

app.listen(3000, () => console.log('VideoEditor → http://localhost:3000'));
