import { jsPDF } from 'jspdf';

/**
 * Formatea un número como divisa de Euro (€) para el reporte PDF.
 * @param {number} num 
 * @returns {string}
 */
function formatPDFCurrency(num) {
  if (num === null || num === undefined) return '-';
  return `${num.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
}

/**
 * Formatea el nombre del mes (ej. Sep26 -> Septiembre 2026).
 * @param {string} monthStr 
 * @returns {string}
 */
function formatMonthName(monthStr) {
  const monthsFull = {
    ene: 'Enero', feb: 'Febrero', mar: 'Marzo', abr: 'Abril',
    may: 'Mayo', jun: 'Junio', jul: 'Julio', ago: 'Agosto',
    sep: 'Septiembre', oct: 'Octubre', nov: 'Noviembre', dic: 'Diciembre',
    sept: 'Septiembre'
  };
  const match = monthStr.match(/^([A-Za-z]{3,4})(\d{2})$/);
  if (!match) return monthStr;
  
  const abbrev = match[1].toLowerCase();
  const year2D = match[2];
  const monthFull = monthsFull[abbrev] || abbrev;
  return `${monthFull} 20${year2D}`;
}

/**
 * Genera y descarga un PDF estilizado con el resumen financiero.
 * @param {Object[]} monthsData Array con datos mensuales de sheet_service.js
 * @param {string} fromMonthName Mes de inicio
 * @param {string} toMonthName Mes de fin
 */
export function exportMonthsToPDF(monthsData, fromMonthName, toMonthName) {
  if (!monthsData || monthsData.length === 0) {
    throw new Error('No hay datos que exportar en el periodo seleccionado.');
  }

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 15;
  let cursorY = 18;

  // Paleta de Colores PDF
  const COLOR_PRIMARY = [76, 29, 149];    // Morado oscuro (#4c1d95)
  const COLOR_SECONDARY = [124, 58, 237]; // Violeta (#7c3aed)
  const COLOR_TEXT_DARK = [15, 10, 23];   // Negro (#0f0a17)
  const COLOR_TEXT_MUTED = [120, 110, 135]; // Gris/Lavanda apagado
  const COLOR_BORDER = [220, 215, 230];   // Gris claro de bordes
  const COLOR_BG_LIGHT = [250, 248, 252]; // Fondo claro

  // Helper para dibujar Cabecera
  function drawHeader(titleRange) {
    // Franja violeta superior
    doc.setFillColor(...COLOR_PRIMARY);
    doc.rect(0, 0, pageWidth, 5, 'F');

    // Logo y Título principal
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(...COLOR_PRIMARY);
    doc.text('BaeCount', marginX, 18);

    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR_TEXT_MUTED);
    doc.text('Finanzas Compartidas', marginX, 23);

    // Rango de fechas
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...COLOR_SECONDARY);
    doc.text(titleRange, pageWidth - marginX, 18, { align: 'right' });

    // Fecha de generación
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR_TEXT_MUTED);
    const dateStr = new Date().toLocaleDateString('es-ES', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    doc.text(`Generado: ${dateStr}`, pageWidth - marginX, 23, { align: 'right' });

    // Línea divisoria
    doc.setDrawColor(...COLOR_SECONDARY);
    doc.setLineWidth(0.4);
    doc.line(marginX, 26, pageWidth - marginX, 26);
    cursorY = 34;
  }

  // Helper para dibujar el pie. La numeración se estampa al final, cuando ya se
  // sabe cuántas páginas han salido: los meses largos generan continuaciones y
  // antes todas repetían el número de la primera.
  function drawFooter() {
    doc.setDrawColor(...COLOR_BORDER);
    doc.setLineWidth(0.2);
    doc.line(marginX, pageHeight - 15, pageWidth - marginX, pageHeight - 15);

    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR_TEXT_MUTED);
    doc.text('BaeCount - Extracto financiero de consulta', marginX, pageHeight - 10);
  }

  /** Escribe "Página X de Y" en todas las páginas, ya con el total definitivo. */
  function stampPageNumbers() {
    const totalPages = doc.internal.getNumberOfPages();
    for (let page = 1; page <= totalPages; page += 1) {
      doc.setPage(page);
      doc.setFont('Helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...COLOR_TEXT_MUTED);
      doc.text(`Página ${page} de ${totalPages}`, pageWidth - marginX, pageHeight - 10, { align: 'right' });
    }
  }

  /**
   * Dibuja una tabla de conceptos (previsto / real) con su fila de total.
   * Se usa para gastos y para ingresos, que antes no salían en el PDF.
   * @returns {number} La Y donde continuar
   */
  function drawItemsTable(title, items, totalLabel, totalExpected, totalReal, startY, monthName) {
    let y = startY;

    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...COLOR_PRIMARY);
    doc.text(title, marginX, y);
    y += 6;

    const drawTableHeader = () => {
      doc.setFillColor(...COLOR_PRIMARY);
      doc.rect(marginX, y, pageWidth - (marginX * 2), 6, 'F');
      doc.setFont('Helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(255, 255, 255);
      doc.text('Concepto', marginX + 4, y + 4);
      doc.text('Previsto (EUR)', pageWidth / 2 + 15, y + 4, { align: 'right' });
      doc.text('Real (EUR)', pageWidth - marginX - 4, y + 4, { align: 'right' });
      y += 6;
    };

    drawTableHeader();

    items.forEach((item, idx) => {
      // Si la fila se sale del margen inferior, seguimos en otra página
      if (y > pageHeight - 30) {
        drawFooter();
        doc.addPage();
        drawHeader(`Periodo: ${formatMonthName(monthName)} (Continuación)`);
        y = cursorY;
        drawTableHeader();
      }

      if (idx % 2 === 0) {
        doc.setFillColor(...COLOR_BG_LIGHT);
        doc.rect(marginX, y, pageWidth - (marginX * 2), 6, 'F');
      }

      doc.setFont('Helvetica', 'normal');
      doc.setTextColor(...COLOR_TEXT_DARK);
      doc.setFontSize(8.5);
      doc.text(item.name, marginX + 4, y + 4.5);
      doc.text(formatPDFCurrency(item.expected), pageWidth / 2 + 15, y + 4.5, { align: 'right' });

      const realText = item.real === null ? 'Pendiente' : formatPDFCurrency(item.real);
      doc.setFont('Helvetica', item.real === null ? 'italic' : 'normal');
      doc.text(realText, pageWidth - marginX - 4, y + 4.5, { align: 'right' });
      doc.setFont('Helvetica', 'normal');

      doc.setDrawColor(...COLOR_BORDER);
      doc.setLineWidth(0.1);
      doc.line(marginX, y + 6, pageWidth - marginX, y + 6);

      y += 6;
    });

    if (y > pageHeight - 25) {
      drawFooter();
      doc.addPage();
      drawHeader(`Periodo: ${formatMonthName(monthName)} (Continuación)`);
      y = cursorY;
    }

    doc.setFillColor(240, 235, 248);
    doc.rect(marginX, y, pageWidth - (marginX * 2), 7, 'F');
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR_PRIMARY);
    doc.text(totalLabel, marginX + 4, y + 5);
    doc.text(formatPDFCurrency(totalExpected), pageWidth / 2 + 15, y + 5, { align: 'right' });
    doc.text(formatPDFCurrency(totalReal), pageWidth - marginX - 4, y + 5, { align: 'right' });

    return y + 13;
  }

  const isMultiMonth = monthsData.length > 1;
  const titleRangeText = isMultiMonth 
    ? `${formatMonthName(fromMonthName)} - ${formatMonthName(toMonthName)}`
    : formatMonthName(fromMonthName);

  // --- PÁGINA 1: RESUMEN CONSOLIDADO (Solo si es un rango de meses) ---
  if (isMultiMonth) {
    drawHeader(titleRangeText);
    
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...COLOR_PRIMARY);
    doc.text('Resumen Consolidado del Periodo', marginX, cursorY);
    cursorY += 8;

    // Calcular Totales Generales del Periodo
    const totalMonths = monthsData.length;
    let sumIncomesExpected = 0, sumIncomesReal = 0;
    let sumExpensesExpected = 0, sumExpensesReal = 0;
    let sumJorgeReal = 0, sumJoseReal = 0;

    monthsData.forEach(m => {
      sumIncomesExpected += m.totals.incomeExpected || 0;
      sumIncomesReal += m.totals.incomeReal || 0;
      sumExpensesExpected += m.totals.expenseExpected || 0;
      sumExpensesReal += m.totals.expenseReal || 0;
      sumJorgeReal += m.contributions.jorgeReal || 0;
      sumJoseReal += m.contributions.joseReal || 0;
    });

    const netSavingsReal = sumIncomesReal - sumExpensesReal;
    const netSavingsExpected = sumIncomesExpected - sumExpensesExpected;

    // Tarjeta del Resumen de Totales
    doc.setFillColor(...COLOR_BG_LIGHT);
    doc.setDrawColor(...COLOR_BORDER);
    doc.roundedRect(marginX, cursorY, pageWidth - (marginX * 2), 35, 3, 3, 'FD');

    // Contenido de la Tarjeta
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR_TEXT_MUTED);
    doc.text('INGRESOS TOTALES REALES', marginX + 8, cursorY + 8);
    doc.text('GASTOS TOTALES REALES', pageWidth / 2, cursorY + 8);

    doc.setFontSize(15);
    doc.setTextColor(...COLOR_TEXT_DARK);
    doc.text(formatPDFCurrency(sumIncomesReal), marginX + 8, cursorY + 15);
    doc.text(formatPDFCurrency(sumExpensesReal), pageWidth / 2, cursorY + 15);

    // Separador interno
    doc.setDrawColor(...COLOR_BORDER);
    doc.line(marginX + 8, cursorY + 20, pageWidth - marginX - 8, cursorY + 20);

    // Ahorro e Info de meses
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...COLOR_PRIMARY);
    doc.text(`Ahorro Acumulado Real: ${formatPDFCurrency(netSavingsReal)}`, marginX + 8, cursorY + 28);
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR_TEXT_MUTED);
    doc.text(`Periodo total analizado: ${totalMonths} meses`, pageWidth - marginX - 8, cursorY + 28, { align: 'right' });

    cursorY += 46;

    // Tabla de Medias Mensuales
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...COLOR_PRIMARY);
    doc.text('Medias Mensuales', marginX, cursorY);
    cursorY += 6;

    // Renderizar Tabla de Medias
    const tableHeaderY = cursorY;
    doc.setFillColor(...COLOR_SECONDARY);
    doc.rect(marginX, tableHeaderY, pageWidth - (marginX * 2), 7, 'F');
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    doc.text('Métrica', marginX + 4, tableHeaderY + 5);
    doc.text('Total Periodo', pageWidth / 2 - 10, tableHeaderY + 5, { align: 'right' });
    doc.text('Media Mensual', pageWidth - marginX - 4, tableHeaderY + 5, { align: 'right' });

    const rows = [
      { label: 'Ingresos Totales (Real)', total: sumIncomesReal, avg: sumIncomesReal / totalMonths },
      { label: 'Gastos Totales (Real)', total: sumExpensesReal, avg: sumExpensesReal / totalMonths },
      { label: 'Ahorro (Real)', total: netSavingsReal, avg: netSavingsReal / totalMonths },
      { label: 'Aportación de Jorge (Real)', total: sumJorgeReal, avg: sumJorgeReal / totalMonths },
      { label: 'Aportación de José (Real)', total: sumJoseReal, avg: sumJoseReal / totalMonths },
    ];

    let rowY = tableHeaderY + 7;
    doc.setFont('Helvetica', 'normal');
    doc.setTextColor(...COLOR_TEXT_DARK);
    
    rows.forEach((row, idx) => {
      if (idx % 2 === 0) {
        doc.setFillColor(...COLOR_BG_LIGHT);
        doc.rect(marginX, rowY, pageWidth - (marginX * 2), 7, 'F');
      }
      doc.setFont('Helvetica', idx >= 3 ? 'normal' : 'bold');
      doc.text(row.label, marginX + 4, rowY + 5);
      doc.setFont('Helvetica', 'normal');
      doc.text(formatPDFCurrency(row.total), pageWidth / 2 - 10, rowY + 5, { align: 'right' });
      doc.text(formatPDFCurrency(row.avg), pageWidth - marginX - 4, rowY + 5, { align: 'right' });
      
      // Dibujar línea inferior de celda
      doc.setDrawColor(...COLOR_BORDER);
      doc.setLineWidth(0.1);
      doc.line(marginX, rowY + 7, pageWidth - marginX, rowY + 7);
      
      rowY += 7;
    });

    drawFooter();
    doc.addPage();
  }

  // --- DETALLE MES A MES ---
  monthsData.forEach((month, index) => {
    drawHeader(`Periodo: ${formatMonthName(month.month)}`);

    // --- SECCIÓN APORTACIONES Y SALARIOS ---
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...COLOR_PRIMARY);
    doc.text('Resumen de Aportaciones del Mes', marginX, cursorY);
    cursorY += 6;

    // Dibujar tarjetas de integrantes Jorge / José
    const colWidth = (pageWidth - (marginX * 2) - 8) / 2;

    // Jorge Card
    doc.setFillColor(...COLOR_BG_LIGHT);
    doc.setDrawColor(...COLOR_BORDER);
    doc.roundedRect(marginX, cursorY, colWidth, 24, 2, 2, 'FD');
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...COLOR_PRIMARY);
    doc.text('JORGE', marginX + 4, cursorY + 6);
    doc.setFontSize(8);
    doc.setTextColor(...COLOR_TEXT_MUTED);
    doc.text('Aportación Real:', marginX + 4, cursorY + 12);
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...COLOR_TEXT_DARK);
    doc.text(formatPDFCurrency(month.contributions.jorgeReal), marginX + 4, cursorY + 18);
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR_TEXT_MUTED);
    doc.text(`Previsto: ${formatPDFCurrency(month.contributions.jorgeExpected)}`, marginX + colWidth - 4, cursorY + 18, { align: 'right' });

    // José Card
    doc.setFillColor(...COLOR_BG_LIGHT);
    doc.roundedRect(marginX + colWidth + 8, cursorY, colWidth, 24, 2, 2, 'FD');
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...COLOR_PRIMARY);
    doc.text('JOSÉ', marginX + colWidth + 12, cursorY + 6);
    doc.setFontSize(8);
    doc.setTextColor(...COLOR_TEXT_MUTED);
    doc.text('Aportación Real:', marginX + colWidth + 12, cursorY + 12);
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...COLOR_TEXT_DARK);
    doc.text(formatPDFCurrency(month.contributions.joseReal), marginX + colWidth + 12, cursorY + 18);
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR_TEXT_MUTED);
    doc.text(`Previsto: ${formatPDFCurrency(month.contributions.joseExpected)}`, marginX + (colWidth * 2) + 8 - 4, cursorY + 18, { align: 'right' });

    let rowY = cursorY + 34;

    // Desglose de ingresos: la app permite consultarlos en pantalla, pero el PDF
    // solo sacaba los gastos y el extracto quedaba a medias.
    rowY = drawItemsTable(
      'Desglose de Ingresos',
      month.incomes,
      'TOTAL INGRESOS',
      month.totals.incomeExpected,
      month.totals.incomeReal,
      rowY,
      month.month
    );

    if (rowY > pageHeight - 60) {
      drawFooter();
      doc.addPage();
      drawHeader(`Periodo: ${formatMonthName(month.month)} (Continuación)`);
      rowY = cursorY;
    }

    rowY = drawItemsTable(
      'Desglose de Gastos',
      month.expenses,
      'TOTAL GASTOS',
      month.totals.expenseExpected,
      month.totals.expenseReal,
      rowY,
      month.month
    );

    // --- RESUMEN FINAL DE BALANCE MENSUAL ---
    if (rowY > pageHeight - 30) {
      drawFooter();
      doc.addPage();
      drawHeader(`Periodo: ${formatMonthName(month.month)} (Continuación)`);
      rowY = cursorY;
    }

    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...COLOR_PRIMARY);
    doc.text('Balance Final del Mes', marginX, rowY);
    rowY += 5;

    doc.setDrawColor(...COLOR_SECONDARY);
    doc.setLineWidth(0.3);
    doc.line(marginX, rowY, pageWidth - marginX, rowY);
    rowY += 5;

    // Valores de balance
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR_TEXT_DARK);
    doc.text('Ahorro Previsto:', marginX + 4, rowY + 2);
    doc.setFont('Helvetica', 'bold');
    doc.text(formatPDFCurrency(month.balance.expected), marginX + 45, rowY + 2);

    doc.setFont('Helvetica', 'normal');
    doc.setTextColor(...COLOR_TEXT_DARK);
    doc.text('Ahorro Real:', pageWidth / 2 + 10, rowY + 2);
    doc.setFont('Helvetica', 'bold');
    const savingColor = month.balance.real >= 0 ? [16, 185, 129] : [244, 63, 94];
    doc.setTextColor(...savingColor);
    doc.text(formatPDFCurrency(month.balance.real), pageWidth / 2 + 35, rowY + 2);

    drawFooter();

    // Añadir página si no es el último elemento
    if (index < monthsData.length - 1) {
      doc.addPage();
    }
  });

  stampPageNumbers();

  // Guardar y descargar el PDF
  const filename = isMultiMonth 
    ? `BaeCount-Extracto-${fromMonthName}-${toMonthName}.pdf`
    : `BaeCount-Extracto-${fromMonthName}.pdf`;
  doc.save(filename);
}
