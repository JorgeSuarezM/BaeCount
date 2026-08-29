// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import vercel from '@astrojs/vercel';

/**
 * En Vercel las variables de entorno llegan ya en `process.env`, pero en local Vite
 * solo carga el `.env` dentro de `import.meta.env`, así que el código del servidor no
 * las veía y `astro dev` respondía "falta la variable de entorno".
 *
 * Se vuelcan aquí para que haya una única forma de leerlas (`process.env`) en los dos
 * sitios. Lo que ya venga del entorno real manda: así un `SESSION_SECRET=x npm run dev`
 * sigue pisando al del fichero.
 */
const fileEnv = loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), '');
process.env = { ...fileEnv, ...process.env };

/**
 * Configuración de BaeCount.
 *
 * La página es estática: se genera en el build y Vercel la sirve desde la CDN, igual
 * que hacía el index.html de antes. Solo las rutas de /api se ejecutan en el servidor
 * (cada una lo pide con `export const prerender = false`), porque necesitan las
 * variables de entorno, `node:crypto` para firmar la sesión y la cuenta de servicio
 * de Google. Por eso el adaptador usa funciones Node y no Edge: google-auth-library
 * y node:crypto no existen en el runtime Edge.
 */
export default defineConfig({
  output: 'static',
  adapter: vercel(),
  build: {
    // Un solo fichero de estilos, como antes: el CSS es global y no se reparte por rutas.
    inlineStylesheets: 'never',
  },
  security: {
    // Rechaza las peticiones que no vengan de la propia app. Con la sesión en una
    // cookie es la defensa contra CSRF que antes daba la cabecera Authorization.
    checkOrigin: true,
  },
});
