export interface TextChunk {
  ordinal: number;
  text: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
}

export const DEFAULT_CHUNK_SIZE = 800;

/**
 * Split text into chunks of roughly `size` characters, always breaking at line
 * boundaries. A single line longer than `size` becomes its own chunk.
 * Whitespace-only chunks are dropped (line numbers stay accurate).
 */
export function chunkText(text: string, size: number = DEFAULT_CHUNK_SIZE): TextChunk[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const chunks: TextChunk[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let start = 1;
  const flush = (endLine: number) => {
    const body = buf.join("\n");
    if (body.trim() !== "") {
      chunks.push({ ordinal: chunks.length, text: body, startLine: start, endLine });
    }
    buf = [];
    bufLen = 0;
  };
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const added = buf.length === 0 ? line.length : bufLen + 1 + line.length;
    if (buf.length > 0 && added > size) {
      flush(lineNo - 1);
    }
    if (buf.length === 0) start = lineNo;
    bufLen = buf.length === 0 ? line.length : bufLen + 1 + line.length;
    buf.push(line);
  });
  if (buf.length > 0) flush(lines.length);
  return chunks;
}
