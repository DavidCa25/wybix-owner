import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { parseQr, savePairing } from '../lib/pairing';
import { colors, fonts, radius } from '../theme/tokens';

export default function Escanear() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!permission) return;
    if (!permission.granted && permission.canAskAgain) requestPermission();
  }, [permission]);

  async function onScan({ data }: { data: string }) {
    if (scanned) return;
    setScanned(true);
    const parsed = parseQr(data);
    if (!parsed) {
      setError('Ese codigo no es valido. Escanea el QR que muestra tu punto de venta.');
      setScanned(false);
      return;
    }
    await savePairing(parsed);
    // Continua al registro/login, ya con el negocio vinculado en memoria
    router.replace('/(auth)/registro');
  }

  if (!permission) {
    return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.msg}>Necesitamos la camara para escanear el codigo de tu negocio.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Permitir camara</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.bg}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : onScan}
      />
      <View style={styles.overlay}>
        <Text style={styles.title}>Escanea el codigo</Text>
        <Text style={styles.sub}>Apunta a la pantalla de tu punto de venta</Text>
        <View style={styles.frame} />
        {error ? <Text style={styles.err}>{error}</Text> : null}
        <TouchableOpacity onPress={() => router.back()} style={styles.cancel}>
          <Text style={styles.cancelText}>Cancelar</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.navyDeep, padding: 28 },
  msg: { fontFamily: fonts.medium, color: '#fff', textAlign: 'center', fontSize: 15, marginBottom: 20, lineHeight: 22 },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', padding: 28 },
  title: { fontFamily: fonts.bold, color: '#fff', fontSize: 20, textShadowColor: '#000', textShadowRadius: 8 },
  sub: { fontFamily: fonts.regular, color: '#e2e8f0', fontSize: 13, marginTop: 6, marginBottom: 24, textShadowColor: '#000', textShadowRadius: 8 },
  frame: { width: 240, height: 240, borderWidth: 3, borderColor: colors.sky, borderRadius: 24, backgroundColor: 'transparent' },
  err: { fontFamily: fonts.medium, color: '#fff', backgroundColor: colors.danger, padding: 10, borderRadius: 10, marginTop: 20, textAlign: 'center', fontSize: 13 },
  cancel: { marginTop: 28 },
  cancelText: { fontFamily: fonts.semibold, color: '#fff', fontSize: 14 },
  btn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 28 },
  btnText: { fontFamily: fonts.bold, color: '#fff', fontSize: 15 }
});