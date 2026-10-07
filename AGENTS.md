# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

# Migraciones durante el desarrollo

Todo cambio de contrato de nube debe incluir su migración y verificación en el
mismo bloque de desarrollo. Ensayar sobre un entorno restaurado, comprobar los
permisos por defecto de Supabase y registrar el historial solo después del smoke.
No dejar la aplicación de migraciones como una sorpresa al cierre de una fase;
si falta autorización o configuración remota, reportar ese gate en ese momento.
