/**
 * Servicio para conectar y parsear los datos de Google Sheets de BaeCount.
 * Funciona de forma dinámica sin credenciales de API utilizando la publicación web.
 */

const SPREADSHEET_BASE_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTERGxox2YuRgvw3odjzNQEQPkPeFLgOWByvDnKyFnY6c7EQiZzuX7rpCn7Q1-DjUyXB7Lh7z6gBxSg';
const PUB_HTML_URL = `${SPREADSHEET_BASE_URL}/pubhtml`;
const CSV_URL = `${SPREADSHEET_BASE_URL}/pub?output=csv`;

// Regex para detectar pestañas que representen meses (ej. Sep26, Ago26, Oct27)
const MONTH_TAB_REGEX = /^[A-Za-z]{3,4}\d{2}$/;

/**
 * Parsea una línea de CSV respetando las comillas para textos con comas.
 * @param {string} text 
 * @returns {string[]}
 */
function parseCSVLine(text) {
  const result = [];
  let insideQuote = false;
  let currentField = '';
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      insideQuote = !insideQuote;
    } else if (char === ',' && !insideQuote) {
      result.push(currentField.trim());
      currentField = '';
    } else {
      currentField += char;
    }
  }
  result.push(currentField.trim());
  return result;
}

/**
 * Convierte un texto con formato de número español a un número JS flotante.
 * Soporta formatos como "1.350,50", "42,3%" y "470".
 * @param {string} val 
 * @returns {number|null}
 */
function parseSpanishNumber(val) {
  if (val === undefined || val === null || val === '') return null;
  
  let clean = String(val).replace(/["'\s€%]/g, '');
  if (clean === '' || clean.toLowerCase() === 'null') return null;
  
  // Reemplazar punto de miles y coma de decimales
  if (clean.includes(',') && clean.includes('.')) {
    clean = clean.replace(/\./g, '').replace(/,/g, '.');
  } else if (clean.includes(',')) {
    clean = clean.replace(/,/g, '.');
  }
  
  const num = parseFloat(clean);
  return isNaN(num) ? 0 : num;
}

/**
 * Obtiene la lista de pestañas del Google Sheet publicado y sus respectivos gids.
 * @returns {Promise<{name: string, gid: string}[]>}
 */
export async function fetchAvailableMonths() {
  try {
    // Para evitar cacheos agresivos del navegador
    const response = await fetch(`${PUB_HTML_URL}?usp=chrome_extension&nocache=${Date.now()}`);
    if (!response.ok) throw new Error('No se pudo cargar la hoja de cálculo pública.');
    
    const html = await response.text();
    
    // Buscar la inicialización de pestañas en el código JS embebido de Google Sheets:
    // items.push({name: "Sep26", pageUrl: "...", gid: "7725638", ...})
    const regex = /items\.push\(\{\s*name:\s*"([^"]+)",\s*pageUrl:\s*"[^"]+",\s*gid:\s*"([^"]+)"/g;
    const sheets = [];
    let match;
    
    while ((match = regex.exec(html)) !== null) {
      const name = match[1];
      const gid = match[2];
      
      // Filtrar y quedarnos solo con las pestañas de meses
      if (MONTH_TAB_REGEX.test(name)) {
        sheets.push({ name, gid });
      }
    }
    
    return sheets;
  } catch (error) {
    console.error('Error al recuperar las pestañas de Google Sheets:', error);
    throw error;
  }
}

/**
 * Descarga y parsea la información financiera de un mes específico.
 * @param {string} gid ID de la pestaña
 * @param {string} monthName Nombre de la pestaña (ej. Sep26)
 * @returns {Promise<Object>} Datos financieros estructurados
 */
export async function fetchMonthData(gid, monthName) {
  try {
    const url = `${CSV_URL}&gid=${gid}&nocache=${Date.now()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`No se pudo descargar los datos del mes: ${monthName}`);
    
    const csvText = await response.text();
    const lines = csvText.split(/\r?\n/);
    
    const result = {
      month: monthName,
      incomes: [],
      expenses: [],
      totals: {
        incomeExpected: 0,
        incomeReal: 0,
        expenseExpected: 0,
        expenseReal: 0,
      },
      contributions: {
        jorgeExpected: 0,
        jorgeReal: 0,
        joseExpected: 0,
        joseReal: 0,
      },
      balance: {
        expected: 0,
        real: 0
      }
    };
    
    let currentSection = null; // 'incomes' | 'expenses' | 'balance'
    
    for (let line of lines) {
      if (!line.trim()) continue;
      const columns = parseCSVLine(line);
      if (columns.length === 0 || !columns[0]) continue;
      
      const firstCol = columns[0].trim();
      
      // Detectar cambios de sección
      if (firstCol.toLowerCase() === 'ingresos') {
        currentSection = 'incomes';
        continue;
      } else if (firstCol.toLowerCase() === 'gastos') {
        currentSection = 'expenses';
        continue;
      } else if (firstCol.toLowerCase() === 'balance mensual') {
        currentSection = 'balance';
        // Procesar balance esperado en esta misma línea si existe
        if (columns[1] && columns[1].trim().toLowerCase() === 'esperado') {
          result.balance.expected = parseSpanishNumber(columns[2]) || 0;
        }
        continue;
      }
      
      // Procesar filas dentro de secciones
      if (currentSection === 'incomes') {
        if (firstCol.toLowerCase().startsWith('total ingresos')) {
          result.totals.incomeExpected = parseSpanishNumber(columns[1]) || 0;
          result.totals.incomeReal = parseSpanishNumber(columns[2]) || 0;
          currentSection = null; // Salir de la sección
        } else {
          const name = firstCol;
          const expected = parseSpanishNumber(columns[1]);
          const real = parseSpanishNumber(columns[2]);
          
          // Guardar aportaciones de los integrantes de forma separada para el widget visual
          if (name.toLowerCase().includes('jorge')) {
            result.contributions.jorgeExpected = expected || 0;
            result.contributions.jorgeReal = real !== null ? real : null;
          } else if (name.toLowerCase().includes('josé') || name.toLowerCase().includes('jose')) {
            result.contributions.joseExpected = expected || 0;
            result.contributions.joseReal = real !== null ? real : null;
          }
          
          result.incomes.push({ name, expected, real });
        }
      } else if (currentSection === 'expenses') {
        if (firstCol.toLowerCase().startsWith('total gastos')) {
          result.totals.expenseExpected = parseSpanishNumber(columns[1]) || 0;
          result.totals.expenseReal = parseSpanishNumber(columns[2]) || 0;
          currentSection = null; // Salir de la sección
        } else {
          const name = firstCol;
          const expected = parseSpanishNumber(columns[1]);
          const real = parseSpanishNumber(columns[2]);
          result.expenses.push({ name, expected, real });
        }
      } else if (currentSection === 'balance') {
        // En la fila del balance, la segunda línea suele ser: " , Real, 50"
        if (firstCol.toLowerCase() === 'real' || (columns[1] && columns[1].trim().toLowerCase() === 'real')) {
          const valIndex = firstCol.toLowerCase() === 'real' ? 1 : 2;
          result.balance.real = parseSpanishNumber(columns[valIndex]) || 0;
          currentSection = null;
        }
      }
    }
    
    // Si los totales reales de ingresos no se calcularon del todo
    // y las aportaciones reales están vacías, asumimos 0 para sumas del total
    if (result.totals.incomeReal === 0) {
      const sumRealIncomes = result.incomes.reduce((sum, item) => sum + (item.real || 0), 0);
      result.totals.incomeReal = sumRealIncomes;
    }
    
    return result;
  } catch (error) {
    console.error(`Error al parsear el mes ${monthName}:`, error);
    throw error;
  }
}
