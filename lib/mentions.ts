// @-mentions in task threads: "@Karam El Assaad" or "@Analyst". Names can
// have spaces, so mentions are matched against the people and agents who
// could be meant, longest names first.

export type Mentionable = { id: string; name: string };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ids of everyone mentioned in the text, in the order they appear. */
export function findMentions<T extends Mentionable>(text: string, candidates: T[]): T[] {
  let rest = text;
  const found: { at: number; who: T }[] = [];
  for (const who of [...candidates].sort((a, b) => b.name.length - a.name.length)) {
    if (!who.name.trim()) continue;
    const pattern = new RegExp(`@${escape(who.name.trim())}(?![\\w])`, "i");
    const match = pattern.exec(rest);
    if (!match) continue;
    found.push({ at: match.index, who });
    // Blank it out so a shorter name inside it doesn't match too.
    rest = rest.slice(0, match.index) + " ".repeat(match[0].length) + rest.slice(match.index + match[0].length);
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.who);
}

/** Marks mentions for display: "@Name" becomes a "#mention" link the thread styles. */
export function linkMentions(text: string, names: string[]): string {
  let out = text;
  for (const name of [...new Set(names)].filter((n) => n.trim()).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(^|[^\\w\\[])@(${escape(name.trim())})(?![\\w])`, "gi"), (_, before, matched) => `${before}[@${matched}](#mention)`);
  }
  return out;
}
