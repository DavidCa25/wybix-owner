import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

// HTML raíz para la versión WEB (PWA). No afecta a Android/iOS nativos.
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="es">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />

        {/* PWA */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0F2A3F" />
        <meta name="mobile-web-app-capable" content="yes" />

        {/* iOS: instalar en inicio y pantalla completa */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Wybix" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <link rel="icon" href="/favicon.png" />

        {/* Evita el flash y el rebote de scroll */}
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}

const responsiveBackground = `
  html, body { background-color: #F1F5F9; }
  body { overscroll-behavior-y: none; }
`;
