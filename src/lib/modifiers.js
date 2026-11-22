/**
 * Modifier selection rules.
 *
 * Pure functions, deliberately kept out of the component so they can be tested
 * without a DOM. These enforce the POS's min/max rules for the customer's
 * benefit — to stop them reaching checkout with an invalid combination. The
 * server re-validates everything and remains the authority.
 */

/**
 * Pre-select the first available option in every required single-choice group,
 * so a customer is not forced to tap "Small" before they can do anything.
 * Optional groups start empty, and a group with nothing available selects
 * nothing rather than an option that would be refused.
 */
export function defaultSelection(groups) {
  const selection = {};
  for (const group of groups ?? []) {
    if (group.minSelect > 0 && group.maxSelect === 1) {
      const first = group.modifiers.find((m) => m.available);
      selection[group.groupId] = first ? [first.modifierId] : [];
    } else {
      selection[group.groupId] = [];
    }
  }
  return selection;
}

/**
 * Apply a tap on one modifier, returning the new selection.
 *
 * Single-choice groups replace; multi-choice groups toggle up to maxSelect.
 * Tapping the chosen option in a *required* single-choice group keeps it,
 * because clearing it would leave the item unorderable.
 */
export function toggleModifier(selection, group, modifierId) {
  const current = selection[group.groupId] ?? [];
  const isSelected = current.includes(modifierId);

  if (group.maxSelect === 1) {
    if (isSelected) {
      return { ...selection, [group.groupId]: group.minSelect > 0 ? current : [] };
    }
    return { ...selection, [group.groupId]: [modifierId] };
  }

  if (isSelected) {
    return { ...selection, [group.groupId]: current.filter((id) => id !== modifierId) };
  }
  if (current.length >= group.maxSelect) return selection; // already at the limit
  return { ...selection, [group.groupId]: [...current, modifierId] };
}

/** Required groups that are still unanswered. */
export function unmetGroups(selection, groups) {
  return (groups ?? []).filter((g) => (selection[g.groupId]?.length ?? 0) < g.minSelect);
}

/** Unit price: base plus every selected delta, never below zero. */
export function unitPriceMinor(product, selectedModifiers) {
  const delta = selectedModifiers.reduce((sum, m) => sum + (m.priceDeltaMinor ?? 0), 0);
  return Math.max(0, product.priceMinor + delta);
}
