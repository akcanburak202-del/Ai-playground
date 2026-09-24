import type { WeaponCategory, WeaponSpec } from '../app/contracts.ts';

/**
 * Weapon slots: the arsenal grouped by category in rising order of effect, one number key per
 * group; pressing a group's key again steps through the weapons in it. Shared by the input
 * handler and the HUD's weapon strip. Pure.
 */

export const CATEGORY_ORDER: readonly WeaponCategory[] = ['rifle', 'mg', 'sniper', 'launcher', 'cannon', 'artillery', 'airstrike', 'demolition'];

export interface Slot {
  /** Number key, 1…9 */
  key: number;
  category: WeaponCategory;
  weapons: readonly WeaponSpec[];
}

export function buildSlots(weapons: readonly WeaponSpec[]): Slot[] {
  const cats = [...CATEGORY_ORDER, ...new Set(weapons.map((w) => w.category).filter((c) => !CATEGORY_ORDER.includes(c)))];
  const slots: Slot[] = [];
  for (const category of cats) {
    const ws = weapons.filter((w) => w.category === category);
    if (ws.length && slots.length < 9) slots.push({ key: slots.length + 1, category, weapons: ws });
  }
  return slots;
}

/** Weapon to select for number key `key`: the next one in that slot if the current weapon is in it, else the first. */
export function weaponForKey(slots: readonly Slot[], key: number, currentId: string): string | null {
  const slot = slots.find((s) => s.key === key);
  if (!slot) return null;
  const i = slot.weapons.findIndex((w) => w.id === currentId);
  return slot.weapons[i < 0 ? 0 : (i + 1) % slot.weapons.length]!.id;
}

/** Step through all weapons in slot order (mouse wheel). */
export function stepWeapon(slots: readonly Slot[], currentId: string, dir: 1 | -1): string | null {
  const flat = slots.flatMap((s) => s.weapons);
  if (!flat.length) return null;
  const i = flat.findIndex((w) => w.id === currentId);
  const n = flat.length;
  return flat[(((i < 0 ? 0 : i + dir) % n) + n) % n]!.id;
}

export function slotOf(slots: readonly Slot[], weaponId: string): Slot | undefined {
  return slots.find((s) => s.weapons.some((w) => w.id === weaponId));
}
