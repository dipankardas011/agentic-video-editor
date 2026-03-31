const { execFile } = require('child_process');
const { writeFileSync, unlink, unlinkSync } = require('fs');
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

function buildAudioFilters(item) {
  const af = [];
  if (item.volume !== undefined && item.volume !== 1) af.push(`volume=${item.volume}`);
  if (item.fadeIn)  af.push(`afade=t=in:d=${item.fadeIn}`);
  if (item.fadeOut) {
    const dur = item.end - item.start;
    af.push(`afade=t=out:st=${Math.max(0, dur - item.fadeOut)}:d=${item.fadeOut}`);
  }
  return af;
}

function buildVideoFadeFilters(item) {
  const vf = [];
  if (item.fadeIn)  vf.push(`fade=t=in:d=${item.fadeIn}`);
  if (item.fadeOut) {
    const dur = item.end - item.start;
    vf.push(`fade=t=out:st=${Math.max(0, dur - item.fadeOut)}:d=${item.fadeOut}`);
  }
  return vf;
}

function ffrun(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stderr);
    });
  });
}

// Encode a single item to a temp file with all its filters
async function encodeItem(item, idx, { format, quality, speed, filters }) {
  const ext = format === 'webm' ? 'webm' : 'mp4';
  const tmp = path.join(os.tmpdir(), `seg_${Date.now()}_${idx}.${ext}`);
  const { serverPath, start, end } = item;

  const args = ['-y', '-ss', String(start), '-i', serverPath, '-to', String(end - start)];

  // Video filters (global + per-item fade)
  const vf = [...filters, ...buildVideoFadeFilters(item)];
  if (vf.length) args.push('-vf', vf.join(','));

  // Audio filters (per-item: volume, fade)
  const af = buildAudioFilters(item);
  if (speed !== 1) af.push(`atempo=${Math.max(0.5, Math.min(2, speed))}`);
  if (af.length) args.push('-af', af.join(','));

  // Codec
  if (format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-crf', String(quality), '-b:v', '0', '-c:a', 'libopus');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality), '-c:a', 'aac', '-b:a', '192k');
  }

  args.push(tmp);
  await ffrun(args);
  return tmp;
}

async function renderItems(items, { format = 'mp4', resolution = 'original', quality = 23, speed = 1 } = {}) {
  const ext = format === 'gif' ? 'gif' : format === 'webm' ? 'webm' : 'mp4';
  const output = path.join(os.tmpdir(), `render_${Date.now()}.${ext}`);

  const filters = [];
  if (speed !== 1) filters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
  if (resolution !== 'original') {
    filters.push(`scale=${resolution}:force_original_aspect_ratio=decrease,pad=${resolution}:(ow-iw)/2:(oh-ih)/2:black`);
  }

  const needsAudioProc = items.some(i =>
    (i.volume !== undefined && i.volume !== 1) || i.fadeIn || i.fadeOut
  );
  const canCopy = filters.length === 0 && format === 'mp4' && !needsAudioProc && speed === 1;

  // ── Single item — simple direct encode ──────────────────────────────
  if (items.length === 1) {
    const item = items[0];
    if (canCopy) {
      // Stream copy — fastest
      await ffrun(['-y', '-i', item.serverPath, '-ss', String(item.start), '-to', String(item.end), '-c', 'copy', output]);
    } else if (format === 'gif') {
      const codec = buildCodecArgs('gif', quality, speed, filters);
      await ffrun(['-y', '-ss', String(item.start), '-i', item.serverPath, '-to', String(item.end - item.start), ...codec, output]);
    } else {
      const tmp = await encodeItem(item, 0, { format, quality, speed, filters });
      // Just rename tmp to output
      const { renameSync } = require('fs');
      renameSync(tmp, output);
    }
    return { output, ext };
  }

  // ── Multiple items — encode each, then concat with stream copy ──────
  if (format === 'gif') {
    // GIF: encode first to a single mp4, then convert to gif
    const tmpFiles = [];
    for (let i = 0; i < items.length; i++) {
      tmpFiles.push(await encodeItem(items[i], i, { format: 'mp4', quality, speed, filters }));
    }
    // Concat the mp4s
    const concatFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    writeFileSync(concatFile, tmpFiles.map(f => `file '${f}'`).join('\n'));
    const tmpMp4 = path.join(os.tmpdir(), `merged_${Date.now()}.mp4`);
    await ffrun(['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', tmpMp4]);
    unlink(concatFile, () => {});
    tmpFiles.forEach(f => unlink(f, () => {}));
    // Convert to gif
    const gifCodec = buildCodecArgs('gif', quality, 1, []);
    await ffrun(['-y', '-i', tmpMp4, ...gifCodec, output]);
    unlink(tmpMp4, () => {});
    return { output, ext };
  }

  if (canCopy) {
    // All items can be stream-copied — use concat demuxer directly
    const concatFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    const lines = items.map(({ serverPath, start, end }) =>
      `file '${serverPath}'\ninpoint ${start}\noutpoint ${end}`
    );
    writeFileSync(concatFile, 'ffconcat version 1.0\n' + lines.join('\n'));
    await ffrun(['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', output]);
    unlink(concatFile, () => {});
    return { output, ext };
  }

  // Encode each segment individually (handles different sources, per-item filters)
  const tmpFiles = [];
  for (let i = 0; i < items.length; i++) {
    tmpFiles.push(await encodeItem(items[i], i, { format, quality, speed, filters }));
  }

  // Concat encoded files with stream copy (they all have identical codec params now)
  const concatFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
  writeFileSync(concatFile, tmpFiles.map(f => `file '${f}'`).join('\n'));
  await ffrun(['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', output]);

  // Cleanup
  unlink(concatFile, () => {});
  tmpFiles.forEach(f => unlink(f, () => {}));

  return { output, ext };
}

module.exports = { buildCodecArgs, renderItems };
