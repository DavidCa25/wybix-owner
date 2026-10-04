import Constants from 'expo-constants';
import * as Application from 'expo-application';

const extra = (Constants.expoConfig?.extra ?? {}) as { wybix?: { backend?: string; channel?: string; perfil?: string; anonKey?: string } };

export const CONFIG = {
  backend: extra.wybix?.backend ?? 'https://www.wybixpos.com.mx/backend',
  canal: extra.wybix?.channel ?? 'pos-production',
  perfil: extra.wybix?.perfil ?? 'produccion',
  // Llave ANÓNIMA pública del proyecto (la misma que trae el POS de Windows).
  // No da acceso a datos: todo pasa por pos-sync con la credencial del equipo.
  anonKey: extra.wybix?.perfil === 'desarrollo' && extra.wybix.anonKey ? extra.wybix.anonKey : 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN3bHBzcGdta3d6bHJvd2xsdnZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNDMyNzAsImV4cCI6MjA5ODYxOTI3MH0.Wyh4fjmhYJp-USPHtrj_dKAJow038Nj62jR44qirmlM',
  version: Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0.0.0',
};

/** ¿La versión instalada cumple el mínimo? (semver simple x.y.z) */
export function cumpleVersion(actual: string, minima: string | null | undefined): boolean {
  if (!minima) return true;
  const a = actual.split('.').map(Number), m = minima.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) > (m[i] ?? 0)) return true; if ((a[i] ?? 0) < (m[i] ?? 0)) return false; }
  return true;
}
