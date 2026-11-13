import {
  json, textError, isAdminRequest, sameOrigin,
  listApplications, getPublicCategories, refreshCategoryLock, STATUS_LABELS, STORE
} from '../lib/shared.mjs';

const ALLOWED = new Set(Object.keys(STATUS_LABELS));

export default async (request) => {
  if (!isAdminRequest(request)) return textError('Authentification requise.', 401);
  try {
    if (request.method === 'GET') {
      const categories = await getPublicCategories();
      const applications = await listApplications();
      const counts = {
        total: applications.length,
        pending: applications.filter(a => ['pending_review', 'option_48h'].includes(a.status)).length,
        followup: applications.filter(a => ['accepted', 'contract_sent', 'awaiting_signature', 'awaiting_payment'].includes(a.status)).length,
        confirmed: applications.filter(a => a.status === 'confirmed').length,
      };
      return json({ applications, categories, counts, statusLabels: STATUS_LABELS });
    }

    if (request.method === 'PATCH') {
      if (!sameOrigin(request)) return textError('Origine de requête invalide.', 403);
      const body = await request.json();
      const id = String(body.id || '').replace(/[^a-f0-9-]/gi, '').slice(0, 40);
      if (!id) return textError('Identifiant de candidature manquant.', 400);
      const store = STORE();
      const key = `applications/${id}`;
      const current = await store.getWithMetadata(key, { type: 'json' });
      if (!current?.data) return textError('Candidature introuvable.', 404);

      const next = { ...current.data, updatedAt: new Date().toISOString() };
      if (body.status !== undefined) {
        if (!ALLOWED.has(body.status)) return textError('Statut non reconnu.', 400);
        next.status = body.status;
      }
      if (body.adminNotes !== undefined) next.adminNotes = String(body.adminNotes).slice(0, 2000);
      if (body.price !== undefined) {
        const price = Number(body.price);
        if (![550, 600].includes(price)) return textError('Le montant doit être de 550 € ou 600 € TTC.', 400);
        next.price = price;
      }
      if (body.sumupUrl !== undefined) {
        const raw = String(body.sumupUrl || '').trim();
        if (raw) {
          let parsed;
          try { parsed = new URL(raw); } catch { return textError('Lien SumUp invalide.', 400); }
          if (parsed.protocol !== 'https:' || !(parsed.hostname === 'sumup.com' || parsed.hostname.endsWith('.sumup.com'))) return textError('Le lien doit être une URL HTTPS SumUp.', 400);
        }
        next.sumupUrl = raw;
      }

      if (body.status === 'option_48h') next.optionExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      else if (body.status && body.status !== 'option_48h') next.optionExpiresAt = null;

      const saved = await store.setJSON(key, next, { onlyIfMatch: current.etag });
      if (!saved.modified) return textError('La candidature a été modifiée simultanément. Rechargez la page et réessayez.', 409);

      if (body.status !== undefined) {
        try { await refreshCategoryLock(next, next.status, next.optionExpiresAt); }
        catch (error) { return textError(`Le statut a été enregistré, mais la disponibilité du métier doit être vérifiée : ${error.message}`, 409); }
      }
      return json({ ok: true, application: next });
    }

    return textError('Méthode non autorisée.', 405);
  } catch (error) {
    return textError('Erreur lors du traitement de la demande.', 500);
  }
};
