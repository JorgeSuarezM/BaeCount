/**
 * Servicio para conectar y parsear los datos de Google Sheets de BaeCount.
 * Los datos se obtienen a través de /api/sheets, una función serverless en Vercel
 * que actúa de proxy para evitar las restricciones CORS del navegador.
 *
 * En desarrollo hay que levantar el proyecto con `vercel dev` para que /api/sheets exista;
 * con `npm run dev` (Vite a secas) esa ruta no está servida.
 */

const PROXY_URL = '/api/sheets';

// Pestañas que representan meses: Sep26, Ago26, Oct27...
const MONTH_TAB_REGEX = /^([A-Za-z]{3,4})(\d{2})$/;

const MONTH_CODES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/**
 * Convierte un código de mes en un número ordenable (ej. Sep26 -> 2026 * 12 + 8).
 * @param {string} name
 * @returns {number|null} null si el nombre no es un código de mes válido
 */
function monthSortKey(name) {
  const match = name.match(MONTH_TAB_REGEX);
  if (!match) return null;

  const monthIndex = MONTH_CODES.findIndex(
    (code) => code.toLowerCase() === match[1].toLowerCase()
  );
  if (monthIndex === -1) return null;

  return (2000 + Number(match[2])) * 12 + monthIndex;
}

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
 * Obtiene las pestañas de mes que existen realmente en el documento.
 * El proxy lee /pubhtml server-side y devuelve el nombre y el gid de cada pestaña;
 * aquí nos quedamos solo con las que tienen forma de mes y las ordenamos cronológicamente.
 * @returns {Promise<{name: string, gid: string}[]>}
 */
export async function fetchAvailableMonths() {
  const response = await fetch(`${PROXY_URL}?list=1`);

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `Error ${response.status} al listar las pestañas del documento.`);
  }

  const { sheets = [] } = await response.json();

  return sheets
    .map((sheet) => ({ ...sheet, sortKey: monthSortKey(sheet.name) }))
    .filter((sheet) => sheet.sortKey !== null)
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ name, gid }) => ({ name, gid }));
}

/**
 * Descarga y parsea la información financiera de un mes específico.
 * @param {string} gid GID numérico de la pestaña (ej. "7725638")
 * @param {string} monthName Nombre de la pestaña (ej. Sep26)
 * @returns {Promise<Object>} Datos financieros estructurados
 */
export async function fetchMonthData(gid, monthName) {
  try {
    // Llamamos al proxy serverless de Vercel (/api/sheets) con el gid de la pestaña.
    // El proxy hace la petición a Google server-side (sin restricciones CORS) y nos devuelve el CSV.
    const url = `${PROXY_URL}?gid=${encodeURIComponent(gid)}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Error ${response.status} al descargar el mes: ${monthName}`);
    }
    
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
      // Solo descartamos las filas separadoras (",,"). La fila del balance real llega
      // como ",Real,0", con la primera celda vacía, y hay que dejarla pasar.
      if (columns.every((col) => !col)) continue;
      
      const firstCol = (columns[0] || '').trim();
      
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
        } else if (firstCol) {
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
        } else if (firstCol) {
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
