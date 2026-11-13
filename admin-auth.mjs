import {
  json, textError, createSessionToken, secureCookieHeader,
  SESSION_COOKIE, SESSION_SECONDS, verifyAdminPassword, isAdminRequest, sameOrigin
} from '../lib/shared.mjs';

export default async (request) => {
  try {
    if (request.method === 'GET') return json({ authenticated: isAdminRequest(request) });
    if (request.method === 'POST') {
      if (!sameOrigin(request)) return textError('Origine de requête invalide.', 403);
      const body = await request.json().catch(() => ({}));
      if (typeof body.password !== 'string' || body.password.length > 500) return textError('Mot de passe invalide.', 400);
      if (!verifyAdminPassword(body.password)) return textError('Identifiants incorrects.', 401);
      const token = createSessionToken();
      return json({ authenticated: true }, 200, { 'Set-Cookie': secureCookieHeader(token) });
    }
    if (request.method === 'DELETE') {
      if (!sameOrigin(request)) return textError('Origine de requête invalide.', 403);
      return json({ authenticated: false }, 200, {
        'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
      });
    }
    return textError('Méthode non autorisée.', 405);
  } catch (error) {
    return textError(error.message || 'Erreur d’authentification.', 500);
  }
};
