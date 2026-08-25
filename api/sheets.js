/**
 * Vercel Serverless Function: /api/sheets
 * Actúa de proxy entre el navegador y Google Sheets para evitar restricciones CORS.
 * El navegador llama a /api/sheets?sheet=Sep26 y esta función consulta Google server-side.
 */

const SPREADSHEET_BASE_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTERGxox2YuRgvw3odjzNQEQPkPeFLgOWByvDnKyFnY6c7EQiZzuX7rpCn7Q1-DjUyXB7Lh7z6gBxSg';

export default async function handler(req, res) {
  // Configurar cabeceras CORS para que el navegador acepte la respuesta
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Manejar preflight OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { sheet } = req.query;

  if (!sheet) {
    return res.status(400).json({ error: 'Parámetro "sheet" requerido. Ej: /api/sheets?sheet=Sep26' });
  }

  try {
    const googleUrl = `${SPREADSHEET_BASE_URL}/pub?output=csv&sheet=${encodeURIComponent(sheet)}`;
    
    // Fetch server-side: sin restricciones CORS
    const response = await fetch(googleUrl, {
      headers: {
        'User-Agent': 'BaeCount/1.0',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Google Sheets devolvió error ${response.status}. La pestaña "${sheet}" puede no existir todavía.` 
      });
    }

    const csvText = await response.text();

    // Comprobar que hay contenido real (no un CSV vacío)
    if (!csvText || csvText.trim().length === 0) {
      return res.status(404).json({ 
        error: `La pestaña "${sheet}" no existe o está vacía en el Google Sheet.` 
      });
    }

    // Devolver el CSV con cabeceras adecuadas
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).send(csvText);

  } catch (error) {
    console.error(`Error al obtener la pestaña "${sheet}" de Google Sheets:`, error);
    return res.status(500).json({ error: 'Error interno al conectar con Google Sheets.' });
  }
}
