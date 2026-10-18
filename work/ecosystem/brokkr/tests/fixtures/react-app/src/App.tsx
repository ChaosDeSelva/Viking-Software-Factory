export interface AppProps {
  title: string;
  items: readonly string[];
}

export function App({ title, items }: AppProps): JSX.Element {
  return (
    <main>
      <h1>{title}</h1>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </main>
  );
}

export function countLabel(n: number): string {
  return n === 1 ? "1 item" : `${n} items`;
}
