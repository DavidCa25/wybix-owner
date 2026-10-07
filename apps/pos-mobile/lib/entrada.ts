/** Keypad editing keeps money parseable; PINs retain leading zeroes. */
export function teclear(value: string, key: string, max = 10): string {
  if (key === "⌫") return value.slice(0, -1);
  if (key === "." && value.includes(".")) return value;
  if (
    value.length >= max ||
    (value.includes(".") && key !== "." && value.split(".")[1].length >= 2)
  )
    return value;
  return key === "." && !value ? "0." : value + key;
}
