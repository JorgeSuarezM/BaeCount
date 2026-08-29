/**
 * GET /api/sheets
 *
 * Lee la hoja a través de la API de Google Sheets, autenticada con una cuenta de
 * servicio. El documento no necesita estar publicado en la web: basta con
 * compartirlo en modo lectura con el correo de esa cuenta.
 *
 * Cada petición exige la cookie de sesión de un correo de la lista blanca (ver
 * lib/server/auth.js).
 *
 * Dos modos:
 *   GET /api/sheets?list=1      -> { sheets: [{ name, sheetId }] }
 *   GET /api/sheets?tab=Sep26   -> { values: [[...], [...]] }
 *
 * Nada se cachea: las cifras se editan a mano en la hoja y hay que ver siempre el
 * último valor.
 */

import { requireAllowedUser, callSheetsApi, errorResponse, json } from '../../lib/server/auth.js';

export const prerender = false;

/** Escapa el nombre de una pestaña para usarlo en un rango A1. */
function toA1Range(tabName) {
  return `'${tabName.replace(/'/g, "''")}'!A:C`;
}

export async function GET(context) {
  try {
    await requireAllowedUser(context);

    const params = context.url.searchParams;
    const list = params.get('list');
    const tab = params.get('tab');

    if (list) {
      const data = await callSheetsApi('?fields=sheets.properties(sheetId,title)');
      const sheets = (data.sheets || []).map((sheet) => ({
        name: sheet.properties.title,
        sheetId: sheet.properties.sheetId,
      }));

      return json({ sheets });
    }

    if (!tab) {
      return json({ error: 'Falta el parámetro "tab" (o "list=1").' }, 400);
    }

    const range = encodeURIComponent(toA1Range(tab));
    const data = await callSheetsApi(`/values/${range}?majorDimension=ROWS`);

    return json({ values: data.values || [] });
  } catch (error) {
    return errorResponse(error, '/api/sheets');
  }
}
