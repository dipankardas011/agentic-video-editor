const { Router } = require('express');
const { unlink } = require('fs');
const { renderItems, renderTimeline, applyTextOverlays } = require('../lib/ffmpeg');

const router = Router();

// Active render jobs for progress tracking
const renderJobs = new Map();

// SSE endpoint for render progress
router.get('/progress/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const interval = setInterval(() => {
    const job = renderJobs.get(jobId);
    if (!job) { clearInterval(interval); res.end(); return; }
    res.write(`data: ${JSON.stringify({ progress: job.progress, status: job.status, error: job.error || null })}\n\n`);
    if (job.status === 'done' || job.status === 'error') {
      clearInterval(interval);
      res.end();
    }
  }, 250);

  req.on('close', () => clearInterval(interval));
});

// Start render and return job ID immediately
router.post('/', async (req, res) => {
  const { items, timeline, format, resolution, quality, speed, textOverlays } = req.body;
  if (!items?.length && !timeline?.length) return res.status(400).json({ error: 'No items' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  renderJobs.set(jobId, { progress: 0, status: 'rendering' });

  res.json({ jobId });

  try {
    let { output, ext } = timeline?.length
      ? await renderTimeline(timeline, { format, resolution, quality, speed }, (progress) => {
        const job = renderJobs.get(jobId);
        if (job) job.progress = textOverlays?.length ? progress * 0.9 : progress;
      })
      : await renderItems(items, { format, resolution, quality, speed }, (progress) => {
      const job = renderJobs.get(jobId);
      // If text overlays exist, reserve last 10% for that step
      if (job) job.progress = textOverlays?.length ? progress * 0.9 : progress;
    });

    // Apply text overlays as post-processing
    if (textOverlays?.length && format !== 'gif') {
      const job = renderJobs.get(jobId);
      if (job) job.progress = 0.9;
      output = await applyTextOverlays(output, ext, textOverlays);
      if (job) job.progress = 1;
    }

    const job = renderJobs.get(jobId);
    if (job) { job.status = 'done'; job.output = output; job.ext = ext; }
  } catch (err) {
    const errStr = String(err);
    // Print last 15 lines of ffmpeg stderr for the actual error
    const lines = errStr.split('\n').filter(l => l.trim());
    console.error('[render error]', lines.slice(-15).join('\n'));
    const job = renderJobs.get(jobId);
    if (job) { job.status = 'error'; job.error = String(err); }
  }
});

// Download completed render
router.get('/download/:jobId', (req, res) => {
  const job = renderJobs.get(req.params.jobId);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  const { output, ext } = job;
  res.download(output, `render.${ext}`, () => {
    unlink(output, () => {});
    renderJobs.delete(req.params.jobId);
  });
});

module.exports = router;
