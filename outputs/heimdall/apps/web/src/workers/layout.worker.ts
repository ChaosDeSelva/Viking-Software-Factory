import { layoutGraph, type LayoutInput } from "./layout";
self.onmessage = (event: MessageEvent<LayoutInput>) =>
  self.postMessage(layoutGraph(event.data));
