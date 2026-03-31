const { Router } = require('express');
const { unlink } = require('fs');
const { renderItems } = require('../lib/ffmpeg');

const router = Router();

router.post('/', async (req, res) => {
  const { items, format, resolution, quality, speed } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'No items' });

  try {
    const { output, ext } = await renderItems(items, { format, resolution, quality, speed });
    res.download(output, `render.${ext}`, () => unlink(output, () => {}));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

module.exports = router;
