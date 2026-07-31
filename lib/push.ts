import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { supabase } from './supabase';

// Como se muestran las notificaciones con la app abierta
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true
  })
});

export async function registerForPush(): Promise<string | null> {
  // En web (PWA) los push nativos no aplican; se omite sin romper.
  if (Platform.OS === 'web') return null;
  // Los push reales no funcionan en simulador
  if (!Device.isDevice) {
    console.log('[PUSH] Se requiere un dispositivo fisico.');
    return null;
  }

  // Permiso
  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') {
    console.log('[PUSH] Permiso denegado.');
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Wybix',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#2563eb'
    });
  }

  const projectId =
    Constants?.expoConfig?.extra?.eas?.projectId ??
    Constants?.easConfig?.projectId;

  // Sin projectId de EAS (p. ej. en Expo Go o antes del primer build) no se
  // pueden emitir push. Se omite en silencio para no romper el tablero.
  if (!projectId) {
    console.log('[PUSH] Sin projectId de EAS; se omiten las notificaciones push.');
    return null;
  }

  let token: string | null = null;
  try {
    const tokenResp = await Notifications.getExpoPushTokenAsync({ projectId });
    token = tokenResp.data;
  } catch (e: any) {
    console.log('[PUSH] No se pudo obtener el token:', e?.message);
    return null;
  }

  const { data: userData } = await supabase.auth.getUser();
  const ownerId = userData?.user?.id;
  if (ownerId && token) {
    const { error } = await supabase
      .from('push_tokens')
      .upsert(
        { owner_id: ownerId, token, platform: Platform.OS },
        { onConflict: 'owner_id,token' }
      );
    if (error) console.log('[PUSH] No se pudo guardar el token:', error.message);
  }

  return token;
}