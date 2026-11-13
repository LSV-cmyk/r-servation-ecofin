import { json, textError, getPublicCategories } from '../lib/shared.mjs';

export default async (request) => {
  if (request.method !== 'GET') return textError('Méthode non autorisée.', 405);
  try {
    return json({ categories: await getPublicCategories() }, 200, { 'Cache-Control': 'no-store' });
  } catch (error) {
    return textError('Impossible de charger les disponibilités.', 500);
  }
};
