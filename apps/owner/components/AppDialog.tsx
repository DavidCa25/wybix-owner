import { useEffect, useRef } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius } from '../theme/tokens';

export type DialogType = 'success' | 'error' | 'info';

const THEME: Record<DialogType, { color: string; soft: string; icon: keyof typeof Ionicons.glyphMap }> = {
  success: { color: colors.success, soft: 'rgba(52,211,153,0.15)', icon: 'checkmark-circle' },
  error:   { color: colors.danger,  soft: 'rgba(248,113,113,0.15)', icon: 'alert-circle' },
  info:    { color: colors.sky,     soft: colors.skySoft, icon: 'mail-outline' }
};

export interface DialogOptions {
  type?: DialogType;
  title: string;
  message?: string;
  confirmText?: string;
  /** Se llama al cerrar el diálogo (p. ej. para navegar después de leerlo). */
  alCerrar?: () => void;
}

interface Props extends DialogOptions {
  visible: boolean;
  onClose: () => void;
}

export default function AppDialog({ visible, type = 'info', title, message, confirmText = 'Entendido', onClose }: Props) {
  const scale = useRef(new Animated.Value(0.9)).current;
  const op = useRef(new Animated.Value(0)).current;
  const back = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      scale.setValue(0.9); op.setValue(0); back.setValue(0);
      Animated.parallel([
        Animated.timing(back, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 7, tension: 80, useNativeDriver: true }),
        Animated.timing(op, { toValue: 1, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: true })
      ]).start();
    }
  }, [visible]);

  const t = THEME[type];

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.backdrop, { opacity: back }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <Animated.View style={[styles.card, { opacity: op, transform: [{ scale }] }]}>
          {/* Barra de acento superior */}
          <View style={[styles.accent, { backgroundColor: t.color }]} />

          <View style={[styles.iconWrap, { backgroundColor: t.soft }]}>
            <Ionicons name={t.icon} size={32} color={t.color} />
          </View>

          <Text style={styles.title}>{title}</Text>
          {message ? <Text style={styles.msg}>{message}</Text> : null}

          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.btn, { backgroundColor: t.color, opacity: pressed ? 0.88 : 1 }]}
          >
            <Text style={styles.btnText}>{confirmText}</Text>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(11,36,54,0.62)',
    justifyContent: 'center', alignItems: 'center', padding: 28
  },
  card: {
    width: '100%', maxWidth: 360, backgroundColor: colors.card, borderRadius: radius.lg,
    paddingTop: 30, paddingBottom: 22, paddingHorizontal: 24, alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#0B2436', shadowOpacity: 0.35, shadowRadius: 30, shadowOffset: { width: 0, height: 16 }, elevation: 14
  },
  accent: { position: 'absolute', top: 0, left: 0, right: 0, height: 5 },
  iconWrap: { width: 64, height: 64, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  title: { fontFamily: fonts.bold, color: colors.ink, fontSize: 18.5, textAlign: 'center' },
  msg: { fontFamily: fonts.regular, color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 21, marginTop: 8 },
  btn: { alignSelf: 'stretch', borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', marginTop: 22 },
  btnText: { fontFamily: fonts.bold, color: '#fff', fontSize: 15 }
});
