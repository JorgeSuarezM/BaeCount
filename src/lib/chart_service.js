import Chart from 'chart.js/auto';

let activeChartInstance = null;

/** Importes cortos para los ejes: 1.350 € en vez de 1350.00 €. */
function formatAxisEuros(value) {
  return `${Number(value).toLocaleString('es-ES', { maximumFractionDigits: 0 })} €`;
}

/**
 * Renderiza o actualiza el gráfico de tendencias de los últimos 3 meses.
 * @param {string} canvasId ID del elemento canvas
 * @param {Object[]} historicalData Array de datos mensuales en orden cronológico
 */
export function renderTrendsChart(canvasId, historicalData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Destruir gráfico activo si ya existe para evitar fugas de memoria o solapamiento
  if (activeChartInstance) {
    activeChartInstance.destroy();
    activeChartInstance = null; // Si no, la siguiente llamada destruye un gráfico ya destruido
  }

  // Si no hay datos históricos suficientes, ocultar o mostrar vacío
  if (!historicalData || historicalData.length === 0) {
    console.warn('No hay datos históricos para graficar.');
    return;
  }

  // Invertir si viene en orden descendente para mostrar cronología de izquierda a derecha
  const data = [...historicalData].slice(-3); // Máximo 3 meses

  // Extraer etiquetas y series
  const labels = data.map(d => {
    // Formatear mes (ej. Sep26 -> Sep 26)
    const match = d.month.match(/^([A-Za-z]{3,4})(\d{2})$/);
    return match ? `${match[1]} ${match[2]}` : d.month;
  });

  const realExpenses = data.map(d => d.totals.expenseReal || 0);
  const expectedExpenses = data.map(d => d.totals.expenseExpected || 0);
  
  const realSavings = data.map(d => {
    const income = d.totals.incomeReal || 0;
    const expense = d.totals.expenseReal || 0;
    return income - expense;
  });

  const ctx = canvas.getContext('2d');

  // Crear degradados premium para las barras y líneas
  const expenseRealGlow = ctx.createLinearGradient(0, 0, 0, 200);
  expenseRealGlow.addColorStop(0, 'rgba(139, 92, 246, 0.7)');
  expenseRealGlow.addColorStop(1, 'rgba(139, 92, 246, 0.05)');

  const SAVING_POSITIVE = '#10b981';
  const SAVING_NEGATIVE = '#f43f5e';

  // Verde donde se ahorra, rojo donde se gasta de más: con un solo color había
  // que leer el eje para saber si el mes había cerrado en negativo.
  const savingColor = (value) => (value >= 0 ? SAVING_POSITIVE : SAVING_NEGATIVE);

  // Con un único mes la línea es un punto suelto, así que se agranda para que se vea.
  const savingPointRadius = data.length === 1 ? 7 : 5;

  const savingsFill = ctx.createLinearGradient(0, 0, 0, 220);
  savingsFill.addColorStop(0, 'rgba(16, 185, 129, 0.28)');
  savingsFill.addColorStop(1, 'rgba(16, 185, 129, 0)');

  // Holgura alrededor de la serie para que el cero entre siempre en el eje y la
  // línea no quede pegada al borde. Solo se baja de cero cuando hay algún mes en
  // negativo: si no, se desperdiciaba media gráfica en un rango que nadie usa.
  const hasNegativeSaving = realSavings.some((v) => v < 0);
  const minSaving = Math.min(...realSavings);
  const maxSaving = Math.max(...realSavings);
  const savingsSpan = Math.max(maxSaving - Math.min(minSaving, 0), 50);
  const savingsMin = minSaving < 0 ? minSaving - savingsSpan * 0.15 : 0;
  const savingsMax = Math.max(maxSaving, 0) + savingsSpan * 0.15;

  const savingsLabels = {
    id: 'savingsLabels',
    afterDatasetsDraw(chart) {
      const dataset = chart.getDatasetMeta(2);
      if (!dataset || dataset.hidden) return;

      const { ctx: c } = chart;
      c.save();
      c.font = '600 11px Outfit, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'bottom';

      dataset.data.forEach((point, i) => {
        const value = realSavings[i];
        c.fillStyle = savingColor(value);
        const text = `${value.toLocaleString('es-ES', { maximumFractionDigits: 0 })} €`;
        // Encima del punto salvo que no quepa, y entonces debajo
        const above = point.y > 22;
        c.textBaseline = above ? 'bottom' : 'top';
        c.fillText(text, point.x, point.y + (above ? -10 : 10));
      });

      c.restore();
    }
  };

  activeChartInstance = new Chart(ctx, {
    type: 'bar',
    plugins: [savingsLabels],
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Gasto real',
          type: 'bar',
          data: realExpenses,
          yAxisID: 'y',
          backgroundColor: expenseRealGlow,
          borderColor: '#8b5cf6',
          borderWidth: 2,
          borderRadius: 6,
          order: 2,
          barPercentage: 0.55,
          maxBarThickness: 56,
        },
        {
          label: 'Gasto previsto',
          type: 'bar',
          data: expectedExpenses,
          yAxisID: 'y',
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          borderColor: 'rgba(216, 180, 254, 0.3)',
          borderWidth: 1.5,
          borderDash: [4, 4],
          borderRadius: 6,
          order: 3,
          barPercentage: 0.55,
          maxBarThickness: 56,
        },
        {
          label: 'Ahorro real',
          type: 'line',
          data: realSavings,
          // Eje propio: el ahorro son decenas de euros y los gastos, miles. En un
          // eje compartido la línea quedaba pegada al cero y no se distinguía nada.
          yAxisID: 'ySavings',
          borderColor: SAVING_POSITIVE,
          borderWidth: 3,
          pointBackgroundColor: (c) => savingColor(c.raw ?? 0),
          pointBorderColor: '#ffffff',
          pointBorderWidth: 1.5,
          pointRadius: savingPointRadius,
          pointHoverRadius: savingPointRadius + 2,
          backgroundColor: savingsFill,
          fill: { target: { value: 0 } },
          tension: 0.3,
          order: 0,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      // Al pasar por encima se muestran las tres series del mes a la vez, en vez de
      // obligar a acertar justo encima de cada barra o punto.
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#d8b4fe',
            font: {
              family: 'Outfit',
              size: 11,
              weight: '500'
            },
            padding: 12,
            boxWidth: 12,
            boxHeight: 12,
            usePointStyle: true,
            pointStyle: 'circle'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(18, 9, 31, 0.95)',
          titleColor: '#ffffff',
          titleFont: {
            family: 'Outfit',
            size: 13,
            weight: '600'
          },
          bodyColor: '#d8b4fe',
          bodyFont: {
            family: 'Inter',
            size: 12
          },
          borderColor: 'rgba(139, 92, 246, 0.3)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 10,
          displayColors: true,
          callbacks: {
            label: function(context) {
              const name = context.dataset.label;
              const value = context.raw.toLocaleString('es-ES', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              });
              return ` ${name}: ${value} €`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: 'rgba(216, 180, 254, 0.6)',
            font: {
              family: 'Outfit',
              size: 11
            }
          }
        },
        y: {
          position: 'left',
          beginAtZero: true,
          title: {
            display: true,
            text: 'Gastos',
            color: 'rgba(216, 180, 254, 0.5)',
            font: { family: 'Outfit', size: 10, weight: '600' }
          },
          grid: {
            color: 'rgba(139, 92, 246, 0.08)',
            drawTicks: false
          },
          border: {
            dash: [4, 4]
          },
          ticks: {
            color: 'rgba(216, 180, 254, 0.6)',
            font: {
              family: 'Outfit',
              size: 11
            },
            callback: formatAxisEuros
          }
        },
        ySavings: {
          position: 'right',
          title: {
            display: true,
            text: 'Ahorro',
            color: 'rgba(16, 185, 129, 0.7)',
            font: { family: 'Outfit', size: 10, weight: '600' }
          },
          // Sin rejilla propia para no cruzar la del eje izquierdo. La línea del cero
          // solo se dibuja si algún mes cierra en negativo; con todo en positivo
          // coincidía con el eje X y parecía un subrayado rojo sin sentido.
          grid: {
            drawOnChartArea: hasNegativeSaving,
            drawTicks: false,
            color: (c) => (c.tick.value === 0 ? 'rgba(244, 63, 94, 0.45)' : 'transparent'),
            lineWidth: (c) => (c.tick.value === 0 ? 1.5 : 0)
          },
          border: { display: false },
          suggestedMin: savingsMin,
          suggestedMax: savingsMax,
          ticks: {
            color: 'rgba(16, 185, 129, 0.75)',
            font: {
              family: 'Outfit',
              size: 11
            },
            callback: formatAxisEuros
          }
        }
      }
    }
  });
}
