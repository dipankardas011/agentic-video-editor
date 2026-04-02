const { Router } = require('express');
const { spawn } = require('child_process');
const { existsSync, readFileSync, mkdirSync } = require('fs');
const path = require('path');
const os = require('os');

const router = Router();
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'turbo';

router.post('/', (req, res) => {
  const { clipPath } = req.body;
  if (!clipPath || !existsSync(clipPath)) {
    return res.status(400).json({ error: 'Invalid clip path' });
  }

  const outDir = path.join(os.tmpdir(), 'whisper_' + Date.now());
  mkdirSync(outDir, { recursive: true });

  console.log(`[subtitle] model=${WHISPER_MODEL} file=${clipPath}`);

  const proc = spawn('whisper', [
    clipPath,
    '--model', WHISPER_MODEL,
    '--output_format', 'srt',
    '--output_dir', outDir
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });

  proc.on('error', err => {
    console.error('[subtitle error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'whisper not found: ' + err.message });
  });

  proc.on('close', code => {
    if (code !== 0) {
      console.error('[subtitle error] exit', code, stderr.slice(-500));
      return res.status(500).json({ error: `whisper exited ${code}` });
    }
    // Whisper names output after the input file basename
    const base = path.basename(clipPath, path.extname(clipPath));
    const srtPath = path.join(outDir, base + '.srt');
    if (!existsSync(srtPath)) {
      return res.status(500).json({ error: 'SRT not generated' });
    }
    const srt = readFileSync(srtPath, 'utf8');
    console.log(`[subtitle] done, ${srt.split('\n\n').length - 1} entries`);
    res.json({ srt });
  });
});

module.exports = router;
