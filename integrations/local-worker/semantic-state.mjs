import { createHash } from 'node:crypto';

const uuid = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const embeddedUuid = /(?<![a-f0-9])(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})(?![a-f0-9])/ig;
function jsonContainer(value) {
  if (typeof value !== 'string' || !/^\s*[\[{]/.test(value)) return undefined;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : undefined; }
  catch { return undefined; }
}
export function staticProgramIds(...programs) {
  const ids = new Set();
  const visit = value => {
    if (typeof value === 'string' && uuid.test(value)) ids.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { visit(key); visit(child); }
  };
  programs.forEach(visit); return ids;
}

export class SemanticState {
  constructor(staticIds = new Set()) { this.staticIds = new Set(staticIds); this.ids = new Map(); }
  token(value) {
    if (!uuid.test(value) || this.staticIds.has(value)) return value;
    if (!this.ids.has(value)) this.ids.set(value, `runtime-${this.ids.size + 1}`);
    return this.ids.get(value);
  }
  normalize(value) {
    const register = child => {
      if (typeof child === 'string' && uuid.test(child)) this.token(child);
      else if (typeof child === 'string') { const parsed = jsonContainer(child); if (parsed) register(parsed); }
      else if (Array.isArray(child)) child.forEach(register);
      else if (child && typeof child === 'object') for (const [key, item] of Object.entries(child)) {
        if (key === 'lastCheckedState') continue;
        this.token(key); register(item);
      }
    };
    register(value);
    return this.rewrite(value);
  }
  rewrite(value) {
    if (typeof value === 'string') {
      const parsed = jsonContainer(value);
      if (parsed) return JSON.stringify(this.rewrite(parsed));
      return uuid.test(value) ? this.token(value) : value.replace(embeddedUuid, identifier => this.ids.get(identifier) ?? identifier);
    }
    if (Array.isArray(value)) return value.map(child => this.rewrite(child));
    if (!value || typeof value !== 'object') return value;
    const entries = [];
    for (const [key, child] of Object.entries(value)) {
      if (key === 'lastCheckedState') continue;
      entries.push([this.token(key), this.rewrite(child)]);
    }
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b, 'en')));
  }
  hash(value) { return createHash('sha256').update(JSON.stringify(this.normalize(value))).digest('hex'); }
}

export function seedAt(seed, index) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(index) || index < 1) throw new TypeError('uint32 seed and positive index required');
  let mixed = (seed + Math.imul(index, 0x9e3779b9)) >>> 0;
  mixed = Math.imul(mixed ^ mixed >>> 16, 0x21f0aaad) >>> 0;
  mixed = Math.imul(mixed ^ mixed >>> 15, 0x735a2d97) >>> 0;
  return (mixed ^ mixed >>> 15) & 0x7fffffff;
}

export function verifySeedTranscript(seed, transcript) {
  if (!Array.isArray(transcript) || transcript.some((value, index) => value !== seedAt(seed, index + 1))) throw new Error('native seed transcript diverged');
}
