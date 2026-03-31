const path = require('path');
const { mkdirSync } = require('fs');

const MEDIA_DIR = path.join(__dirname, 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

const PORT = 3000;

module.exports = { MEDIA_DIR, PORT };
