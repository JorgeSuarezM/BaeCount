/**
 * Vercel Serverless Function: /api/config
 *
 * Devuelve el ID de cliente OAuth para que el navegador pueda pintar el botón de
 * Google. Es un dato público (viaja en cada petición de login), así que este
 * endpoint no exige sesión: sin él no habría forma de iniciarla.
 *
 * Se sirve desde aquí en vez de incrustarlo en el bundle para que cambiarlo sea
 * editar una variable de entorno, sin tener que reconstruir el frontend.
 */

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    return res.status(500).json({
      error: 'Falta la variable de entorno GOOGLE_CLIENT_ID en el proyecto de Vercel.',
    });
  }

  return res.status(200).json({ clientId });
}
