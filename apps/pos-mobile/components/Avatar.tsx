/**
 * AVATAR de una persona: Blobatar, la misma librería y el mismo dibujo que
 * wx-avatar en la caja de escritorio.
 *
 * La semilla es el uuid de la persona en el evento (`staff:<uuid>`): estable,
 * nunca el nombre (que cambia) ni aleatoria. La misma persona tiene la misma
 * cara en cada pantalla y en cada apertura.
 *
 * El SVG se calcula una vez por semilla y tamaño y se guarda en memoria. Si
 * no se pudiera dibujar, quedan las iniciales sobre un color derivado de la
 * misma semilla: un avatar es decoración útil, no un dato.
 */
import { memo, useMemo } from "react";
import { View, Text } from "react-native";
import { SvgXml } from "react-native-svg";
import { blobatar } from "blobatar";

const CACHE = new Map<string, string | null>();

function dibujo(semilla: string, size: number, fondo: boolean): string | null {
  const clave = `${semilla}|${size}|${fondo ? "f" : "n"}`;
  if (CACHE.has(clave)) return CACHE.get(clave)!;
  let svg: string | null = null;
  try {
    // normalize:false — la semilla ya es un uuid en minúsculas; así no
    // depende de String.prototype.normalize del motor JS.
    svg = blobatar(semilla, { size, background: fondo ? "circle" : false, normalize: false });
  } catch {
    svg = null;
  }
  CACHE.set(clave, svg);
  return svg;
}

function respaldo(semilla: string) {
  let h = 0;
  for (let i = 0; i < semilla.length; i++) h = (h * 31 + semilla.charCodeAt(i)) % 360;
  return `hsl(${h}, 42%, 38%)`;
}

export const Avatar = memo(function Avatar({
  uuid,
  nombre,
  size = 40,
  fondo = true,
}: {
  /** Id estable de la persona (staff.uuid). */
  uuid: string;
  /** Solo para las iniciales del respaldo. */
  nombre: string;
  size?: number;
  /** Disco claro detrás de la figura (apágalo sobre superficies oscuras). */
  fondo?: boolean;
}) {
  const semilla = `staff:${uuid}`;
  const svg = useMemo(() => dibujo(semilla, size, fondo), [semilla, size, fondo]);
  if (svg) return <SvgXml xml={svg} width={size} height={size} accessibilityElementsHidden importantForAccessibility="no" />;
  const ini = nombre.trim().split(/\s+/).filter(Boolean);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: respaldo(semilla), alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ color: "#fff", fontFamily: "WybixSemi", fontSize: size * 0.4 }}>
        {((ini[0]?.[0] ?? "") + (ini.length > 1 ? ini[ini.length - 1][0] : "")).toUpperCase() || "?"}
      </Text>
    </View>
  );
});
