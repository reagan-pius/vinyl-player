/** Hand-drawn 24px transport glyphs — stroke inherits currentColor. */
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function IconPlay() {
  return (<svg width="20" height="20" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" /></svg>);
}
export function IconPause() {
  return (<svg width="20" height="20" viewBox="0 0 24 24"><path d="M8.5 5.5h2.6v13H8.5zM13.4 5.5H16v13h-2.6z" fill="currentColor" stroke="none" /></svg>);
}
export function IconStop() {
  return (<svg width="16" height="16" viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" /></svg>);
}
export function IconPrev() {
  return (<svg width="18" height="18" viewBox="0 0 24 24"><path {...S} d="M18.5 6.5v11L10 12z" fill="currentColor" /><path {...S} d="M6.5 6v12" /></svg>);
}
export function IconNext() {
  return (<svg width="18" height="18" viewBox="0 0 24 24"><path {...S} d="M5.5 6.5v11L14 12z" fill="currentColor" /><path {...S} d="M17.5 6v12" /></svg>);
}
