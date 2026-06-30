// Pure message-parsing helpers for the daemon, factored out so they can be unit-tested
// without importing daemon.mjs (which has side effects: opens the DB, starts the HTTP server, connects).

// Protocol/system message kinds that aren't real conversation content — don't archive them.
export const SKIP_TYPES = new Set(['protocolMessage', 'senderKeyDistributionMessage', 'empty']);

// Unwrap ephemeral / view-once / edited / caption wrappers down to the real content node.
export function unwrap(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessageV2Extension?.message ||
      m.documentWithCaptionMessage?.message ||
      m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

// Return { type, text, mediaKind } for a (unwrapped) message node.
export function extract(m) {
  if (!m) return { type: 'empty', text: '', mediaKind: null };
  if (m.conversation != null) return { type: 'text', text: m.conversation, mediaKind: null };
  if (m.extendedTextMessage) return { type: 'text', text: m.extendedTextMessage.text || '', mediaKind: null };
  if (m.imageMessage) return { type: 'image', text: m.imageMessage.caption || '', mediaKind: 'image' };
  if (m.videoMessage) return { type: 'video', text: m.videoMessage.caption || '', mediaKind: 'video' };
  if (m.audioMessage) return { type: 'audio', text: '', mediaKind: 'audio' };
  if (m.documentMessage)
    return { type: 'document', text: m.documentMessage.caption || m.documentMessage.fileName || '', mediaKind: 'document' };
  if (m.stickerMessage) return { type: 'sticker', text: '', mediaKind: 'sticker' };
  if (m.reactionMessage) return { type: 'reaction', text: m.reactionMessage.text || '', mediaKind: null };
  if (m.locationMessage)
    return { type: 'location', text: `${m.locationMessage.degreesLatitude},${m.locationMessage.degreesLongitude}`, mediaKind: null };
  if (m.contactMessage) return { type: 'contact', text: m.contactMessage.displayName || '', mediaKind: null };
  return { type: Object.keys(m)[0] || 'other', text: '', mediaKind: null };
}

export const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'application/pdf': 'pdf', 'application/zip': 'zip',
};

export function pickExt(node, kind) {
  const doc = node.documentMessage;
  if (doc?.fileName && doc.fileName.includes('.')) return doc.fileName.split('.').pop().slice(0, 8);
  const mime = (node.imageMessage || node.videoMessage || node.audioMessage || node.documentMessage || node.stickerMessage)?.mimetype || '';
  const base = mime.split(';')[0];
  if (MIME_EXT[base]) return MIME_EXT[base];
  if (base.includes('/')) return base.split('/')[1].slice(0, 8);
  return kind === 'sticker' ? 'webp' : 'bin';
}
