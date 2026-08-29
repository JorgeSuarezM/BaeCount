/**
 * GET /api/config
 *
 * Devuelve el ID de cliente OAuth para que el navegador pueda pintar el botón de
 * Google. Es un dato público (viaja en cada petición de login), así que este
 * endpoint no exige sesión: sin él no habría forma de iniciarla.
 *
 * Se sirve desde aquí en vez de incrustarlo en el bundle para que cambiarlo sea
 * editar una variable de entorno, sin tener que reconstruir el frontend.
 */

import { json } from '../../lib/server/auth.js';

// Lee variables de entorno en cada petición, así que no se puede prerenderizar.
export const prerender = false;

export function GET() {
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    return json(
      { error: 'Falta la variable de entorno GOOGLE_CLIENT_ID en el proyecto de Vercel.' },
      500
    );
  }

  return json({ clientId });
}
