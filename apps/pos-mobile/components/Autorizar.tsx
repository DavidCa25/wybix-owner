/**
 * AUTORIZACIÓN LOCAL: una acción restringida la desbloquea un encargado DE
 * ESTE EVENTO con su PIN, sin Internet. Queda en la auditoría local.
 *
 * FASE 3 · A DISTANCIA (opcional, solo con red): si no hay encargado, la
 * tablet pide permiso a la dueña, que lo aprueba en Owner con su segundo
 * factor. La nube liga la aprobación a ESTA tablet y a ESTE payload, y se
 * consume una sola vez. El camino local con PIN no cambia.
 */
import { useEffect, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { identificar, personal, type Persona } from "@wybix/database";
import { puede, type Accion, type RolEvento } from "@wybix/domain";
import {
  Sheet,
  Boton,
  Teclado,
  Puntos,
  teclear,
  Aviso,
  pos as t,
  tipo,
} from "./ui";
import { usePos } from "../lib/contexto";

export function Autorizar({
  visible,
  accion,
  motivo,
  alAutorizar,
  alCancelar,
  payload,
}: {
  visible: boolean;
  accion: Accion;
  motivo: string;
  alAutorizar: (p: Persona) => void;
  alCancelar: () => void;
  /** Lo que se va a ejecutar, tal cual lo verá quien aprueba. Sin payload no hay opción a distancia. */
  payload?: Record<string, unknown>;
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const { db, persona, sync, aprobaciones } = usePos();
  const [remota, setRemota] = useState<{ id: string; status: string; vence?: string; nota?: string | null; error?: string; payload?: Record<string, unknown> } | null>(null);
  const autorizado = useRef(alAutorizar);
  autorizado.current = alAutorizar;
  const [lista, setLista] = useState<
    Array<{ uuid: string; name: string; role: RolEvento }>
  >([]);
  const [elegido, setElegido] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible || !db) return;
    personal(db).then((l) => setLista(l.filter((x) => puede(x.role, accion))));
    setPin("");
    setError(null);
    setElegido(null);
    setRemota(null);
  }, [visible, db, accion]);

  // Mientras espera respuesta, pregunta cada 3 s. Al aprobarse, la consume (una vez) y sigue.
  useEffect(() => {
    if (!visible || !remota || remota.status !== "PENDING" || !remota.payload) return;
    let vivo = true;
    let timer: ReturnType<typeof setTimeout>;
    const consultar = async () => {
      try {
        const e = await aprobaciones.estado(remota.id);
        if (!vivo) return;
        if (e.status === "APPROVED") {
          if (lock.current) { timer = setTimeout(consultar, 3000); return; }
          lock.current = true;
          setBusy(true);
          try {
            const c = await aprobaciones.consumir(remota.id, remota.payload!);
            if (!vivo) return;
            autorizado.current({ uuid: remota.id, name: `${c.approver?.name ?? c.decided_name ?? "Dueña"} (a distancia)`, role: "ADMIN", remota: true });
          } finally {
            lock.current = false;
            if (vivo) setBusy(false);
          }
          return;
        } else if (e.status !== "PENDING") {
          setRemota(r => r && ({ ...r, status: e.status, nota: e.decision_note }));
          return;
        }
      } catch (x) {
        if (vivo) setRemota(r => r && ({ ...r, error: (x as Error).message }));
      }
      if (vivo) timer = setTimeout(consultar, 3000);
    };
    timer = setTimeout(consultar, 3000);
    return () => { vivo = false; clearTimeout(timer); };
  }, [visible, remota?.id, remota?.status, aprobaciones]);

  const pedirRemota = async () => {
    if (!persona || !payload || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const id = Crypto.randomUUID();
      const r = await aprobaciones.solicitar({ id, accion, solicita: { uuid: persona.uuid, name: persona.name, role: persona.role }, payload });
      setRemota({ id, status: r.status, vence: r.expires_at, payload: JSON.parse(JSON.stringify(payload)) });
    } catch (x) {
      setRemota({ id: "", status: "ERROR", error: (x as Error).message });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const cancelar = async () => {
    if (lock.current) return;
    if (remota?.id && remota.status === "PENDING") await aprobaciones.cancelar(remota.id).catch(() => undefined);
    alCancelar();
  };
  const confirmar = async () => {
    if (!db || !elegido || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const r = await identificar(db, elegido, pin);
      setPin("");
      if (r.ok) alAutorizar(r.persona);
      else setError(r.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Sheet
      visible={visible}
      onClose={cancelar}
      busy={busy}
      title="Autorización de encargado"
      subtitle={motivo}
      footer={
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Boton
            titulo="Cancelar"
            variante="secundario"
            deshabilitado={busy}
            onPress={cancelar}
            estilo={{ flex: 1 }}
          />
          <Boton
            titulo="Autorizar"
            textoCargando="Verificando…"
            cargando={busy}
            onPress={confirmar}
            deshabilitado={!elegido || pin.length < 4}
            estilo={{ flex: 1 }}
          />
        </View>
      }
    >
      <View style={s.lista}>
        {lista.map((p) => (
          <Pressable
            key={p.uuid}
            accessibilityRole="radio"
            disabled={busy}
            accessibilityState={{ checked: elegido === p.uuid, disabled: busy }}
            onPress={() => {
              setElegido(p.uuid);
              setError(null);
            }}
            style={[
              s.chip,
              elegido === p.uuid && { backgroundColor: t.acento },
            ]}
          >
            <Text
              style={[
                tipo.cuerpo,
                elegido === p.uuid && { color: t.acentoTexto },
              ]}
            >
              {p.name}
            </Text>
          </Pressable>
        ))}
        {!lista.length && (
          <Aviso texto="No hay encargados asignados a este evento." />
        )}
      </View>
      {elegido && (
        <>
          <Puntos n={pin.length} />
          <Teclado
            disabled={busy}
            extra={null}
            alPulsar={(k) => setPin((v) => teclear(v, k, 8))}
          />
        </>
      )}
      {error && <Aviso tono="peligro" texto={error} />}
      {payload && !remota && (
        <Boton
          titulo="No hay encargado: pedir autorización a la dueña"
          variante="secundario"
          deshabilitado={busy || !sync.en_linea}
          onPress={pedirRemota}
        />
      )}
      {payload && !remota && !sync.en_linea && (
        <Aviso texto="Sin Internet no se puede pedir a distancia. Usa el PIN de un encargado." />
      )}
      {remota?.status === "PENDING" && !remota.error && (
        <Aviso texto={`Esperando la respuesta de la dueña${remota.vence ? ` (vence a las ${new Date(remota.vence).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })})` : ""}…`} />
      )}
      {remota && ["REJECTED", "EXPIRED", "CANCELLED"].includes(remota.status) && (
        <Aviso tono="peligro" texto={remota.status === "REJECTED" ? `La dueña no lo autorizó${remota.nota ? `: ${remota.nota}` : "."}` : "La solicitud venció. Puedes pedirla otra vez."} />
      )}
      {remota?.error && <Aviso tono="peligro" texto={`No se pudo pedir a distancia: ${remota.error}`} />}
      {remota && (remota.error || ["REJECTED", "EXPIRED", "CANCELLED"].includes(remota.status)) && (
        <Boton titulo="Pedir otra vez" variante="secundario" deshabilitado={busy || !sync.en_linea} onPress={() => setRemota(null)} />
      )}
    </Sheet>
  );
}

const s = StyleSheet.create({
  lista: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  chip: {
    backgroundColor: t.hundido,
    borderRadius: 999,
    paddingHorizontal: 16,
    minHeight: 48,
    justifyContent: "center",
  },
});
