import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const STORE = () => getStore({ name: 'ecofin-data', region: 'eu-central-1', consistency: 'strong' });
export const SESSION_COOKIE = 'ecofin_admin';
export const SESSION_SECONDS = 8 * 60 * 60;

export const CATEGORIES = [
  { id: '01', name: 'Courtage en financement', alwaysReserved: true },
  { id: '02', name: 'Notariat' },
  { id: '03', name: 'Agence immobilière' },
  { id: '04', name: 'Promotion immobilière' },
  { id: '05', name: 'Construction de maisons individuelles' },
  { id: '06', name: 'Lotisseur et aménageur foncier' },
  { id: '07', name: 'Architecture' },
  { id: '08', name: 'Bureau d’études techniques' },
  { id: '09', name: 'Géomètre-expert' },
  { id: '10', name: 'Diagnostic immobilier' },
  { id: '11', name: 'Expertise bâtiment' },
  { id: '12', name: 'Maçonnerie et gros œuvre' },
  { id: '13', name: 'Électricité' },
  { id: '14', name: 'Plomberie et sanitaire', alwaysReserved: true },
  { id: '15', name: 'Menuiserie et fermetures' },
  { id: '16', name: 'Entreprise de rénovation' },
  { id: '17', name: 'Couverture et étanchéité' },
  { id: '18', name: 'Pisciniste' },
  { id: '19', name: 'Paysagiste et aménagement extérieur' },
];

export const STATUS_LABELS = {
  pending_review: 'À étudier',
  option_48h: 'Option de 48 heures',
  accepted: 'Acceptée – contrat à préparer',
  contract_sent: 'Contrat envoyé',
  awaiting_signature: 'En attente de signature',
  awaiting_payment: 'En attente de règlement',
  confirmed: 'Confirmée – emplacement réservé',
  rejected: 'Refusée',
  withdrawn: 'Retirée',
  expired: 'Option expirée',
};

const ACTIVE_STATUSES = new Set([
  'pending_review', 'option_48h', 'accepted', 'contract_sent',
  'awaiting_signature', 'awaiting_payment', 'confirmed'
]);
const PUBLIC_PENDING = new Set([
  'pending_review', 'option_48h', 'accepted', 'contract_sent',
  'awaiting_signature', 'awaiting_payment'
]);

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function textError(message, status = 400) {
  return json({ error: message }, status);
}

export function secureCookieHeader(token, maxAge = SESSION_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error('SESSION_SECRET absent ou trop court (32 caractères minimum).');
  return value;
}

function sign(value) {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

export function createSessionToken() {
  const payload = base64url(JSON.stringify({ exp: Date.now() + SESSION_SECONDS * 1000, nonce: randomBytes(12).toString('hex') }));
  return `${payload}.${sign(payload)}`;
}

function safeEqual(a, b) {
  const aa = createHmac('sha256', 'ecofin-compare').update(String(a)).digest();
  const bb = createHmac('sha256', 'ecofin-compare').update(String(b)).digest();
  return timingSafeEqual(aa, bb);
}

export function verifyAdminPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || expected.length < 14) throw new Error('ADMIN_PASSWORD absent ou trop court (14 caractères minimum).');
  return safeEqual(candidate, expected);
}

export function isAdminRequest(request) {
  try {
    const cookieHeader = request.headers.get('cookie') || '';
    const raw = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`));
    if (!raw) return false;
    const token = decodeURIComponent(raw.slice(SESSION_COOKIE.length + 1));
    const [payload, suppliedSignature] = token.split('.');
    if (!payload || !suppliedSignature || !safeEqual(sign(payload), suppliedSignature)) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data.exp) && data.exp > Date.now();
  } catch {
    return false;
  }
}

export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

export function categoryById(id) {
  return CATEGORIES.find(item => item.id === String(id).padStart(2, '0'));
}

function publicStatus(category, state) {
  if (category.alwaysReserved) return 'reserved';
  if (!state) return 'available';
  if (state.status === 'confirmed') return 'reserved';
  if (PUBLIC_PENDING.has(state.status)) return 'pending';
  return 'available';
}

async function expireOptionIfNeeded(store, categoryId, state) {
  if (state?.status !== 'option_48h' || !state.expiresAt || Date.parse(state.expiresAt) > Date.now()) return state;
  if (state.applicationId) {
    const key = `applications/${state.applicationId}`;
    const current = await store.getWithMetadata(key, { type: 'json' });
    if (current?.data && current.data.status === 'option_48h') {
      await store.setJSON(key, { ...current.data, status: 'expired', updatedAt: new Date().toISOString() }, { onlyIfMatch: current.etag });
    }
  }
  await store.delete(`categories/${categoryId}`);
  return null;
}

export async function getPublicCategories() {
  const store = STORE();
  const result = [];
  for (const category of CATEGORIES) {
    let state = null;
    if (!category.alwaysReserved) {
      state = await store.get(`categories/${category.id}`, { type: 'json' });
      state = await expireOptionIfNeeded(store, category.id, state);
    }
    result.push({ id: category.id, name: category.name, status: publicStatus(category, state) });
  }
  return result;
}

export async function listApplications() {
  const store = STORE();
  const { blobs } = await store.list({ prefix: 'applications/' });
  const values = await Promise.all(blobs.map(async ({ key }) => await store.get(key, { type: 'json' })));
  return values.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function categoryStateStatus(applicationStatus) {
  if (applicationStatus === 'confirmed') return 'confirmed';
  if (ACTIVE_STATUSES.has(applicationStatus)) return applicationStatus;
  return 'available';
}

export async function refreshCategoryLock(application, newStatus, optionExpiresAt = null) {
  const store = STORE();
  const key = `categories/${application.categoryId}`;
  if (newStatus === 'rejected' || newStatus === 'withdrawn' || newStatus === 'expired') {
    const state = await store.get(key, { type: 'json' });
    if (state?.applicationId === application.id) await store.delete(key);
    return;
  }
  const newState = {
    categoryId: application.categoryId,
    applicationId: application.id,
    status: categoryStateStatus(newStatus),
    updatedAt: new Date().toISOString(),
    ...(newStatus === 'option_48h' ? { expiresAt: optionExpiresAt } : {}),
  };
  const current = await store.getWithMetadata(key, { type: 'json' });
  if (current?.data) {
    if (current.data.applicationId !== application.id) throw new Error('Cette catégorie est déjà associée à une autre candidature.');
    const write = await store.setJSON(key, newState, { onlyIfMatch: current.etag });
    if (!write.modified) throw new Error('La disponibilité du métier vient de changer. Rechargez le tableau de bord.');
  } else {
    const write = await store.setJSON(key, newState, { onlyIfNew: true });
    if (!write.modified) throw new Error('Cette catégorie vient d’être attribuée à une autre candidature.');
  }
}
