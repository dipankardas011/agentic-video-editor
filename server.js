const express = require('express');
const path = require('path');
const { MEDIA_DIR, PORT } = require('./config');

// Ensure DB is initialized on startup
require('./db');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));
app.use('/media', express.static(MEDIA_DIR));

app.use('/upload',  require('./routes/upload'));
app.use('/project', require('./routes/projects'));
app.use('/clip',    require('./routes/clips'));
app.use('/render',   require('./routes/render'));
app.use('/subtitle', require('./routes/subtitle'));
app.use('/lut',      require('./routes/lut'));

app.listen(PORT, () => console.log(`VideoEditor → http://localhost:${PORT}`));
