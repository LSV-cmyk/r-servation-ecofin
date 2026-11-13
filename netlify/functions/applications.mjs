import { randomUUID } from 'node:crypto';
import { json, textError, categoryById, STORE } from '../lib/shared.mjs';

const MAX_BODY = 24_000;
const LAUNCH_END = Date.parse('2026-11-20T00:00:00-04:00');
const clean = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

export default async (request) => {
  if (request.method !== 'POST') return textError('Méthode non autorisée.', 405);
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) return textError('Format de formulaire non pris en charge.', 415);
    const size = Number(request.headers.get('content-length') || 0);
    if (size > MAX_BODY) return textError('Le formulaire est trop volumineux.', 413);
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY) return textError('Le formulaire est trop volumineux.', 413);
    let body;
    try { body = JSON.parse(rawBody); }
    catch { return textError('Le contenu du formulaire est invalide.', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return textError('Le contenu du formulaire est invalide.', 400);
    if (body['bot-field']) return json({ ok: true, message: 'Candidature transmise.' });

    const company = clean(body['raison-sociale'], 120);
    const siret = clean(body.siret, 14).replace(/\s/g, '');
    const representative = clean(body.representant, 120);
    const role = clean(body['qualite-representant'], 80);
    const email = clean(body['email-professionnel'], 160).toLowerCase();
    const phone = clean(body.telephone, 30);
    const categoryId = clean(body.categoryId || body['metier-candidature'], 40).slice(0, 2).padStart(2, '0');
    const extraMessage = clean(body['message-complementaire'], 1200);
    const category = categoryById(categoryId);

    if (!company || !representative || !role || !phone || !/^\d{14}$/.test(siret)) return textError('Merci de vérifier les champs obligatoires et le SIRET.', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return textError('Adresse e-mail invalide.', 400);
    if (!category || category.alwaysReserved) return textError('Cette catégorie n’est pas ouverte aux candidatures.', 409);
    if (body['lecture-confidentialite'] !== 'Oui' || body['lecture-notice-confidentialite'] !== 'Oui') return textError('Les confirmations de confidentialité sont requises.', 400);
    if (body['certification-exactitude'] !== 'Oui') return textError('La certification des informations est requise.', 400);

    const now = new Date();
    const price = now.getTime() < LAUNCH_END ? 550 : 600;
    const id = randomUUID();
    const store = STORE();
    const categoryKey = `categories/${categoryId}`;

    const oldState = await store.get(categoryKey, { type: 'json' });
    if (oldState?.status === 'option_48h' && oldState.expiresAt && Date.parse(oldState.expiresAt) <= Date.now()) {
      if (oldState.applicationId) {
        const oldKey = `applications/${oldState.applicationId}`;
        const oldRecord = await store.getWithMetadata(oldKey, { type: 'json' });
        if (oldRecord?.data?.status === 'option_48h') {
          await store.setJSON(oldKey, { ...oldRecord.data, status: 'expired', updatedAt: now.toISOString() }, { onlyIfMatch: oldRecord.etag });
        }
      }
      await store.delete(categoryKey);
    }

    const lock = await store.setJSON(categoryKey, {
      categoryId, applicationId: id, status: 'pending_review', createdAt: now.toISOString()
    }, { onlyIfNew: true });
    if (!lock.modified) return textError('Cette catégorie est actuellement en cours de validation ou déjà réservée. Merci d’en choisir une autre.', 409);

    const application = {
      id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      status: 'pending_review',
      categoryId,
      categoryName: category.name,
      company,
      siret,
      representative,
      role,
      email,
      phone,
      price,
      event: 'ECOFIN 2027 — samedi 16 janvier 2027 — Karibea, Fort-de-France — 8 h à 17 h',
      confidentialityRead: true,
      privacyNoticeRead: true,
      accuracyCertified: true,
      extraMessage,
      sumupUrl: '',
      adminNotes: '',
    };

    try {
      await store.setJSON(`applications/${id}`, application, { onlyIfNew: true });
    } catch (error) {
      await store.delete(categoryKey);
      throw error;
    }

    return json({ ok: true, id, message: 'Votre candidature a été transmise à MQ EVENT. Le métier passe en cours de validation.' }, 201);
  } catch (error) {
    return textError('Une erreur est survenue lors de la transmission. Merci de réessayer ou de contacter MQ EVENT.', 500);
  }
};
