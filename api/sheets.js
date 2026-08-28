/**
 * Vercel Serverless Function: /api/sheets
 * Actúa de proxy entre el navegador y Google Sheets para evitar restricciones CORS.
 *
 * Dos modos:
 *   GET /api/sheets?list=1   -> JSON con las pestañas reales del documento: [{ name, gid }]
 *   GET /api/sheets?gid=NNN  -> CSV de esa pestaña
 *
 * No se cachea ninguna respuesta: la gracia de la app es ver en el móvil lo que se acaba
 * de escribir en el Sheet, así que cada recarga o pulsación de "Actualizar" debe llegar
 * hasta Google. Con s-maxage el CDN de Vercel servía datos de hasta 5 minutos antes.
 *
 * Importante: en un documento "publicado en la web" (/d/e/2PACX-...) Google IGNORA el
 * parámetro ?sheet=<nombre>. La única forma de elegir pestaña es el gid numérico, que
 * obtenemos leyendo /pubhtml server-side.
 */

const SPREADSHEET_BASE_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTERGxox2YuRgvw3odjzNQEQPkPeFLgOWByvDnKyFnY6c7EQiZzuX7rpCn7Q1-DjUyXB7Lh7z6gBxSg';

// En el HTML de /pubhtml, Google incluye el menú de pestañas como objetos JS:
//   {name: "Sep26", pageUrl: "...gid=7725638", gid: "7725638", initialSheet: ...}
const SHEET_MENU_REGEX = /\{name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*pageUrl:\s*"[^"]*"\s*,\s*gid:\s*"(\d+)"/g;

/** Deshace los escapes \xNN y \uNNNN que Google mete en los nombres de pestaña. */
function decodeSheetName(raw) {
  return raw
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(.)/g, '$1');
}

/** Descarga /pubhtml y extrae la lista de pestañas con su gid, en el orden del documento. */
async function fetchSheetList() {
  const response = await fetch(`${SPREADSHEET_BASE_URL}/pubhtml`, {
    headers: { 'User-Agent': 'BaeCount/1.0' },
    redirect: 'follow',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Google Sheets devolvió ${response.status} al listar las pestañas.`);
  }

  const html = await response.text();
  const sheets = [];
  const seen = new Set();

  for (const match of html.matchAll(SHEET_MENU_REGEX)) {
    const gid = match[2];
    if (seen.has(gid)) continue;
    seen.add(gid);
    sheets.push({ name: decodeSheetName(match[1]), gid });
  }

  return sheets;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { list, gid } = req.query;

  try {
    if (list) {
      const sheets = await fetchSheetList();

      if (sheets.length === 0) {
        return res.status(502).json({
          error: 'No se pudo leer la lista de pestañas. Comprueba que el documento sigue publicado en la web.',
        });
      }

      return res.status(200).json({ sheets });
    }

    if (!gid) {
      return res.status(400).json({
        error: 'Falta el parámetro "gid" (o "list=1"). Ej: /api/sheets?gid=7725638',
      });
    }

    if (!/^\d+$/.test(String(gid))) {
      return res.status(400).json({ error: 'El parámetro "gid" debe ser numérico.' });
    }

    const googleUrl = `${SPREADSHEET_BASE_URL}/pub?gid=${gid}&single=true&output=csv`;
    const response = await fetch(googleUrl, {
      headers: { 'User-Agent': 'BaeCount/1.0' },
      redirect: 'follow',
      cache: 'no-store',
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Google Sheets devolvió error ${response.status}. La pestaña con gid ${gid} puede no existir.`,
      });
    }

    const csvText = await response.text();

    if (!csvText || csvText.trim().length === 0) {
      return res.status(404).json({ error: `La pestaña con gid ${gid} está vacía.` });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send(csvText);
  } catch (error) {
    console.error('Error al conectar con Google Sheets:', error);
    return res.status(500).json({ error: 'Error interno al conectar con Google Sheets.' });
  }
}
