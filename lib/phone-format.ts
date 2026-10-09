/** A phone number as people write it: +44 7403 932000 for UK numbers, otherwise as given. Digits alone get a +. */
export function formatPhone(number: string): string {
  const raw = number.replace(/^whatsapp:/, "").replace(/[^\d+]/g, "");
  const full = raw.startsWith("+") ? raw : `+${raw}`;
  const uk = full.match(/^\+44(\d{4})(\d{6})$/);
  return uk ? `+44 ${uk[1]} ${uk[2]}` : full;
}
