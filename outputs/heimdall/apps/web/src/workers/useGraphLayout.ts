import { useEffect, useState } from "react";
import { layoutGraph, type LayoutInput } from "./layout";
export function useGraphLayout(input: LayoutInput) {
  const key = JSON.stringify(input);
  const [result, setResult] = useState<{
    key: string;
    layout: ReturnType<typeof layoutGraph>;
    fallback: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true,
      worker: Worker | undefined;
    const fallback = () => {
      if (active)
        setResult({ key, layout: layoutGraph(input), fallback: true });
    };
    try {
      worker = new Worker(new URL("./layout.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event) => {
        if (active) setResult({ key, layout: event.data, fallback: false });
      };
      worker.onerror = () => {
        worker?.terminate();
        fallback();
      };
      worker.postMessage(input);
    } catch {
      fallback();
    }
    return () => {
      active = false;
      worker?.terminate();
    };
  }, [key]);
  return result?.key === key ? result : null;
}
