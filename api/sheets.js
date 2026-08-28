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
 * Los datos se leen de /pubhtml/sheet (tabla HTML) y NO de /pub?output=csv. Ese segundo
 * endpoint responde un 307 hacia googleusercontent.com, y esa respuesta final lleva
 * `cache-control: private, max-age=300`: cada nodo de Google guarda su propia copia de
 * cinco minutos, así que dos peticiones seguidas podían devolver versiones distintas y
 * los datos parecían retroceder. /pubhtml/sheet responde `no-cache, no-store, max-age=0`
 * y sirve el estado actual de la hoja, así que convertimos su tabla a CSV aquí y el
 * cliente sigue recibiendo el mismo formato de siempre.
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

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** Convierte el contenido de una celda HTML en texto plano. */
function cellToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match)
    .trim();
}

/** Escapa un campo para CSV: solo se entrecomilla si hace falta. */
function toCsvField(value) {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Convierte la tabla de /pubhtml/sheet en CSV.
 *
 * Hay que respetar rowspan y colspan: en la hoja, "Balance mensual" ocupa dos filas con
 * rowspan=2, y la fila siguiente no repite esa celda. Sin tenerlo en cuenta, "Real" caería
 * en la primera columna y el balance real se leería de la columna equivocada.
 */
function tableToCsv(html) {
  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbody) return '';

  const rows = [...tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const spanning = []; // filas que cada columna sigue ocupando por un rowspan previo
  const csvRows = [];

  for (const row of rows) {
    const cells = [];
    let col = 0;

    // Solo <td>: el <th> inicial es el número de fila que Google pinta al margen.
    for (const match of row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)) {
      while (spanning[col] > 0) {
        spanning[col] -= 1;
        cells[col] = cells[col] ?? '';
        col += 1;
      }

      const attrs = match[1];
      const text = cellToText(match[2]);
      const colspan = Number(attrs.match(/colspan\s*=\s*"?(\d+)"?/i)?.[1] ?? 1);
      const rowspan = Number(attrs.match(/rowspan\s*=\s*"?(\d+)"?/i)?.[1] ?? 1);

      for (let i = 0; i < colspan; i += 1) {
        cells[col] = i === 0 ? text : '';
        if (rowspan > 1) spanning[col] = rowspan - 1;
        col += 1;
      }
    }

    // Columnas que siguen ocupadas por un rowspan y no han recibido celda en esta fila
    for (let i = 0; i < spanning.length; i += 1) {
      if (i >= col && spanning[i] > 0) {
        spanning[i] -= 1;
        cells[i] = cells[i] ?? '';
      }
    }

    csvRows.push([...cells].map((cell) => toCsvField(cell ?? '')).join(','));
  }

  return csvRows.join('\n');
}

/** Descarga una pestaña como CSV, leyéndola del HTML publicado (sin caché). */
async function fetchSheetCsv(gid) {
  const url = `${SPREADSHEET_BASE_URL}/pubhtml/sheet?headers=false&gid=${gid}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'BaeCount/1.0' },
    redirect: 'follow',
    cache: 'no-store',
  });

  if (!response.ok) {
    const error = new Error(
      `Google Sheets devolvió error ${response.status}. La pestaña con gid ${gid} puede no existir.`
    );
    error.status = response.status;
    throw error;
  }

  return tableToCsv(await response.text());
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

    const csvText = await fetchSheetCsv(gid);

    if (!csvText || csvText.trim().length === 0) {
      return res.status(404).json({ error: `La pestaña con gid ${gid} está vacía.` });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send(csvText);
  } catch (error) {
    console.error('Error al conectar con Google Sheets:', error);
    return res
      .status(error.status && error.status >= 400 ? error.status : 500)
      .json({ error: error.status ? error.message : 'Error interno al conectar con Google Sheets.' });
  }
}
