const { Router } = require('express');
const db = require('../db');

const router = Router();

router.post('/save', (req, res) => {
  const { id, name, data } = req.body;
  if (!id || !data) return res.status(400).json({ error: 'Missing id or data' });
  db.prepare('INSERT OR REPLACE INTO projects (id, name, data, updated_at) VALUES (?, ?, ?, datetime(\'now\'))')
    .run(id, name || 'Untitled', JSON.stringify(data));
  res.json({ ok: true });
});

router.get('/load/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json({ id: row.id, name: row.name, data: JSON.parse(row.data), updated_at: row.updated_at });
});

router.get('/list', (req, res) => {
  const rows = db.prepare('SELECT id, name, updated_at FROM projects ORDER BY updated_at DESC').all();
  res.json(rows);
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
