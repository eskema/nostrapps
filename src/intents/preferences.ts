// Adapted from napplet-frame: ordered public/private handler chain editing.
import { handlerPointer, type HandlerPreference } from './catalog.js';

export interface HandlerEntry { reference: string; hidden: boolean }
export type HandlerEdit = {
  action: 'add' | 'remove' | 'prefer' | 'visibility' | 'reset' | 'clear';
  identity?: string;
  reference?: string;
  hidden?: boolean;
};

const targets = (tag: string[], identity?: string) => identity ? tag[0] === 'i' && tag[1] === identity : tag[0] === 'a' || tag[0] === 'e';
const referenceOf = (tag: string[]) => tag[tag[0] === 'i' ? 2 : 1];

export function handlerEntries(preference?: HandlerPreference, identity?: string): HandlerEntry[] {
  const seen = new Set<string>();
  return [true, false].flatMap(hidden =>
    ((hidden ? preference?.privateTags : preference?.event.tags) ?? []).filter(tag => targets(tag, identity)).flatMap(tag => {
      const reference = referenceOf(tag);
      const pointer = reference && handlerPointer(reference);
      if (!pointer || tag[0] === 'a' && 'id' in pointer || tag[0] === 'e' && !('id' in pointer) || seen.has(reference!)) return [];
      seen.add(reference);
      return [{ reference, hidden }];
    }));
}

/** Edit just one chain, retaining unrelated intents, relay hints and extension tags. */
export function editHandlerTags(publicTags: string[][], privateTags: string[][], edit: HandlerEdit): [string[][], string[][]] {
  const groups: [string[][], string[][]] = [publicTags.map(tag => [...tag]), privateTags.map(tag => [...tag])];
  if (edit.action === 'clear' || edit.action === 'reset') {
    const retain = (tag: string[]) => edit.action === 'clear'
      ? !['a', 'e', 'i'].includes(tag[0]!) : !targets(tag, edit.identity);
    return [groups[0].filter(retain), groups[1].filter(retain)];
  }
  if (!edit.reference || !handlerPointer(edit.reference)) throw new Error('Invalid handler reference.');
  const matching = (tag: string[]) => targets(tag, edit.identity) && referenceOf(tag) === edit.reference;
  const previous = groups.flat().find(matching);
  const entry = previous ?? (edit.identity ? ['i', edit.identity, edit.reference]
    : [edit.reference.includes(':') ? 'a' : 'e', edit.reference]);
  if (edit.action === 'add' && previous) return groups;
  for (let index = 0; index < groups.length; index++) groups[index] = groups[index]!.filter(tag => !matching(tag));
  if (edit.action !== 'remove') {
    const tags = groups[edit.hidden ? 1 : 0]!;
    if (edit.action === 'prefer') {
      const index = tags.findIndex(tag => targets(tag, edit.identity));
      tags.splice(index < 0 ? tags.length : index, 0, entry);
    } else tags.push(entry);
  }
  return groups;
}
