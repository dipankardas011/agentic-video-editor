const { execFile } = require('child_process');
const { writeFileSync, unlink } = require('fs');
const path = require('path');
const os = require('os');

function buildCodecArgs(format, quality, speed, filters) {
  if (format === 'gif') {
    const vf = filters.length ? filters.join(',') + ',' : '';
    return ['-vf', `${vf}fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, '-loop', '0'];
  }
  if (format === 'webm') {
    const args = ['-c:v', 'libvpx-vp9', '-crf', String(quality), '-b:v', '0', '-c:a', 'libopus'];
    if (filters.length) args.push('-vf', filters.join(','));
    if (speed !== 1) args.push('-af', `atempo=${Math.max(0.5, Math.min(2, speed))}`);
    return args;
  }
  // mp4
  const args = ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality), '-c:a', 'aac', '-b:a', '192k'];
  if (filters.length) args.push('-vf', filters.join(','));
  if (speed !== 1) args.push('-af', `atempo=${Math.max(0.5, Math.min(2, speed))}`);
  return args;
}

function renderItems(items, { format = 'mp4', resolution = 'original', quality = 23, speed = 1 } = {}) {
  const ext = format === 'gif' ? 'gif' : format === 'webm' ? 'webm' : 'mp4';
  const output = path.join(os.tmpdir(), `render_${Date.now()}.${ext}`);

  const filters = [];
  if (speed !== 1) filters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
  if (resolution !== 'original') {
    filters.push(`scale=${resolution}:force_original_aspect_ratio=decrease,pad=${resolution}:(ow-iw)/2:(oh-ih)/2:black`);
  }

  const canCopy = filters.length === 0 && format === 'mp4';
  const codec = canCopy ? ['-c', 'copy'] : buildCodecArgs(format, quality, speed, filters);

  return new Promise((resolve, reject) => {
    if (items.length === 1) {
      const { serverPath, start, end } = items[0];
      const args = ['-y', '-i', serverPath, '-ss', String(start), '-to', String(end), ...codec, output];
      execFile('ffmpeg', args, { timeout: 300000 }, (err, _, stderr) => {
        if (err) return reject(stderr || err.message);
        resolve({ output, ext });
      });
    } else {
      const lines = ['ffconcat version 1.0'];
      items.forEach(({ serverPath, start, end }) => {
        lines.push(`file '${serverPath}'`, `inpoint ${start}`, `outpoint ${end}`);
      });
      const concatFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
      writeFileSync(concatFile, lines.join('\n'));

      const args = ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, ...codec, output];
      execFile('ffmpeg', args, { timeout: 300000 }, (err, _, stderr) => {
        unlink(concatFile, () => {});
        if (err) return reject(stderr || err.message);
        resolve({ output, ext });
      });
    }
  });
}

module.exports = { buildCodecArgs, renderItems };
