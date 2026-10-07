import React, { createContext, useContext, useEffect, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { nivel as leerNivel, type Nivel } from './mfa';
import { olvidarTokenPush } from './push';

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  /** Nivel de la sesión (MFA): con factor y en AAL1, la app pide el código. */
  nivel: Nivel;
  /** ¿Falta confirmar el segundo factor en esta sesión? */
  pideCodigo: boolean;
  refrescarNivel: () => Promise<void>;
  /** Hay sesión y todavía no se leyó su nivel: no mostrar nada sensible aún. */
  leyendoNivel: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  resetPassword: (email: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

// Página web que recibe el enlace del correo y deja poner la nueva contraseña
const RESET_REDIRECT = 'https://wybixpos.com.mx/recuperar';

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [nivel, setNivel] = useState<Nivel>({ actual: null, siguiente: null });
  const [leyendoNivel, setLeyendoNivel] = useState(false);

  async function refrescarNivel() { setNivel(await leerNivel()); }

  useEffect(() => {
    // Sesion guardada al abrir la app
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session) setNivel(await leerNivel());
      setLoading(false);
    });

    // Escucha cambios de sesion (login / logout)
    // (incluye MFA_CHALLENGE_VERIFIED: la sesión pasa a AAL2)
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      // Fuera del callback: supabase-js se bloquea si se le llama desde dentro.
      if (newSession) {
        setLeyendoNivel(true);
        setTimeout(() => { leerNivel().then(setNivel).finally(() => setLeyendoNivel(false)); }, 0);
      } else setNivel({ actual: null, siguiente: null });
    });

    return () => { sub.subscription.unsubscribe(); };
  }, []);

  async function signIn(email: string, password: string): Promise<{ error: string | null }> {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password
    });
    return { error: error ? error.message : null };
  }

  async function resetPassword(email: string): Promise<{ error: string | null }> {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: RESET_REDIRECT
    });
    return { error: error ? error.message : null };
  }

  async function signOut(): Promise<void> {
    // Antes de perder la sesión: con ella se borra el token de este teléfono.
    await olvidarTokenPush().catch(() => undefined);
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider value={{
      session, loading, nivel, refrescarNivel, leyendoNivel,
      pideCodigo: !!session && nivel.actual === 'aal1' && nivel.siguiente === 'aal2',
      signIn, resetPassword, signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return ctx;
}