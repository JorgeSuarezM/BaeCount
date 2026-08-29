/**
 * Vercel Serverless Function: /api/session
 *
 * Gestiona la sesión de la app, que es lo que evita tener que pulsar el botón de
 * Google cada vez que se abre la web o la PWA:
 *
 *   POST   -> recibe el ID token de Google, lo valida y emite la cookie de 24 horas
 *   GET    -> dice si la cookie sigue viva, para arrancar sin pasar por el login
 *   DELETE -> borra la cookie (cerrar sesión)
 *
 * La cookie es HttpOnly, así que el navegador la manda sola en cada petición a /api
 * y ningún script de la página puede leerla.
 */

import {
  verifyGoogleIdToken,
  requireAllowedUser,
  setSessionCookie,
  clearSessionCookie,
  SESSION_MAX_AGE_SECONDS,
  HttpError,
} from './_auth.js';

/** Vercel ya parsea el JSON, pero con otro Content-Type llega como texto. */
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;

  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');

  try {
    if (req.method === 'POST') {
      const { credential } = readBody(req);
      const email = await verifyGoogleIdToken(credential);

      setSessionCookie(req, res, email);
      return res.status(200).json({ email, expiresIn: SESSION_MAX_AGE_SECONDS });
    }

    if (req.method === 'GET') {
      const email = await requireAllowedUser(req);
      return res.status(200).json({ email });
    }

    if (req.method === 'DELETE') {
      clearSessionCookie(req, res);
      return res.status(204).end();
    }

    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error inesperado en /api/session:', error);
    return res.status(500).json({ error: 'Error interno al gestionar la sesión.' });
  }
}
