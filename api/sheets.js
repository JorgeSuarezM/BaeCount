/**
 * Vercel Serverless Function: /api/sheets
 *
 * Lee la hoja a través de la API de Google Sheets, autenticada con una cuenta de
 * servicio. El documento ya no necesita estar publicado en la web: basta con
 * compartirlo en modo lectura con el correo de esa cuenta.
 *
 * Cada petición exige un ID token de un correo de la lista blanca (ver _auth.js).
 *
 * Dos modos:
 *   GET /api/sheets?list=1      -> { sheets: [{ name, sheetId }] }
 *   GET /api/sheets?tab=Sep26   -> { values: [[...], [...]] }
 *
 * Nada se cachea: las cifras se editan a mano en la hoja y hay que ver siempre el
 * último valor. Además, al usar la API en lugar del documento publicado desaparece
 * la caché de cinco minutos que servía versiones distintas en cada petición.
 */

import { requireAllowedUser, callSheetsApi, HttpError } from './_auth.js';

/** Escapa el nombre de una pestaña para usarlo en un rango A1. */
function toA1Range(tabName) {
  return `'${tabName.replace(/'/g, "''")}'!A:C`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  try {
    await requireAllowedUser(req);

    const { list, tab } = req.query;

    if (list) {
      const data = await callSheetsApi('?fields=sheets.properties(sheetId,title)');
      const sheets = (data.sheets || []).map((sheet) => ({
        name: sheet.properties.title,
        sheetId: sheet.properties.sheetId,
      }));

      return res.status(200).json({ sheets });
    }

    if (!tab) {
      return res.status(400).json({ error: 'Falta el parámetro "tab" (o "list=1").' });
    }

    const range = encodeURIComponent(toA1Range(String(tab)));
    const data = await callSheetsApi(`/values/${range}?majorDimension=ROWS`);

    return res.status(200).json({ values: data.values || [] });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error inesperado en /api/sheets:', error);
    return res.status(500).json({ error: 'Error interno al leer la hoja de cálculo.' });
  }
}
