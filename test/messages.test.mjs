import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrap, extract, pickExt, SKIP_TYPES } from '../messages.mjs';

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

test('SKIP_TYPES holds protocol/system noise', () => {
  assert.ok(SKIP_TYPES.has('protocolMessage'));
  assert.ok(SKIP_TYPES.has('senderKeyDistributionMessage'));
  assert.ok(SKIP_TYPES.has('empty'));
  assert.equal(SKIP_TYPES.has('text'), false);
});
