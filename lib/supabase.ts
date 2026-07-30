import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const envUrl = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const envAnon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

function makeClient(url: string, anon: string): SupabaseClient {
  return createClient(url, anon, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false
    }
  });
}

export let supabase: SupabaseClient = makeClient(envUrl || 'https://placeholder.supabase.co', envAnon || 'placeholder');

export function configureSupabase(url: string, anonKey: string): void {
  supabase = makeClient(url, anonKey);
}