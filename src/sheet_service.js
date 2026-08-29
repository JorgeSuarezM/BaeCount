/**
 * Servicio para leer los datos de BaeCount desde Google Sheets.
 *
 * Las peticiones van a /api/sheets, una función serverless que consulta la API de
 * Google con una cuenta de servicio. La hoja ya no está publicada en la web, así que
 * todo pasa por ahí y cada llamada viaja firmada con el ID token de la sesión.
 *
 * En desarrollo hace falta `vercel dev` (con las variables de entorno configuradas)
 * para que /api exista; con `npm run dev` a secas esa ruta no está servida.
 */

import { getIdToken, clearSession } from './auth_service.js';

const API_URL = '/api/sheets';

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
 * Llama a /api/sheets con el token de la sesión.
 * Si el servidor rechaza la sesión, se cierra para que la app vuelva al login.
 * @param {Record<string, string>} params
 * @returns {Promise<Object>}
 */
async function callApi(params) {
  const token = getIdToken();
  if (!token) {
    throw new Error('No hay sesión iniciada.');
  }

  const query = new URLSearchParams({ ...params, t: String(Date.now()) });
  const response = await fetch(`${API_URL}?${query}`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const message = detail.error || `Error ${response.status} al leer la hoja de cálculo.`;

    const error = new Error(message);

    if (response.status === 401 || response.status === 403) {
      // La app ya vuelve al login con este mensaje, así que se marca para que
      // quien lo capture no muestre además una alerta encima.
      error.sessionLost = true;
      clearSession(message);
    }
    throw error;
  }

  return response.json();
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
 * Obtiene las pestañas de mes que existen realmente en el documento, ordenadas
 * cronológicamente. Al crear un mes nuevo en la hoja aparece solo, sin tocar código.
 * @returns {Promise<{name: string}[]>}
 */
export async function fetchAvailableMonths() {
  const { sheets = [] } = await callApi({ list: '1' });

  return sheets
    .map((sheet) => ({ name: sheet.name, sortKey: monthSortKey(sheet.name) }))
    .filter((sheet) => sheet.sortKey !== null)
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ name }) => ({ name }));
}

/**
 * Descarga y parsea la información financiera de un mes específico.
 * @param {string} monthName Nombre de la pestaña (ej. Sep26)
 * @returns {Promise<Object>} Datos financieros estructurados
 */
export async function fetchMonthData(monthName) {
  try {
    // La API devuelve las filas ya separadas en celdas, así que no hay CSV que parsear.
    const { values = [] } = await callApi({ tab: monthName });
    
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
    
    for (const row of values) {
      // La API omite las celdas vacías del final, así que las filas pueden venir
      // cortas; normalizamos para poder leer columns[1] y columns[2] sin comprobar.
      const columns = [0, 1, 2].map((i) => String(row?.[i] ?? '').trim());

      // Descartamos solo las filas separadoras, completamente vacías. La del balance
      // real llega como ["", "Real", "900"] y hay que dejarla pasar.
      if (columns.every((col) => !col)) continue;

      const firstCol = columns[0];
      
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
