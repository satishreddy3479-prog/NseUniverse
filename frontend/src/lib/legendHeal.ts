/**
 * A saved view must never open a chart with every graph switched off. A view saved before graphs could be switched ON lists the others as off and says nothing about one that starts
 * off (like "PE − CE per candle (right)"), so it came back blank. ``names`` are all the legend entries of the chart, ``defaults`` their starting states, ``off`` and ``on`` what the
 * saved view says. Returns the entries to switch on: none when something is already shown, else those the view did not switch off (all of them if it switched every one off).
 */
export function legendToShow(names: readonly string[], defaults: Readonly<Record<string, boolean>>, off: readonly string[], on: readonly string[] = []): string[] {
  if (names.length === 0) return [];
  const shown = names.filter((n) => !off.includes(n) && (defaults[n] !== false || on.includes(n)));
  if (shown.length > 0) return [];
  const rest = names.filter((n) => !off.includes(n));
  return rest.length ? rest : [...names];
}
