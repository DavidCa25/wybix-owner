import { useEffect, useRef, type ReactNode } from "react";
import {
  View,
  Text,
  ScrollView,
  useWindowDimensions,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Marca, useReducedMotion, pos as t, tipo } from "./ui";
export function Acceso({
  title,
  description,
  children,
  status,
  focusKey,
}: {
  title: string;
  description: string;
  children: ReactNode;
  status?: ReactNode;
  focusKey?: string | null;
}) {
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const compact = width < 680 || fontScale > 1.3;
  const scroll = useRef<ScrollView>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!focusKey || (width >= 800 && fontScale <= 1.3)) return;
    const timer = setTimeout(
      () => scroll.current?.scrollToEnd({ animated: !reduced }),
      80,
    );
    return () => clearTimeout(timer);
  }, [focusKey, width, fontScale, reduced]);
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.fondo }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View
        style={{
          paddingTop: insets.top + 16,
          paddingBottom: 16,
          paddingHorizontal: 24,
          backgroundColor: t.navy,
          flexDirection: compact ? "column" : "row",
          alignItems: compact ? "flex-start" : "center",
          justifyContent: "space-between",
          gap: 20,
        }}
      >
        <Marca />
        {status}
      </View>
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          padding: width >= 800 ? 40 : 20,
          paddingBottom: insets.bottom + 24,
          gap: 28,
          maxWidth: 1120,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View style={{ gap: 8 }}>
          <Text
            accessibilityRole="header"
            style={[tipo.titulo, { fontSize: width >= 800 ? 36 : 28 }]}
          >
            {title}
          </Text>
          <Text style={tipo.cuerpo}>{description}</Text>
        </View>
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
