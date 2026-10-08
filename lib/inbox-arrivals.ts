// Which inbox items to tell someone about: ones that are new to their inbox,
// or that came back with something new (another question, a new result).

export type InboxItem = { id: string; number: number; title: string; summary: string; status: string; updatedAt: string };

export function arrivals(before: Map<string, InboxItem>, now: InboxItem[]): InboxItem[] {
  return now.filter((item) => {
    const previous = before.get(item.id);
    return !previous || (previous.updatedAt !== item.updatedAt && (previous.status !== item.status || previous.summary !== item.summary));
  });
}
