const { spawn } = require('child_process');
const { writeFileSync, unlink, renameSync } = require('fs');
const path = require('path');
const os = require('os');

const EXPORT_RESOLUTIONS = {
  '4k': '3840:2160',
  '2k': '2560:1440',
  'fhd': '1920:1080',
  '720p': '1280:720'
};

function resolveExportResolution(resolution) {
  return EXPORT_RESOLUTIONS[resolution] || EXPORT_RESOLUTIONS.fhd;
}

function buildAtempoFilters(speed) {
  const af = [];
  let s = speed;
  while (s > 2) { af.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { af.push('atempo=0.5'); s *= 2; }
  af.push(`atempo=${Math.max(0.5, Math.min(2, s)).toFixed(4)}`);
  return af;
}

function ffnum(value) {
  return Number(value || 0).toFixed(3);
}

function escapeFilterText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function probeMedia(serverPath) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-i', serverPath, '-f', 'null', '-']);
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('close', () => {
      resolve({
        hasVideo: /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]+\))?: Video:/m.test(stderr),
        hasAudio: /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]+\))?: Audio:/m.test(stderr)
      });
    });
    proc.on('error', () => resolve({ hasVideo: false, hasAudio: false }));
  });
}

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

function buildOutputVideoFilters({ format, filters, item, itemSpeed }) {
  const vf = [...filters, ...buildVideoFadeFilters(item)];
  if (itemSpeed !== 1) vf.push(`setpts=${(1 / itemSpeed).toFixed(4)}*PTS`);
  if (format === 'mp4') vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  return vf;
}

function ffrun(args, onProgress, totalDuration) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { timeout: 300000 });
    let stderr = '';
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (onProgress && totalDuration) {
        // Parse "time=HH:MM:SS.xx" from FFmpeg output
        const m = chunk.toString().match(/time=(\d+):(\d+):(\d+\.?\d*)/);
        if (m) {
          const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
          onProgress(Math.min(1, secs / totalDuration));
        }
      }
    });
    proc.on('close', code => {
      if (code !== 0) return reject(stderr || `ffmpeg exited with code ${code}`);
      resolve(stderr);
    });
    proc.on('error', err => reject(err.message));
  });
}

// Encode a single item to a temp file with all its filters
async function encodeItem(item, idx, { format, quality, speed, filters }, onProgress) {
  const ext = format === 'webm' ? 'webm' : 'mp4';
  const tmp = path.join(os.tmpdir(), `seg_${Date.now()}_${idx}.${ext}`);
  const { serverPath, start, end } = item;
  const itemSpeed = (item.speed || 1) * speed;

  const isImg = item.isImage;
  const imgDur = isImg ? (end - start) / (itemSpeed || 1) : 0;
  const args = ['-y'];
  if (isImg) {
    // Input 0: image looped as video
    args.push('-loop', '1', '-framerate', '25', '-i', serverPath);
    // Input 1: silent audio
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    // Explicit mapping: video from image, audio from anullsrc
    args.push('-map', '0:v', '-map', '1:a');
    args.push('-pix_fmt', 'yuv420p');
    // Video filters
    const vf = buildOutputVideoFilters({ format, filters, item, itemSpeed: 1 });
    if (vf.length) args.push('-vf', vf.join(','));
    // Codec
    if (format === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-crf', String(quality), '-b:v', '0', '-c:a', 'libopus');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality), '-c:a', 'aac', '-b:a', '192k');
    }
    // Duration as output option (must be after codec args)
    args.push('-t', String(imgDur));
  } else {
    args.push('-ss', String(start), '-i', serverPath, '-to', String(end - start));

    // Video filters (global + per-item fade + per-item speed)
    const vf = buildOutputVideoFilters({ format, filters, item, itemSpeed });
    if (vf.length) args.push('-vf', vf.join(','));

    // Audio filters (per-item: volume, fade, speed)
    const af = buildAudioFilters(item);
    if (itemSpeed !== 1) {
      let s = itemSpeed;
      while (s > 2) { af.push('atempo=2.0'); s /= 2; }
      while (s < 0.5) { af.push('atempo=0.5'); s *= 2; }
      af.push(`atempo=${Math.max(0.5, Math.min(2, s)).toFixed(4)}`);
    }
    if (af.length) args.push('-af', af.join(','));

    // Codec
    if (format === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-crf', String(quality), '-b:v', '0', '-c:a', 'libopus');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality), '-c:a', 'aac', '-b:a', '192k');
    }
  }

  const itemDur = (end - start) / itemSpeed;
  args.push(tmp);
  console.log('[ffmpeg]', args.join(' '));
  await ffrun(args, onProgress, itemDur);
  return tmp;
}

function buildTimelineEntries(segments, globalSpeed) {
  const byTrack = new Map();
  for (const segment of segments) {
    if (!byTrack.has(segment.trackId)) byTrack.set(segment.trackId, []);
    byTrack.get(segment.trackId).push({ ...segment });
  }

  const entries = [];
  for (const trackSegments of byTrack.values()) {
    trackSegments.sort((a, b) => a.startTime - b.startTime || a.trackIndex - b.trackIndex);
    let cumulativeTransition = 0;
    for (let i = 0; i < trackSegments.length; i++) {
      const seg = trackSegments[i];
      const transitionIn = i > 0 ? (seg.transition || 0) : 0;
      cumulativeTransition += transitionIn;

      const rawDuration = Math.max(0.01, seg.end - seg.start);
      const combinedSpeed = (seg.speed || 1) * globalSpeed;
      const outputDuration = rawDuration / combinedSpeed;
      const effectiveStart = Math.max(0, (seg.startTime - cumulativeTransition) / globalSpeed);
      const fadeIn = (seg.fadeIn || 0) / combinedSpeed;
      const fadeOut = (seg.fadeOut || 0) / combinedSpeed;

      entries.push({
        ...seg,
        rawDuration,
        combinedSpeed,
        outputDuration,
        effectiveStart,
        fadeIn,
        fadeOut,
        transitionIn: transitionIn / globalSpeed,
        transitionOut: 0
      });
    }
  }

  const byTrackId = new Map();
  for (const entry of entries) {
    if (!byTrackId.has(entry.trackId)) byTrackId.set(entry.trackId, []);
    byTrackId.get(entry.trackId).push(entry);
  }
  for (const trackEntries of byTrackId.values()) {
    trackEntries.sort((a, b) => a.effectiveStart - b.effectiveStart);
    for (let i = 0; i < trackEntries.length - 1; i++) {
      trackEntries[i].transitionOut = trackEntries[i + 1].transitionIn;
    }
  }

  return entries;
}

async function renderTimeline(segments, { format = 'mp4', resolution = 'fhd', quality = 23, speed = 1 } = {}, onProgress) {
  const ext = format === 'gif' ? 'gif' : format === 'webm' ? 'webm' : 'mp4';
  const timelineExt = format === 'gif' ? 'mp4' : ext;
  const output = path.join(os.tmpdir(), `timeline_${Date.now()}.${ext}`);
  const timelineOutput = format === 'gif' ? path.join(os.tmpdir(), `timeline_${Date.now()}.mp4`) : output;
  const targetResolution = resolveExportResolution(resolution);
  const targetSize = targetResolution.replace(':', 'x');
  const timelineEntries = buildTimelineEntries(segments, speed);

  const totalDuration = Math.max(
    0.1,
    ...timelineEntries.map(entry => entry.effectiveStart + entry.outputDuration)
  );

  const args = [
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${targetSize}:r=30:d=${ffnum(totalDuration)}`,
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
    '-t', ffnum(totalDuration)
  ];

  timelineEntries.forEach((entry) => {
    if (entry.isImage) {
      args.push('-loop', '1', '-framerate', '30', '-t', ffnum(entry.rawDuration), '-i', entry.serverPath);
      return;
    }
    args.push('-ss', ffnum(entry.start), '-t', ffnum(entry.rawDuration), '-i', entry.serverPath);
  });

  const mediaByPath = new Map();
  await Promise.all(
    [...new Set(timelineEntries.filter(entry => !entry.isImage).map(entry => entry.serverPath))]
      .map(async (serverPath) => mediaByPath.set(serverPath, await probeMedia(serverPath)))
  );

  const filterParts = [];
  let videoBase = '[0:v]';
  let audioLabels = [];
  let videoCount = 0;

  timelineEntries.forEach((entry, idx) => {
    const inputIndex = idx + 2;
    const mediaInfo = entry.isImage ? { hasVideo: true, hasAudio: false } : (mediaByPath.get(entry.serverPath) || { hasVideo: false, hasAudio: false });

    if (entry.trackType === 'video' && mediaInfo.hasVideo) {
      const videoFilters = [
        `scale=${targetResolution}:force_original_aspect_ratio=decrease`,
        `pad=${targetResolution}:(ow-iw)/2:(oh-ih)/2:black`,
        'setsar=1',
        'format=rgba'
      ];
      if (entry.combinedSpeed !== 1) videoFilters.push(`setpts=${(1 / entry.combinedSpeed).toFixed(4)}*PTS`);
      if (entry.fadeIn > 0) videoFilters.push(`fade=t=in:st=0:d=${ffnum(entry.fadeIn)}:alpha=1`);
      if (entry.transitionIn > 0) videoFilters.push(`fade=t=in:st=0:d=${ffnum(entry.transitionIn)}:alpha=1`);
      if (entry.fadeOut > 0) videoFilters.push(`fade=t=out:st=${ffnum(Math.max(0, entry.outputDuration - entry.fadeOut))}:d=${ffnum(entry.fadeOut)}:alpha=1`);
      if (entry.transitionOut > 0) videoFilters.push(`fade=t=out:st=${ffnum(Math.max(0, entry.outputDuration - entry.transitionOut))}:d=${ffnum(entry.transitionOut)}:alpha=1`);
      videoFilters.push(`trim=duration=${ffnum(entry.outputDuration)}`);
      videoFilters.push(`setpts=PTS-STARTPTS+${ffnum(entry.effectiveStart)}/TB`);
      const vLabel = `[v${idx}]`;
      filterParts.push(`[${inputIndex}:v]${videoFilters.join(',')}${vLabel}`);

      const overlaid = `[vtmp${videoCount++}]`;
      filterParts.push(`${videoBase}${vLabel}overlay=eof_action=pass:shortest=0${overlaid}`);
      videoBase = overlaid;
    }

    if (!mediaInfo.hasAudio || entry.volume === 0) return;

    const audioFilters = [];
    if (entry.combinedSpeed !== 1) audioFilters.push(...buildAtempoFilters(entry.combinedSpeed));
    if (entry.volume !== undefined && entry.volume !== 1) audioFilters.push(`volume=${entry.volume}`);
    if (entry.fadeIn > 0) audioFilters.push(`afade=t=in:st=0:d=${ffnum(entry.fadeIn)}`);
    if (entry.transitionIn > 0) audioFilters.push(`afade=t=in:st=0:d=${ffnum(entry.transitionIn)}`);
    if (entry.fadeOut > 0) audioFilters.push(`afade=t=out:st=${ffnum(Math.max(0, entry.outputDuration - entry.fadeOut))}:d=${ffnum(entry.fadeOut)}`);
    if (entry.transitionOut > 0) audioFilters.push(`afade=t=out:st=${ffnum(Math.max(0, entry.outputDuration - entry.transitionOut))}:d=${ffnum(entry.transitionOut)}`);
    audioFilters.push(`atrim=duration=${ffnum(entry.outputDuration)}`);
    audioFilters.push(`adelay=${Math.max(0, Math.round(entry.effectiveStart * 1000))}:all=1`);
    const aLabel = `[a${idx}]`;
    filterParts.push(`[${inputIndex}:a]${audioFilters.join(',')}${aLabel}`);
    audioLabels.push(aLabel);
  });

  filterParts.push(`${videoBase}format=${timelineExt === 'webm' ? 'yuva420p' : 'yuv420p'}[vout]`);

  if (audioLabels.length) {
    filterParts.push(`[1:a]atrim=duration=${ffnum(totalDuration)}[asilent]`);
    audioLabels = ['[asilent]', ...audioLabels];
    filterParts.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`);
  } else {
    filterParts.push(`[1:a]atrim=duration=${ffnum(totalDuration)}[aout]`);
  }

  args.push('-filter_complex', filterParts.join(';'), '-map', '[vout]', '-map', '[aout]');
  if (timelineExt === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-crf', String(quality), '-b:v', '0', '-c:a', 'libopus');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k');
  }
  args.push('-t', ffnum(totalDuration), timelineOutput);

  console.log('[ffmpeg timeline]', args.join(' '));
  await ffrun(args, onProgress, totalDuration);
  if (format !== 'gif') return { output, ext };

  const gifCodec = buildCodecArgs('gif', quality, 1, []);
  await ffrun(['-y', '-i', timelineOutput, ...gifCodec, output], null, totalDuration);
  unlink(timelineOutput, () => {});
  return { output, ext };
}

async function renderItems(items, { format = 'mp4', resolution = 'fhd', quality = 23, speed = 1 } = {}, onProgress) {
  const ext = format === 'gif' ? 'gif' : format === 'webm' ? 'webm' : 'mp4';
  const output = path.join(os.tmpdir(), `render_${Date.now()}.${ext}`);
  const targetResolution = resolveExportResolution(resolution);

  const filters = [];
  if (speed !== 1) filters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
  filters.push(`scale=${targetResolution}:force_original_aspect_ratio=decrease,pad=${targetResolution}:(ow-iw)/2:(oh-ih)/2:black`);

  const needsAudioProc = items.some(i =>
    (i.volume !== undefined && i.volume !== 1) || i.fadeIn || i.fadeOut
  );
  const hasItemSpeed = items.some(i => i.speed && i.speed !== 1);
  const hasXfade = items.some((item, i) => i > 0 && item.transition > 0);
  const hasImages = items.some(i => i.isImage);
  const canCopy = filters.length === 0 && format === 'mp4' && !needsAudioProc && speed === 1 && !hasItemSpeed && !hasXfade && !hasImages;

  // Total output duration for progress calculation
  const totalOutDur = items.reduce((sum, i) => sum + (i.end - i.start) / ((i.speed || 1) * speed), 0);

  // Helper: progress scaler for multi-step renders
  let progressOffset = 0;
  const scaledProgress = (stepWeight) => (p) => {
    if (onProgress) onProgress(Math.min(1, progressOffset + p * stepWeight));
  };

  // ── Single item — simple direct encode ──────────────────────────────
  if (items.length === 1) {
    const item = items[0];
    if (canCopy) {
      await ffrun(['-y', '-i', item.serverPath, '-ss', String(item.start), '-to', String(item.end), '-c', 'copy', output], scaledProgress(1), totalOutDur);
    } else if (format === 'gif') {
      const codec = buildCodecArgs('gif', quality, speed, filters);
      await ffrun(['-y', '-ss', String(item.start), '-i', item.serverPath, '-to', String(item.end - item.start), ...codec, output], scaledProgress(1), totalOutDur);
    } else {
      const tmp = await encodeItem(item, 0, { format, quality, speed, filters }, scaledProgress(1));
      renameSync(tmp, output);
    }
    if (onProgress) onProgress(1);
    return { output, ext };
  }

  // ── Multiple items — encode each, then concat with stream copy ──────
  const encodeWeight = 0.9; // 90% for encoding, 10% for concat
  const perItemWeight = encodeWeight / items.length;

  if (format === 'gif') {
    const tmpFiles = [];
    for (let i = 0; i < items.length; i++) {
      tmpFiles.push(await encodeItem(items[i], i, { format: 'mp4', quality, speed, filters }, scaledProgress(perItemWeight)));
      progressOffset += perItemWeight;
    }
    const concatFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    writeFileSync(concatFile, tmpFiles.map(f => `file '${f}'`).join('\n'));
    const tmpMp4 = path.join(os.tmpdir(), `merged_${Date.now()}.mp4`);
    await ffrun(['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', tmpMp4]);
    unlink(concatFile, () => {});
    tmpFiles.forEach(f => unlink(f, () => {}));
    if (onProgress) onProgress(0.95);
    const gifCodec = buildCodecArgs('gif', quality, 1, []);
    await ffrun(['-y', '-i', tmpMp4, ...gifCodec, output], scaledProgress(0.05), totalOutDur);
    unlink(tmpMp4, () => {});
    if (onProgress) onProgress(1);
    return { output, ext };
  }

  if (canCopy) {
    const concatFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    const lines = items.map(({ serverPath, start, end }) =>
      `file '${serverPath}'\ninpoint ${start}\noutpoint ${end}`
    );
    writeFileSync(concatFile, 'ffconcat version 1.0\n' + lines.join('\n'));
    await ffrun(['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', output], scaledProgress(1), totalOutDur);
    unlink(concatFile, () => {});
    if (onProgress) onProgress(1);
    return { output, ext };
  }

  // Encode each segment individually
  const tmpFiles = [];
  for (let i = 0; i < items.length; i++) {
    tmpFiles.push(await encodeItem(items[i], i, { format, quality, speed, filters }, scaledProgress(perItemWeight)));
    progressOffset += perItemWeight;
  }

  // Check for crossfade transitions (hasXfade already computed above)
  if (hasXfade && tmpFiles.length >= 2) {
    // Use xfade filter for transitions
    const xfadeOutput = await renderWithXfade(tmpFiles, items, { format, quality }, scaledProgress(0.1), totalOutDur);
    // Rename to output
    renameSync(xfadeOutput, output);
    tmpFiles.forEach(f => unlink(f, () => {}));
  } else {
    // Simple concat
    const concatFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
    writeFileSync(concatFile, tmpFiles.map(f => `file '${f}'`).join('\n'));
    await ffrun(['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', output], scaledProgress(0.1), totalOutDur);
    unlink(concatFile, () => {});
    tmpFiles.forEach(f => unlink(f, () => {}));
  }

  if (onProgress) onProgress(1);
  return { output, ext };
}

// Render with xfade transitions between segments
async function renderWithXfade(tmpFiles, items, { format, quality }, onProgress, totalDur) {
  const ext = format === 'webm' ? 'webm' : 'mp4';
  const output = path.join(os.tmpdir(), `xfade_${Date.now()}.${ext}`);

  const inputs = tmpFiles.map((f, i) => ['-i', f]).flat();
  const filterParts = [];
  let prevLabel = '[0:v]';
  let prevALabel = '[0:a]';

  // Cumulative offset: xfade offset = point in the accumulated output where transition starts
  // For chained xfade: after each step, the output duration grows by (itemDur - transitionDur)
  let offset = 0;

  for (let i = 1; i < tmpFiles.length; i++) {
    const xfDur = items[i].transition || 0;
    // Duration of the previous encoded segment (already speed-adjusted by encodeItem)
    const prevDur = (items[i - 1].end - items[i - 1].start) / (items[i - 1].speed || 1);
    offset += prevDur - (i > 1 ? (items[i - 1].transition || 0) : 0);

    const outLabel = i < tmpFiles.length - 1 ? `[xf${i}]` : '[vout]';
    const aOutLabel = i < tmpFiles.length - 1 ? `[af${i}]` : '[aout]';

    if (xfDur > 0) {
      const xfOffset = Math.max(0, offset - xfDur);
      filterParts.push(`${prevLabel}[${i}:v]xfade=transition=fade:duration=${xfDur}:offset=${xfOffset.toFixed(3)}${outLabel}`);
      filterParts.push(`${prevALabel}[${i}:a]acrossfade=d=${xfDur}:c1=tri:c2=tri${aOutLabel}`);
    } else {
      filterParts.push(`${prevLabel}[${i}:v]concat=n=2:v=1:a=0${outLabel}`);
      filterParts.push(`${prevALabel}[${i}:a]concat=n=2:v=0:a=1${aOutLabel}`);
    }

    prevLabel = outLabel;
    prevALabel = aOutLabel;
  }

  const args = ['-y', ...inputs, '-filter_complex', filterParts.join(';'), '-map', '[vout]', '-map', '[aout]'];
  if (format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-crf', String(quality), '-b:v', '0', '-c:a', 'libopus');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality), '-c:a', 'aac', '-b:a', '192k');
  }
  args.push(output);

  await ffrun(args, onProgress, totalDur);
  return output;
}

// Apply text overlays via drawtext filter
async function applyTextOverlays(inputPath, ext, textOverlays) {
  if (!textOverlays || !textOverlays.length) return inputPath;
  const output = path.join(os.tmpdir(), `text_${Date.now()}.${ext}`);

  // Build drawtext filter chain
  const filters = textOverlays.map(ov => {
    const escaped = ov.text.replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/\\/g, '\\\\');
    const color = ov.color || 'white';
    const size = ov.fontSize || 48;

    // Position mapping
    let x, y;
    switch (ov.position) {
      case 'top':          x = '(w-text_w)/2'; y = 'h*0.1'; break;
      case 'bottom':       x = '(w-text_w)/2'; y = 'h*0.85-text_h'; break;
      case 'top-left':     x = 'w*0.05';       y = 'h*0.05'; break;
      case 'top-right':    x = 'w*0.95-text_w'; y = 'h*0.05'; break;
      case 'bottom-left':  x = 'w*0.05';       y = 'h*0.9-text_h'; break;
      case 'bottom-right': x = 'w*0.95-text_w'; y = 'h*0.9-text_h'; break;
      default:             x = '(w-text_w)/2'; y = '(h-text_h)/2'; break; // center
    }

    const enable = `between(t,${ov.startTime},${ov.startTime + ov.duration})`;
    return `drawtext=text='${escaped}':fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:enable='${enable}':shadowx=2:shadowy=2:shadowcolor=black@0.7`;
  });

  const args = ['-y', '-i', inputPath, '-vf', filters.join(',')];
  if (ext === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-c:a', 'copy');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'copy');
  }
  args.push(output);

  await ffrun(args);
  unlink(inputPath, () => {});
  return output;
}

module.exports = { buildCodecArgs, renderItems, renderTimeline, applyTextOverlays };
