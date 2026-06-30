import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrap, extract, pickExt, SKIP_TYPES, splitMessage } from '../messages.mjs';

test('extract: plain text (conversation)', () => {
  assert.deepEqual(extract({ conversation: 'hi' }), { type: 'text', text: 'hi', mediaKind: null });
});

test('extract: empty-string conversation is still text (not skipped)', () => {
  assert.deepEqual(extract({ conversation: '' }), { type: 'text', text: '', mediaKind: null });
});

test('extract: extended text', () => {
  assert.equal(extract({ extendedTextMessage: { text: 'yo' } }).text, 'yo');
});

test('extract: image with caption', () => {
  assert.deepEqual(extract({ imageMessage: { caption: 'pic' } }), { type: 'image', text: 'pic', mediaKind: 'image' });
});

test('extract: video / audio / sticker mediaKind', () => {
  assert.equal(extract({ videoMessage: {} }).mediaKind, 'video');
  assert.equal(extract({ audioMessage: {} }).mediaKind, 'audio');
  assert.equal(extract({ stickerMessage: {} }).mediaKind, 'sticker');
});

test('extract: document falls back to fileName when no caption', () => {
  assert.equal(extract({ documentMessage: { fileName: 'spec.pdf' } }).text, 'spec.pdf');
  assert.equal(extract({ documentMessage: { caption: 'see this', fileName: 'spec.pdf' } }).text, 'see this');
});

test('extract: null/undefined → empty', () => {
  assert.equal(extract(null).type, 'empty');
  assert.equal(extract(undefined).type, 'empty');
});

test('extract: unknown type falls back to first key name', () => {
  assert.equal(extract({ pollCreationMessage: {} }).type, 'pollCreationMessage');
});

test('unwrap: ephemeral wrapper', () => {
  const inner = { conversation: 'secret' };
  assert.equal(unwrap({ ephemeralMessage: { message: inner } }), inner);
});

test('unwrap: nested viewOnce inside ephemeral', () => {
  const inner = { imageMessage: { caption: 'x' } };
  assert.equal(unwrap({ ephemeralMessage: { message: { viewOnceMessageV2: { message: inner } } } }), inner);
});

test('unwrap: plain message returned unchanged', () => {
  const m = { conversation: 'plain' };
  assert.equal(unwrap(m), m);
});

test('extract(unwrap(viewOnce image)) yields the image', () => {
  const r = extract(unwrap({ viewOnceMessage: { message: { imageMessage: { caption: 'vo' } } } }));
  assert.equal(r.type, 'image');
  assert.equal(r.text, 'vo');
});

test('pickExt: from mimetype', () => {
  assert.equal(pickExt({ imageMessage: { mimetype: 'image/jpeg' } }, 'image'), 'jpg');
  assert.equal(pickExt({ videoMessage: { mimetype: 'video/mp4' } }, 'video'), 'mp4');
  assert.equal(pickExt({ documentMessage: { mimetype: 'application/pdf' } }, 'document'), 'pdf');
});

test('pickExt: prefers document fileName extension', () => {
  assert.equal(pickExt({ documentMessage: { fileName: 'quote.docx', mimetype: 'application/octet-stream' } }, 'document'), 'docx');
});

test('pickExt: sticker default webp', () => {
  assert.equal(pickExt({ stickerMessage: {} }, 'sticker'), 'webp');
});

test('pickExt: mimetype with codec params is stripped', () => {
  assert.equal(pickExt({ audioMessage: { mimetype: 'audio/ogg; codecs=opus' } }, 'audio'), 'ogg');
});

test('pickExt: unknown non-media → bin', () => {
  assert.equal(pickExt({ imageMessage: {} }, 'image'), 'bin');
});

test('splitMessage: short text stays one chunk', () => {
  assert.deepEqual(splitMessage('hello there', 600), ['hello there']);
});

test('splitMessage: long text splits, every chunk within max', () => {
  const para = 'This is a sentence. '.repeat(120); // ~2400 chars
  const chunks = splitMessage(para, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
  // nothing dropped (ignoring whitespace)
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), para.replace(/\s+/g, ' ').trim());
});

test('splitMessage: prefers paragraph boundaries', () => {
  const text = 'A'.repeat(100) + '\n\n' + 'B'.repeat(100);
  const chunks = splitMessage(text, 120);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].startsWith('A') && chunks[1].startsWith('B'));
});

test('splitMessage: a single over-long word is hard-wrapped', () => {
  const chunks = splitMessage('x'.repeat(500), 100);
  assert.ok(chunks.length >= 5);
  for (const c of chunks) assert.ok(c.length <= 100);
});

test('splitMessage: handles empty / null', () => {
  assert.deepEqual(splitMessage('', 600), ['']);
  assert.deepEqual(splitMessage(null, 600), ['']);
});

test('SKIP_TYPES holds protocol/system noise', () => {
  assert.ok(SKIP_TYPES.has('protocolMessage'));
  assert.ok(SKIP_TYPES.has('senderKeyDistributionMessage'));
  assert.ok(SKIP_TYPES.has('empty'));
  assert.equal(SKIP_TYPES.has('text'), false);
});
