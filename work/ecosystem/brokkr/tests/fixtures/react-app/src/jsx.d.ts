// Minimal JSX typing so the fixture type-checks without installing React.
declare namespace JSX {
  type Element = { type: unknown; props: unknown };
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
}
