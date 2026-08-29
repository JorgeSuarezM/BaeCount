/**
 * /api/session
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
  errorResponse,
  json,
} from '../../lib/server/auth.js';

export const prerender = false;

/** El cuerpo llega como JSON; un cuerpo roto no debe tumbar el endpoint. */
async function readBody(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

export async function POST(context) {
  try {
    const { credential } = await readBody(context.request);
    const email = await verifyGoogleIdToken(credential);

    setSessionCookie(context, email);
    return json({ email, expiresIn: SESSION_MAX_AGE_SECONDS });
  } catch (error) {
    return errorResponse(error, '/api/session');
  }
}

export async function GET(context) {
  try {
    return json({ email: await requireAllowedUser(context) });
  } catch (error) {
    return errorResponse(error, '/api/session');
  }
}

export function DELETE(context) {
  clearSessionCookie(context);
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  });
}
