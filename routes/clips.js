const { Router } = require('express');
const db = require('../db');

const router = Router();

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Clip not found' });
  res.json(row);
});

module.exports = router;
