import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { encodeGif } from './gif-encoder.mjs';

const sourcePath = resolve(process.env.VIDEO_GIF_SOURCE ?? 'planta industrial.mp4');
const outputPath = resolve(process.env.VIDEO_GIF_OUTPUT ?? 'docs/readme-assets/industrial-plant-video.gif');
const width = Math.max(240, Number(process.env.VIDEO_GIF_WIDTH ?? 640));
const frameCount = Math.max(4, Number(process.env.VIDEO_GIF_FRAMES ?? 18));
const startRatio = Math.min(0.95, Math.max(0, Number(process.env.VIDEO_GIF_START_RATIO ?? 0.06)));
const endRatio = Math.min(1, Math.max(startRatio + 0.01, Number(process.env.VIDEO_GIF_END_RATIO ?? 0.92)));
const delayCentiseconds = Math.max(4, Number(process.env.VIDEO_GIF_DELAY ?? 9));
const minChangedSamples = Math.max(8, Number(process.env.VIDEO_GIF_MIN_CHANGED ?? 80));

if (!existsSync(sourcePath)) throw new Error(`Video source not found: ${sourcePath}`);

const extension = basename(sourcePath).split('.').pop()?.toLowerCase() ?? 'mp4';
const mimeType = extension === 'webm' ? 'video/webm' : extension === 'mov' ? 'video/quicktime' : 'video/mp4';
const source = `data:${mimeType};base64,${readFileSync(sourcePath).toString('base64')}`;

const changedPixelSamples = (a, b) => {
  const count = Math.min(a.length, b.length);
  let changed = 0;
  for (let index = 0; index < count; index += 24) {
    const diff = Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
    if (diff > 24) changed += 1;
  }
  return changed;
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  await page.setContent(`
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #0f1115; }
      video, canvas { display: none; }
    </style>
    <video id="source" preload="auto" muted playsinline src="${source}"></video>
    <canvas id="frame"></canvas>
  `);

  await page.waitForFunction(
    () => {
      const video = document.querySelector('#source');
      return video && Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth > 0 && video.videoHeight > 0;
    },
    undefined,
    { timeout: 60000 },
  );

  const metadata = await page.evaluate(
    ({ targetWidth }) => {
      const video = document.querySelector('#source');
      const canvas = document.querySelector('#frame');
      const height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * targetWidth));
      canvas.width = targetWidth;
      canvas.height = height;
      return {
        duration: video.duration,
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        width: canvas.width,
        height: canvas.height,
      };
    },
    { targetWidth: width },
  );

  const frames = [];
  for (let index = 0; index < frameCount; index += 1) {
    const ratio = startRatio + ((endRatio - startRatio) * index) / Math.max(1, frameCount - 1);
    const frame = await page.evaluate(
      async ({ timeRatio }) => {
        const video = document.querySelector('#source');
        const canvas = document.querySelector('#frame');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas 2D context unavailable.');
        await new Promise((resolveFrame, rejectFrame) => {
          const timeout = window.setTimeout(() => rejectFrame(new Error('Timed out seeking video frame.')), 12000);
          const done = () => {
            window.clearTimeout(timeout);
            video.removeEventListener('seeked', done);
            resolveFrame();
          };
          video.addEventListener('seeked', done, { once: true });
          video.currentTime = Math.min(video.duration - 0.05, Math.max(0, video.duration * timeRatio));
        });
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const chunkSize = 0x8000;
        let binary = '';
        for (let cursor = 0; cursor < data.length; cursor += chunkSize) {
          binary += String.fromCharCode(...data.subarray(cursor, cursor + chunkSize));
        }
        return { width: canvas.width, height: canvas.height, pixels: btoa(binary) };
      },
      { timeRatio: ratio },
    );
    frames.push(frame);
  }

  const decoded = frames.map((frame) => ({ width: frame.width, height: frame.height, pixels: Buffer.from(frame.pixels, 'base64') }));
  const maxChanged = decoded.slice(1).reduce((best, frame) => Math.max(best, changedPixelSamples(decoded[0].pixels, frame.pixels)), 0);
  if (maxChanged < minChangedSamples) throw new Error(`Video GIF is not visibly different enough (${maxChanged} changed samples).`);

  const gif = encodeGif({ width: decoded[0].width, height: decoded[0].height, frames: decoded, delayCentiseconds });
  await page.setContent(`<img id="gif-validation" src="data:image/gif;base64,${gif.toString('base64')}" alt="GIF validation">`);
  const image = page.locator('#gif-validation');
  await image.waitFor({ state: 'visible' });
  const firstRender = await image.screenshot();
  await page.waitForTimeout(Math.max(350, delayCentiseconds * 20));
  const secondRender = await image.screenshot();
  let animatedBytes = 0;
  for (let index = 0; index < Math.min(firstRender.length, secondRender.length); index += 29) {
    if (firstRender[index] !== secondRender[index]) animatedBytes += 1;
  }
  if (animatedBytes < 12) throw new Error(`Generated GIF is not visibly animated (${animatedBytes} changed render samples).`);

  writeFileSync(outputPath, gif);
  console.log(
    `${outputPath} from ${sourcePath} (${metadata.sourceWidth}x${metadata.sourceHeight}, ${metadata.duration.toFixed(2)}s, ${frameCount} frames, ${maxChanged} changed samples, ${animatedBytes} animated render samples)`,
  );
} finally {
  await browser.close();
}
