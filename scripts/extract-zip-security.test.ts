import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backendRequire = createRequire(new URL('../packages/workshop-backend/package.json', import.meta.url));
const browserRequire = createRequire(backendRequire.resolve('@cloudflare/puppeteer'));
const extract = createRequire(browserRequire.resolve('@puppeteer/browsers'))('extract-zip');

// Minimal stored ZIP fixture, no downloads, external tools or real browser binaries.
function zip(name: string, value: string, mode = 0o100644): Buffer {
  const filename = Buffer.from(name), body = Buffer.from(value);
  let crc = 0xffffffff;
  for (const b of body) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + body.length, 16);
  return Buffer.concat([local, filename, body, central, filename, end]);
}

test('patched extractor reads regular files and rejects archive/destination symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extract-security-')); const out = join(root, 'out');
  const archive = join(root, 'input.zip'), outside = join(root, 'outside');
  try {
    await mkdir(out); await mkdir(outside);
    await writeFile(archive, zip('normal.txt', 'safe'));
    await extract(archive, { dir: out }); assert.equal(await readFile(join(out, 'normal.txt'), 'utf8'), 'safe');
    await writeFile(archive, zip('escape', outside, 0o120777));
    await assert.rejects(extract(archive, { dir: out }), /symlink/);
    await symlink(outside, join(out, 'parent'), 'dir');
    await writeFile(archive, zip('parent/new/file', 'bad'));
    await assert.rejects(extract(archive, { dir: out }), /real directory/);
    await writeFile(join(outside, 'victim'), 'unchanged'); await symlink(join(outside, 'victim'), join(out, 'victim'));
    await writeFile(archive, zip('victim', 'bad'));
    await assert.rejects(extract(archive, { dir: out }), /symlink/);
    assert.equal(await readFile(join(outside, 'victim'), 'utf8'), 'unchanged');
    await assert.rejects(readFile(join(outside, 'new/file')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
